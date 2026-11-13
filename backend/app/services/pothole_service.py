"""Create pothole reports and resolve each detection to a canonical Pothole.

All write paths run in one serialized transaction: the candidate search, the decision and the
insert happen while holding the DB write lock, so two simultaneous reports of the same pothole
cannot both decide NEW (the second one re-reads the first one's committed pothole).
"""
from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.pitscout import (LIFECYCLE, DetectionResult, EvidenceFile, Location, Pothole,
                                 PotholeReport, StatusHistory)
from app.services.duplicate_service import MATCH, NEW, decide, find_candidates
from app.services.geo import validate_location

logger = logging.getLogger("pitscout.reports")


class Conflict(Exception):
    """Raised when the requested transition is not valid for the current state (HTTP 409)."""


class NotFound(Exception):
    pass


def _lock_for_write(db: Session) -> None:
    dialect = db.get_bind().dialect.name
    if dialect == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))  # takes the single write lock before we read candidates
    elif dialect == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(727274)"))  # shortcut: one global lock; shard by geo-cell at scale


def _save_evidence(report_id: str, data: bytes, ext: str, written: List[Path]) -> tuple[str, str]:
    rel = f"{report_id}/{hashlib.sha256(data).hexdigest()[:16]}{ext}"
    path = settings.EVIDENCE_DIR / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    written.append(path)
    return rel, hashlib.sha256(data).hexdigest()


def _resolve(db: Session, det: DetectionResult, loc: Optional[Location], linked: Set[str]) -> None:
    if loc is None:
        det.match_status = "pending_location"
        det.pothole_id = None
        return
    cands = find_candidates(db, loc.lat, loc.lon, loc.accuracy_m, det.embedding, det.area_ratio, linked)
    outcome, meta = decide(cands)
    det.match_meta = meta
    if outcome == MATCH:
        p = db.get(Pothole, meta["pothole_id"])
        if p.id not in linked:
            p.report_count += 1
        p.best_confidence = max(p.best_confidence, det.confidence)
        det.pothole_id, det.match_status = p.id, "matched"
        linked.add(p.id)
    elif outcome == NEW:
        p = Pothole(lat=loc.lat, lon=loc.lon, best_confidence=det.confidence)
        db.add(p)
        db.flush()
        db.add(StatusHistory(pothole_id=p.id, from_status=None, to_status="reported",
                             note=f"created from report {det.report_id}", actor="system"))
        det.pothole_id, det.match_status = p.id, "new"
        linked.add(p.id)
    else:
        det.pothole_id, det.match_status = None, "uncertain"


def create_report(
    db: Session, *, source: str, candidates: List[Dict[str, Any]], evidence: List[Dict[str, Any]],
    location: Optional[Dict[str, Any]], reporter_id: Optional[str] = None,
    idempotency_key: Optional[str] = None, video_job_id: Optional[str] = None,
    original_filename: Optional[str] = None,
) -> tuple[PotholeReport, bool]:
    """candidates: [{bbox, confidence, embedding, image_width, image_height, evidence_idx, frame_index?,
    timestamp_s?, track_id?}]; evidence: [{kind, data(bytes), ext}]. Returns (report, created)."""
    loc_in = validate_location(**location) if location else None  # ValueError -> 422 at the route
    written: List[Path] = []
    try:
        _lock_for_write(db)
        if idempotency_key:
            existing = db.query(PotholeReport).filter_by(idempotency_key=idempotency_key).first()
            if existing:
                db.rollback()
                return existing, False
        report = PotholeReport(
            source=source, reporter_id=reporter_id, idempotency_key=idempotency_key,
            video_job_id=video_job_id, original_filename=original_filename,
            status="processed" if candidates else "no_potholes",
            location_status="pending" if not loc_in else ("verified" if loc_in["verified"] else "unverified"),
        )
        db.add(report)
        db.flush()
        loc = None
        if loc_in:
            loc = Location(report_id=report.id, lat=loc_in["lat"], lon=loc_in["lon"],
                           accuracy_m=loc_in["accuracy_m"], source=loc_in["source"], verified=loc_in["verified"])
            db.add(loc)
        ev_rows = []
        if candidates:  # evidence is only kept when something was detected
            for e in evidence:
                rel, sha = _save_evidence(report.id, e["data"], e["ext"], written)
                row = EvidenceFile(report_id=report.id, kind=e["kind"], path=rel, sha256=sha)
                db.add(row)
                ev_rows.append(row)
            db.flush()
        linked: Set[str] = set()
        for c in candidates:
            det = DetectionResult(
                report_id=report.id, evidence_id=ev_rows[c["evidence_idx"]].id, confidence=c["confidence"],
                bbox=c["bbox"], image_width=c["image_width"], image_height=c["image_height"],
                area_ratio=c["area_ratio"], embedding=c.get("embedding"), frame_index=c.get("frame_index"),
                timestamp_s=c.get("timestamp_s"), track_id=c.get("track_id"), match_status="pending_location")
            db.add(det)
            db.flush()
            _resolve(db, det, loc, linked)
        db.commit()
        return report, True
    except Exception:
        db.rollback()
        for p in written:
            p.unlink(missing_ok=True)
        if written:
            shutil.rmtree(written[0].parent, ignore_errors=True)
        raise


def add_location(db: Session, report_id: str, location: Dict[str, Any]) -> PotholeReport:
    """Supply the location for a report that was submitted without one, then resolve its detections."""
    loc_in = validate_location(**location)
    try:
        _lock_for_write(db)
        report = db.get(PotholeReport, report_id)
        if report is None:
            raise NotFound("report not found")
        if report.location_status != "pending":
            raise Conflict("report already has a location")
        loc = Location(report_id=report.id, lat=loc_in["lat"], lon=loc_in["lon"],
                       accuracy_m=loc_in["accuracy_m"], source=loc_in["source"], verified=loc_in["verified"])
        db.add(loc)
        report.location_status = "verified" if loc_in["verified"] else "unverified"
        linked: Set[str] = set()
        for det in report.detections:
            _resolve(db, det, loc, linked)
        db.commit()
        return report
    except Exception:
        db.rollback()
        raise


def resolve_uncertain(db: Session, detection_id: str, pothole_id: Optional[str], actor: str) -> DetectionResult:
    """Human decision on an UNCERTAIN detection: link to an existing pothole, or create a new one."""
    try:
        _lock_for_write(db)
        det = db.get(DetectionResult, detection_id)
        if det is None:
            raise NotFound("detection not found")
        if det.match_status != "uncertain":
            raise Conflict("only uncertain detections can be resolved")
        meta = dict(det.match_meta or {})
        meta["resolved_by"] = actor
        if pothole_id:
            p = db.get(Pothole, pothole_id)
            if p is None:
                raise NotFound("pothole not found")
            if not any(c["pothole_id"] == pothole_id for c in meta.get("candidates", [])):
                raise Conflict("pothole is not a candidate for this detection")
            p.report_count += 1
            p.best_confidence = max(p.best_confidence, det.confidence)
            det.pothole_id, det.match_status = p.id, "matched"
        else:
            loc = db.query(Location).filter_by(report_id=det.report_id).first()
            p = Pothole(lat=loc.lat, lon=loc.lon, best_confidence=det.confidence)
            db.add(p)
            db.flush()
            db.add(StatusHistory(pothole_id=p.id, from_status=None, to_status="reported",
                                 note=f"created from report {det.report_id} after manual review", actor=actor))
            det.pothole_id, det.match_status = p.id, "new"
        det.match_meta = meta
        db.commit()
        return det
    except Exception:
        db.rollback()
        raise


def set_status(db: Session, pothole_id: str, to_status: str, note: Optional[str], actor: str) -> Pothole:
    if to_status not in LIFECYCLE:
        raise ValueError(f"status must be one of {LIFECYCLE}")
    p = db.get(Pothole, pothole_id)
    if p is None:
        raise NotFound("pothole not found")
    if p.lifecycle_status != to_status:
        db.add(StatusHistory(pothole_id=p.id, from_status=p.lifecycle_status, to_status=to_status,
                             note=note, actor=actor))
        p.lifecycle_status = to_status
        if to_status == "verified":
            p.verification_status = "verified"
    db.commit()
    return p


# ---------- serialization ----------
def _ev_url(path: str) -> str:
    return f"/static/evidence/{path}"


def det_dict(d: DetectionResult) -> Dict[str, Any]:
    return {
        "id": d.id, "pothole_id": d.pothole_id, "match_status": d.match_status, "confidence": d.confidence,
        "bbox": d.bbox, "image_width": d.image_width, "image_height": d.image_height,
        "frame_index": d.frame_index, "timestamp_s": d.timestamp_s, "track_id": d.track_id,
        "evidence_url": None,  # filled by callers that have the evidence rows loaded
        "match_meta": d.match_meta,
    }


def report_dict(db: Session, r: PotholeReport) -> Dict[str, Any]:
    ev = {e.id: e.path for e in r.evidence}
    loc = r.locations[0] if r.locations else None
    dets = []
    for d in r.detections:
        x = det_dict(d)
        x["evidence_url"] = _ev_url(ev[d.evidence_id]) if d.evidence_id in ev else None
        dets.append(x)
    return {
        "id": r.id, "created_at": r.created_at.isoformat(), "source": r.source, "status": r.status,
        "location_status": r.location_status, "original_filename": r.original_filename,
        "video_job_id": r.video_job_id,
        "location": None if not loc else {"lat": loc.lat, "lon": loc.lon, "accuracy_m": loc.accuracy_m,
                                          "source": loc.source, "verified": loc.verified},
        "detections": dets,
        "summary": {s: sum(1 for d in r.detections if d.match_status == s)
                    for s in ("new", "matched", "uncertain", "pending_location")},
    }


def pothole_dict(db: Session, p: Pothole, detail: bool = False) -> Dict[str, Any]:
    out = {"id": p.id, "lat": p.lat, "lon": p.lon, "lifecycle_status": p.lifecycle_status,
           "verification_status": p.verification_status, "report_count": p.report_count,
           "best_confidence": p.best_confidence, "created_at": p.created_at.isoformat(),
           "updated_at": p.updated_at.isoformat()}
    if detail:
        reports: Dict[str, PotholeReport] = {}
        dets = []
        for d in p.detections:
            reports[d.report_id] = d.report
            x = det_dict(d)
            ev = next((e for e in d.report.evidence if e.id == d.evidence_id), None)
            x["evidence_url"] = _ev_url(ev.path) if ev else None
            x["report_id"] = d.report_id
            dets.append(x)
        out["detections"] = dets
        out["reports"] = [
            {"id": r.id, "created_at": r.created_at.isoformat(), "source": r.source,
             "location_status": r.location_status,
             "location": None if not r.locations else {
                 "lat": r.locations[0].lat, "lon": r.locations[0].lon,
                 "accuracy_m": r.locations[0].accuracy_m, "source": r.locations[0].source}}
            for r in sorted(reports.values(), key=lambda r: r.created_at)]
        out["status_history"] = [
            {"from": h.from_status, "to": h.to_status, "note": h.note, "actor": h.actor,
             "at": h.created_at.isoformat()} for h in p.history]
    return out
