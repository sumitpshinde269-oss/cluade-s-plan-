"""Duplicate pothole identification: candidate search + MATCH / NO MATCH / UNCERTAIN decision.

Geography alone never merges: a MATCH needs a visual similarity above VISUAL_MATCH_MIN.
Rules (in order):
  no existing pothole inside the accuracy-aware radius                 -> NEW
  best candidate visual >= VISUAL_MATCH_MIN and not ambiguous           -> MATCH
  every nearby candidate visual < VISUAL_REJECT_BELOW (all comparable)  -> NEW
  anything else (middle band, missing embedding, ambiguous twins)       -> UNCERTAIN
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.pitscout import DetectionResult, Location, Pothole, PotholeReport
from app.services.geo import bounding_box, haversine_m
from app.services.similarity import cosine

MATCH, NEW, UNCERTAIN = "match", "new", "uncertain"
AMBIGUITY_MARGIN = 0.05


def _score(c: Dict[str, Any]) -> float:
    geo = max(0.0, 1.0 - c["distance_m"] / c["radius_m"])
    return round(0.6 * (c["visual_sim"] or 0.0) + 0.3 * geo + 0.1 * c["size_ratio"], 4)


def decide(candidates: List[Dict[str, Any]]) -> Tuple[str, Dict[str, Any]]:
    """Pure decision over candidates already inside their radius. Returns (outcome, meta)."""
    ranked = sorted(({**c, "score": _score(c)} for c in candidates), key=lambda c: c["score"], reverse=True)
    meta: Dict[str, Any] = {"candidates": ranked, "thresholds": {
        "visual_match_min": settings.VISUAL_MATCH_MIN, "visual_reject_below": settings.VISUAL_REJECT_BELOW}}
    if not ranked:
        return NEW, {**meta, "reason": "no existing pothole within the matching radius"}
    comparable = [c for c in ranked if c["visual_sim"] is not None]
    if len(comparable) < len(ranked):
        return UNCERTAIN, {**meta, "reason": "a nearby pothole has no comparable visual evidence"}
    matches = [c for c in comparable if c["visual_sim"] >= settings.VISUAL_MATCH_MIN]
    if matches:
        if len(matches) > 1 and matches[0]["score"] - matches[1]["score"] < AMBIGUITY_MARGIN:
            return UNCERTAIN, {**meta, "reason": "multiple nearby potholes match equally well"}
        return MATCH, {**meta, "pothole_id": matches[0]["pothole_id"],
                       "reason": "close by and visually similar to an existing pothole"}
    if all(c["visual_sim"] < settings.VISUAL_REJECT_BELOW for c in comparable):
        return NEW, {**meta, "reason": "nearby potholes exist but none is visually similar"}
    return UNCERTAIN, {**meta, "reason": "nearby and partially similar; needs human verification"}


def find_candidates(
    db: Session, lat: float, lon: float, accuracy_m: Optional[float],
    embedding: Optional[List[float]], area_ratio: float, exclude_ids: Set[str],
) -> List[Dict[str, Any]]:
    new_acc = accuracy_m if accuracy_m is not None else settings.UNKNOWN_ACCURACY_M
    box = bounding_box(lat, lon, settings.MATCH_MAX_RADIUS_M)
    near = db.query(Pothole).filter(
        Pothole.lat.between(box["lat_min"], box["lat_max"]),
        Pothole.lon.between(box["lon_min"], box["lon_max"]),
        Pothole.lifecycle_status != "rejected",
    ).all()
    out = []
    for p in near:
        if p.id in exclude_ids:  # same-report detections are different potholes by definition
            continue
        # best known fix quality for that pothole across all its reports
        cand_acc = (
            db.query(func.min(Location.accuracy_m))
            .join(PotholeReport, PotholeReport.id == Location.report_id)
            .join(DetectionResult, DetectionResult.report_id == PotholeReport.id)
            .filter(DetectionResult.pothole_id == p.id)
            .scalar()
        )
        cand_acc = cand_acc if cand_acc is not None else settings.UNKNOWN_ACCURACY_M
        radius = min(settings.MATCH_MAX_RADIUS_M, settings.MATCH_BASE_RADIUS_M + new_acc + cand_acc)
        dist = haversine_m(lat, lon, p.lat, p.lon)
        if dist > radius:
            continue
        embs = [d.embedding for d in p.detections if d.embedding]
        sim = max((cosine(embedding, e) for e in embs), default=None) if embedding else None
        areas = [d.area_ratio for d in p.detections if d.area_ratio]
        ratio = (min(area_ratio, max(areas)) / max(area_ratio, max(areas))) if areas and area_ratio else 0.0
        out.append({"pothole_id": p.id, "distance_m": round(dist, 2), "radius_m": round(radius, 2),
                    "visual_sim": None if sim is None else round(sim, 4), "size_ratio": round(ratio, 4)})
    return out
