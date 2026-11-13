"""Video pothole detection: sample frames -> existing detector -> tracker -> per-track evidence."""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import cv2
from PIL import Image
from sqlalchemy.orm import Session

from app.core.config import settings
from app.ml.registry import registry
from app.models.pitscout import VideoJob
from app.services import pothole_service
from app.services.similarity import context_crop, embed_crop
from app.services.tracker import IoUTracker

logger = logging.getLogger("pitscout.video")


def _jpeg(bgr) -> bytes:
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise RuntimeError("could not encode frame")
    return buf.tobytes()


def probe_video(path: Path) -> Dict[str, Any]:
    """Validate that the file really decodes; raises ValueError with a user-safe message."""
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise ValueError("file could not be opened as a video (unsupported or corrupted)")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        if not 1.0 <= fps <= 240.0:
            raise ValueError("video has no usable frame rate")
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise ValueError("video has no decodable frames")
        if count > 0 and count / fps > settings.MAX_VIDEO_SECONDS:
            raise ValueError(f"video longer than the {settings.MAX_VIDEO_SECONDS}s limit")
        return {"fps": fps, "frame_count": count if count > 0 else None, "width": frame.shape[1],
                "height": frame.shape[0], "duration_s": round(count / fps, 2) if count > 0 else None}
    finally:
        cap.release()


def process_video(
    path: Path, out_dir: Path, sample_fps: float, conf: Optional[float] = None,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    meta = probe_video(path)
    fps, total = meta["fps"], meta["frame_count"]
    stride = max(1, round(fps / max(0.1, sample_fps)))
    detector, fp_filter = registry.damage_detector, registry.false_positive_filter
    tracker = IoUTracker()
    best: Dict[int, Dict[str, Any]] = {}  # track id -> best observation (+ jpeg, embedding)
    sampled = raw = frames_with = 0
    idx = -1
    cap = cv2.VideoCapture(str(path))
    try:
        while cap.grab():
            idx += 1
            if idx / fps > settings.MAX_VIDEO_SECONDS:
                raise ValueError(f"video longer than the {settings.MAX_VIDEO_SECONDS}s limit")
            if idx % stride:
                continue
            ok, bgr = cap.retrieve()
            if not ok:
                continue  # one undecodable frame should not kill the job
            sampled += 1
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            res = detector.predict(pil, **({"conf": conf} if conf is not None else {}))
            if not res.get("model_ready") or res.get("error"):
                raise RuntimeError(res.get("error") or "detection model unavailable")
            dets = [d for d in res["detections"] if d["class"] == "pothole"
                    and fp_filter.predict(pil, bbox=d["bbox"], class_name="pothole",
                                          confidence=d["confidence"]).get("is_valid")]
            raw += len(dets)
            frames_with += bool(dets)
            for d, t in zip(dets, tracker.update([d["bbox"] for d in dets])):
                obs = {"frame_index": idx, "timestamp_s": round(idx / fps, 3), "bbox": d["bbox"],
                       "confidence": d["confidence"]}
                t.history.append(obs)
                if t.id not in best or d["confidence"] > best[t.id]["confidence"]:
                    try:
                        emb = embed_crop(context_crop(rgb, d["bbox"]))
                    except ValueError:
                        emb = None
                    best[t.id] = {**obs, "jpeg": _jpeg(bgr), "embedding": emb,
                                  "image_width": bgr.shape[1], "image_height": bgr.shape[0]}
            if progress_cb and total:
                progress_cb(min(0.99, idx / total))
    finally:
        cap.release()

    out_dir.mkdir(parents=True, exist_ok=True)
    tracks: List[Dict[str, Any]] = []
    for t in tracker.all_tracks():
        b = best[t.id]
        (out_dir / f"track_{t.id}.jpg").write_bytes(b["jpeg"])
        confs = [h["confidence"] for h in t.history]
        tracks.append({
            "track_id": t.id, "confirmed": t.hits >= settings.VIDEO_MIN_TRACK_HITS, "hits": t.hits,
            "first_timestamp_s": t.history[0]["timestamp_s"], "last_timestamp_s": t.history[-1]["timestamp_s"],
            "best_confidence": b["confidence"], "mean_confidence": round(sum(confs) / len(confs), 4),
            "best_frame_index": b["frame_index"], "best_bbox": b["bbox"],
            "image_width": b["image_width"], "image_height": b["image_height"],
            "evidence_path": f"video/{out_dir.name}/track_{t.id}.jpg", "embedding": b["embedding"],
            "frames": t.history,
        })
    confirmed = [t for t in tracks if t["confirmed"]]
    return {
        "video": {**meta, "sample_fps": sample_fps, "stride": stride, "frames_read": idx + 1},
        "sampled_frames": sampled, "frames_with_detections": frames_with, "raw_detections": raw,
        "total_unique_potholes": len(confirmed), "unconfirmed_tracks": len(tracks) - len(confirmed),
        "min_track_hits": settings.VIDEO_MIN_TRACK_HITS, "tracks": tracks,
    }


def public_result(result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """API view: drop embeddings, add evidence URLs."""
    if not result:
        return result
    tracks = [{**{k: v for k, v in t.items() if k != "embedding"},
               "evidence_url": f"/static/evidence/{t['evidence_path']}"} for t in result["tracks"]]
    return {**result, "tracks": tracks}


def run_video_job(job_id: str, path: Path, sample_fps: float, conf: Optional[float], bind) -> None:
    """Background entry point (own session on the request's engine). Always removes the temp file."""
    db = Session(bind=bind)
    try:
        job = db.get(VideoJob, job_id)
        job.status = "processing"
        db.commit()

        def progress(p: float) -> None:
            job.progress = p
            db.commit()

        result = process_video(path, settings.EVIDENCE_DIR / "video" / job_id, sample_fps, conf, progress)
        job.status, job.progress, job.result = "completed", 1.0, result
        db.commit()
    except ValueError as exc:  # validation-style failures carry user-safe messages
        _fail(db, job_id, str(exc))
    except Exception:
        logger.exception("video job %s failed", job_id)
        _fail(db, job_id, "processing failed; see server logs")
    finally:
        path.unlink(missing_ok=True)
        db.close()


def _fail(db, job_id: str, message: str) -> None:
    db.rollback()
    job = db.get(VideoJob, job_id)
    if job:
        job.status, job.error = "failed", message
        db.commit()


def report_from_video(
    db, job: VideoJob, location: Optional[Dict[str, Any]], track_ids: Optional[List[int]],
    reporter_id: Optional[str], idempotency_key: Optional[str],
):
    if job.status != "completed" or not job.result:
        raise pothole_service.Conflict("video job is not completed")
    tracks = [t for t in job.result["tracks"]
              if (t["track_id"] in track_ids if track_ids else t["confirmed"])]
    evidence, cands = [], []
    for i, t in enumerate(tracks):
        evidence.append({"kind": "video_frame", "ext": ".jpg",
                         "data": (settings.EVIDENCE_DIR / t["evidence_path"]).read_bytes()})
        w, h = t["image_width"], t["image_height"]
        x1, y1, x2, y2 = t["best_bbox"]
        cands.append({"bbox": t["best_bbox"], "confidence": t["best_confidence"], "embedding": t["embedding"],
                      "image_width": w, "image_height": h, "area_ratio": (x2 - x1) * (y2 - y1) / (w * h),
                      "frame_index": t["best_frame_index"],
                      "timestamp_s": next(f["timestamp_s"] for f in t["frames"]
                                          if f["frame_index"] == t["best_frame_index"]),
                      "track_id": t["track_id"], "evidence_idx": i})
    return pothole_service.create_report(
        db, source="video", candidates=cands, evidence=evidence, location=location,
        reporter_id=reporter_id, idempotency_key=idempotency_key, video_job_id=job.id,
        original_filename=job.original_filename)
