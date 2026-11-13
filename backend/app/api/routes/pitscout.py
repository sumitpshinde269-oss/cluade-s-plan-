"""PitScout API: pothole reports (image/video), duplicate-aware pothole records, map data."""
from __future__ import annotations

import io
import logging
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

import numpy as np
from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, Query,
                     Request, UploadFile)
from fastapi.concurrency import run_in_threadpool
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import verify_api_key
from app.core.config import settings
from app.database.session import get_db
from app.models.pitscout import (LIFECYCLE, DetectionResult, Pothole, PotholeReport, VideoJob)
from app.services import pothole_service as svc
from app.services import video_service
from app.services.geo import validate_location
from app.services.inspection_pipeline import inspection_pipeline
from app.services.similarity import context_crop, embed_crop

logger = logging.getLogger("pitscout.api")
router = APIRouter(prefix="/api/v1", tags=["pitscout"], dependencies=[Depends(verify_api_key)])

_hits: Dict[str, Deque[float]] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    """shortcut: in-memory, per-process, per-client-IP; use a shared store (Redis) when scaled out."""
    q = _hits[request.client.host if request.client else "?"]
    now = time.monotonic()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= settings.UPLOAD_RATE_LIMIT_PER_MIN:
        raise HTTPException(429, "Too many uploads; retry in a minute.")
    q.append(now)


def _safe(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except svc.Conflict as e:
        raise HTTPException(409, str(e))
    except svc.NotFound as e:
        raise HTTPException(404, str(e))


def _location(lat: Any, lon: Any, acc: Any, source: str) -> Optional[Dict[str, Any]]:
    blank = (None, "")
    if lat in blank and lon in blank:
        return None
    if lat in blank or lon in blank:
        raise HTTPException(422, "Provide both latitude and longitude, or neither.")
    loc = {"lat": lat, "lon": lon, "accuracy_m": acc, "source": source}
    try:
        validate_location(**loc)  # fail before spending time on inference
    except ValueError as e:
        raise HTTPException(422, str(e))
    return loc


async def _save_upload(file: UploadFile, dest: Path, max_mb: int) -> int:
    """Stream to disk with a hard size cap; deletes the partial file on failure."""
    size, limit = 0, max_mb * 1024 * 1024
    try:
        with dest.open("wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds {max_mb} MB")
                fh.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, "Uploaded file is empty")
    return size


def _ext(file: UploadFile, allowed: set) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed:
        raise HTTPException(422, f"Unsupported format. Allowed: {', '.join(sorted(allowed))}")
    return ext


# ---------------------------------------------------------------- image reports
@router.post("/pothole-reports", status_code=201, dependencies=[Depends(rate_limit)])
async def create_image_report(
    file: UploadFile = File(...),
    latitude: Optional[str] = Form(None), longitude: Optional[str] = Form(None),
    accuracy_m: Optional[str] = Form(None), location_source: str = Form("gps"),
    idempotency_key: Optional[str] = Header(None, max_length=128),
    reporter_id: Optional[str] = Header(None, alias="X-Reporter-Id", max_length=64),
    db: Session = Depends(get_db),
):
    _ext(file, settings.ALLOWED_EXTENSIONS)
    loc = _location(latitude, longitude, accuracy_m, location_source)
    data = await file.read(settings.MAX_FILE_SIZE_MB * 1024 * 1024 + 1)
    if not data:
        raise HTTPException(422, "Uploaded file is empty")
    if len(data) > settings.MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {settings.MAX_FILE_SIZE_MB} MB")

    result = await run_in_threadpool(inspection_pipeline.process_image, data, file.filename or "upload.jpg")
    if not result.get("success"):
        raise HTTPException(422, {"message": result.get("message", "Image rejected"),
                                  "stage": result.get("stage"), "pipeline_status": result.get("pipeline_status")})

    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    rgb = np.array(img)
    w, h = img.size
    cands = []
    for d in result["damage_analysis"]["detections"]:
        if d["class"] != "pothole":
            continue
        try:
            emb = embed_crop(context_crop(rgb, d["bbox"]))
        except ValueError:
            emb = None  # tiny box: cannot be compared visually, so it can never auto-match
        x1, y1, x2, y2 = d["bbox"]
        cands.append({"bbox": d["bbox"], "confidence": d["confidence"], "embedding": emb, "image_width": w,
                      "image_height": h, "area_ratio": (x2 - x1) * (y2 - y1) / (w * h), "evidence_idx": 0})
    ext = Path(file.filename or "").suffix.lower().replace(".jpeg", ".jpg")
    report, created = _safe(
        svc.create_report, db, source="image", candidates=cands, evidence=[{"kind": "image", "data": data, "ext": ext}],
        location=loc, reporter_id=reporter_id, idempotency_key=idempotency_key,
        original_filename=(file.filename or "")[:255])
    out = svc.report_dict(db, report)
    out["idempotent_replay"] = not created
    out["detector_candidates"] = result["damage_analysis"]["total_raw_candidates"]
    return out


@router.get("/pothole-reports")
def list_reports(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db)):
    q = db.query(PotholeReport).order_by(PotholeReport.created_at.desc())
    return {"total": q.count(), "items": [svc.report_dict(db, r) for r in q.limit(limit).offset(offset)]}


@router.get("/pothole-reports/{report_id}")
def get_report(report_id: str, db: Session = Depends(get_db)):
    r = db.get(PotholeReport, report_id)
    if not r:
        raise HTTPException(404, "report not found")
    return svc.report_dict(db, r)


class LocationBody(BaseModel):
    latitude: float
    longitude: float
    accuracy_m: Optional[float] = None
    location_source: str = "gps"


@router.post("/pothole-reports/{report_id}/location")
def set_report_location(report_id: str, body: LocationBody, db: Session = Depends(get_db)):
    loc = {"lat": body.latitude, "lon": body.longitude, "accuracy_m": body.accuracy_m, "source": body.location_source}
    return svc.report_dict(db, _safe(svc.add_location, db, report_id, loc))


class ResolveBody(BaseModel):
    pothole_id: Optional[str] = None  # null => confirm it is a new pothole


@router.post("/detections/{detection_id}/resolve")
def resolve_detection(detection_id: str, body: ResolveBody, db: Session = Depends(get_db)):
    det = _safe(svc.resolve_uncertain, db, detection_id, body.pothole_id, "reviewer")
    return svc.report_dict(db, db.get(PotholeReport, det.report_id))


# ---------------------------------------------------------------- video
@router.post("/videos", status_code=202, dependencies=[Depends(rate_limit)])
async def upload_video(
    background: BackgroundTasks, file: UploadFile = File(...),
    sample_fps: float = Form(settings.VIDEO_DEFAULT_SAMPLE_FPS, ge=0.5, le=30),
    confidence: Optional[float] = Form(None, ge=0.05, le=0.95),
    db: Session = Depends(get_db),
):
    ext = _ext(file, settings.ALLOWED_VIDEO_EXTENSIONS)
    settings.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    path = settings.UPLOADS_DIR / f"video_{uuid.uuid4().hex}{ext}"
    await _save_upload(file, path, settings.MAX_VIDEO_SIZE_MB)
    try:
        meta = await run_in_threadpool(video_service.probe_video, path)
    except ValueError as e:
        path.unlink(missing_ok=True)
        raise HTTPException(422, str(e))
    job = VideoJob(original_filename=(file.filename or "")[:255],
                   params={"sample_fps": sample_fps, "confidence": confidence, "video": meta})
    db.add(job)
    db.commit()
    background.add_task(video_service.run_video_job, job.id, path, sample_fps, confidence, db.get_bind())
    return {"id": job.id, "status": job.status, "video": meta}


def _job_dict(j: VideoJob, full: bool) -> Dict[str, Any]:
    out = {"id": j.id, "status": j.status, "progress": j.progress, "error": j.error,
           "created_at": j.created_at.isoformat(), "original_filename": j.original_filename, "params": j.params}
    if j.result:
        out["summary"] = {k: j.result[k] for k in ("sampled_frames", "frames_with_detections", "raw_detections",
                                                   "total_unique_potholes", "unconfirmed_tracks")}
        if full:
            out["result"] = video_service.public_result(j.result)
    return out


@router.get("/videos")
def list_videos(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    jobs = db.query(VideoJob).order_by(VideoJob.created_at.desc()).limit(limit).all()
    return {"items": [_job_dict(j, False) for j in jobs]}


@router.get("/videos/{job_id}")
def get_video(job_id: str, db: Session = Depends(get_db)):
    j = db.get(VideoJob, job_id)
    if not j:
        raise HTTPException(404, "video job not found")
    return _job_dict(j, True)


class VideoReportBody(LocationBody):
    latitude: Optional[float] = None  # type: ignore[assignment]
    longitude: Optional[float] = None  # type: ignore[assignment]
    track_ids: Optional[List[int]] = None


@router.post("/videos/{job_id}/report", status_code=201)
def report_video(
    job_id: str, body: VideoReportBody,
    idempotency_key: Optional[str] = Header(None, max_length=128),
    reporter_id: Optional[str] = Header(None, alias="X-Reporter-Id", max_length=64),
    db: Session = Depends(get_db),
):
    j = db.get(VideoJob, job_id)
    if not j:
        raise HTTPException(404, "video job not found")
    loc = _location(body.latitude, body.longitude, body.accuracy_m, body.location_source)
    report, created = _safe(video_service.report_from_video, db, j, loc, body.track_ids, reporter_id, idempotency_key)
    out = svc.report_dict(db, report)
    out["idempotent_replay"] = not created
    return out


# ---------------------------------------------------------------- potholes
@router.get("/potholes")
def list_potholes(
    status: Optional[str] = None, bbox: Optional[str] = Query(None, description="lat_min,lon_min,lat_max,lon_max"),
    limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0), db: Session = Depends(get_db),
):
    q = db.query(Pothole)
    if status:
        if status not in LIFECYCLE:
            raise HTTPException(422, f"status must be one of {LIFECYCLE}")
        q = q.filter(Pothole.lifecycle_status == status)
    if bbox:
        try:
            a, b, c, d = (float(x) for x in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox must be lat_min,lon_min,lat_max,lon_max")
        q = q.filter(Pothole.lat.between(a, c), Pothole.lon.between(b, d))
    total = q.count()
    rows = q.order_by(Pothole.updated_at.desc()).limit(limit).offset(offset).all()
    return {"total": total, "items": [svc.pothole_dict(db, p) for p in rows]}


@router.get("/potholes/{pothole_id}")
def get_pothole(pothole_id: str, db: Session = Depends(get_db)):
    p = db.get(Pothole, pothole_id)
    if not p:
        raise HTTPException(404, "pothole not found")
    return svc.pothole_dict(db, p, detail=True)


class StatusBody(BaseModel):
    status: str
    note: Optional[str] = None


@router.patch("/potholes/{pothole_id}/status")
def update_status(pothole_id: str, body: StatusBody, db: Session = Depends(get_db)):
    return svc.pothole_dict(db, _safe(svc.set_status, db, pothole_id, body.status, body.note, "api"), detail=True)


@router.get("/map/potholes")
def map_potholes(status: Optional[str] = None, limit: int = Query(2000, ge=1, le=5000), db: Session = Depends(get_db)):
    q = db.query(Pothole).filter(Pothole.lifecycle_status != "rejected")
    if status:
        q = q.filter(Pothole.lifecycle_status == status)
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p.lon, p.lat]},
              "properties": {"id": p.id, "lifecycle_status": p.lifecycle_status, "report_count": p.report_count,
                             "best_confidence": p.best_confidence, "verification_status": p.verification_status}}
             for p in q.limit(limit)]
    return {"type": "FeatureCollection", "features": feats}


@router.get("/pitscout/summary")
def summary(db: Session = Depends(get_db)):
    """Real counts only; zero when the database is empty."""
    by_status = dict(db.query(Pothole.lifecycle_status, func.count()).group_by(Pothole.lifecycle_status).all())
    by_match = dict(db.query(DetectionResult.match_status, func.count()).group_by(DetectionResult.match_status).all())
    return {"potholes": sum(by_status.values()), "potholes_by_status": by_status,
            "reports": db.query(func.count(PotholeReport.id)).scalar(),
            "videos": db.query(func.count(VideoJob.id)).scalar(),
            "detections_by_match_status": by_match}
