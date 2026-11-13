"""Small IoU + constant-velocity tracker with Hungarian assignment.

Chosen over ultralytics ByteTrack because frames are *sampled* (large, irregular
motion between steps) and detections already pass the project's own filter, so we
only need temporal association, not a second detector. shortcut: single class,
no appearance model, so two potholes that overlap in the image for several
sampled frames can swap ids; upgrade to ByteTrack/BoT-SORT if that shows up.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Sequence

import numpy as np
from scipy.optimize import linear_sum_assignment


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _norm_dist(a: Sequence[float], b: Sequence[float]) -> float:
    dx = (a[0] + a[2] - b[0] - b[2]) / 2
    dy = (a[1] + a[3] - b[1] - b[3]) / 2
    side = max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1], 1.0)
    return float((dx * dx + dy * dy) ** 0.5 / side)


@dataclass
class Track:
    id: int
    box: List[float]
    velocity: List[float] = field(default_factory=lambda: [0.0] * 4)
    hits: int = 1
    misses: int = 0
    history: list = field(default_factory=list)  # per-frame observations, appended by caller

    def predicted(self) -> List[float]:
        return [b + v for b, v in zip(self.box, self.velocity)]


class IoUTracker:
    def __init__(self, iou_threshold: float = 0.1, max_age: int = 3, max_dist: float = 2.0):
        # max_dist: allowed centre distance in units of the larger box side. Needed because
        # small boxes move farther than their own size between sampled frames (IoU == 0).
        self.iou_threshold, self.max_age, self.max_dist = iou_threshold, max_age, max_dist
        self.tracks: List[Track] = []  # active tracks
        self.finished: List[Track] = []
        self._next_id = 1

    def update(self, boxes: List[Sequence[float]]) -> List[Track]:
        """Associate this step's boxes; returns the track matched to each box (same order)."""
        assigned: List[Track | None] = [None] * len(boxes)
        if self.tracks and boxes:
            ious = np.array([[iou(t.predicted(), b) for b in boxes] for t in self.tracks])
            dists = np.array([[_norm_dist(t.predicted(), b) for b in boxes] for t in self.tracks])
            cost = dists - ious  # lower is better; IoU breaks ties between near candidates
            rows, cols = linear_sum_assignment(cost)
            for r, c in zip(rows, cols):
                if ious[r, c] < self.iou_threshold and dists[r, c] > self.max_dist:
                    continue
                t = self.tracks[r]
                nb = list(boxes[c])
                t.velocity = [n - o for n, o in zip(nb, t.box)]
                t.box, t.hits, t.misses = nb, t.hits + 1, 0
                assigned[c] = t
        matched = {id(t) for t in assigned if t}
        for t in self.tracks:
            if id(t) not in matched:
                t.misses += 1
        for i, b in enumerate(boxes):
            if assigned[i] is None:
                t = Track(self._next_id, list(b))
                self._next_id += 1
                self.tracks.append(t)
                assigned[i] = t
        alive = []
        for t in self.tracks:
            (alive if t.misses <= self.max_age else self.finished).append(t)
        self.tracks = alive
        return assigned  # type: ignore[return-value]

    def all_tracks(self) -> List[Track]:
        return sorted(self.finished + self.tracks, key=lambda t: t.id)
