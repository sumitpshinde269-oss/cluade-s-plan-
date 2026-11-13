"""Visual embedding of a pothole crop and cosine similarity.

Embedding = HOG of a contrast-normalised 64x64 grayscale crop. Chosen because it
needs no extra weights and is largely invariant to brightness/contrast shifts and
mild blur. NOT validated for cross-viewpoint matching on real field data; the
decision thresholds live in settings and must be calibrated (see TESTING_REPORT).
"""
from __future__ import annotations

from typing import List

import cv2
import numpy as np

_HOG = cv2.HOGDescriptor((64, 64), (16, 16), (8, 8), (8, 8), 9)
MIN_CROP_PX = 8


def context_crop(rgb: np.ndarray, bbox, k: float = 3.0) -> np.ndarray:
    """Crop the box enlarged k times around its centre (clamped). Measured on real video
    pairs: 3x context separated same-track from different-track crops better than a tight crop."""
    x1, y1, x2, y2 = bbox
    cx, cy, w, h = (x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) * k, (y2 - y1) * k
    H, W = rgb.shape[:2]
    return rgb[max(0, int(cy - h / 2)) : min(H, int(cy + h / 2)), max(0, int(cx - w / 2)) : min(W, int(cx + w / 2))]


def embed_crop(rgb_crop: np.ndarray) -> List[float]:
    """rgb_crop: HxWx3 uint8. Returns an L2-normalised vector (list for JSON storage)."""
    if rgb_crop is None or rgb_crop.ndim != 3 or min(rgb_crop.shape[:2]) < MIN_CROP_PX:
        raise ValueError("crop too small to embed")
    gray = cv2.cvtColor(rgb_crop, cv2.COLOR_RGB2GRAY)
    gray = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(gray)
    vec = _HOG.compute(gray).ravel().astype(np.float32)
    vec -= vec.mean()  # centre so unrelated textures score near 0, not ~0.5
    n = float(np.linalg.norm(vec))
    return (vec / n).tolist() if n > 0 else vec.tolist()


def cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    va, vb = np.asarray(a, np.float32), np.asarray(b, np.float32)
    d = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(np.dot(va, vb) / d) if d > 0 else 0.0
