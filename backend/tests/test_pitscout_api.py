"""PitScout API + end-to-end tests. Real YOLO inference on real frames/video from docs/testts
(skipped if that footage is absent). DB is a temp SQLite file injected via dependency override."""
import glob
import io
import shutil
from pathlib import Path

import cv2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.database.base import Base
from app.database.session import get_db
from app.main import app
from app.services import video_service

ROOT = Path(__file__).resolve().parents[2]
VIDEOS = sorted(glob.glob(str(ROOT / "docs" / "testts" / "*.mp4")))
H = {"X-API-Key": settings.API_KEY}
needs_video = pytest.mark.skipif(not VIDEOS, reason="docs/testts footage not present")


@pytest.fixture()
def client(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'api.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)

    def override():
        with Session() as db:
            yield db

    app.dependency_overrides[get_db] = override
    ev = settings.EVIDENCE_DIR
    ev.mkdir(parents=True, exist_ok=True)
    before = {p for p in ev.iterdir()} | {p for p in (ev / "video").glob("*")}
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    for p in {p for p in ev.iterdir()} | {p for p in (ev / "video").glob("*")}:
        if p not in before and p.name != "video":
            shutil.rmtree(p, ignore_errors=True)
    engine.dispose()


@pytest.fixture(scope="module")
def road_frame() -> bytes:
    """Frame 195 of the first test video: two pothole candidates pass the full pipeline."""
    cap = cv2.VideoCapture(VIDEOS[0])
    cap.set(cv2.CAP_PROP_POS_FRAMES, 195)
    ok, bgr = cap.read()
    cap.release()
    assert ok
    return cv2.imencode(".jpg", bgr)[1].tobytes()


def post_report(client, data, headers=None, **form):
    return client.post("/api/v1/pothole-reports", headers={**H, **(headers or {})},
                       files={"file": ("road.jpg", data, "image/jpeg")}, data=form)


# ---------------------------------------------------------------- validation / auth
def test_requires_api_key(client):
    for method, url in [("get", "/api/v1/potholes"), ("get", "/api/v1/map/potholes"), ("post", "/api/v1/pothole-reports"),
                        ("post", "/api/v1/videos"), ("get", "/api/v1/videos")]:
        assert getattr(client, method)(url).status_code == 401, url


def test_report_input_validation(client):
    r = client.post("/api/v1/pothole-reports", headers=H, files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 422 and "Unsupported format" in r.json()["detail"]
    r = client.post("/api/v1/pothole-reports", headers=H, files={"file": ("a.jpg", b"", "image/jpeg")})
    assert r.status_code == 422
    assert post_report(client, b"x", latitude="12.9").status_code == 422  # only one coordinate
    assert post_report(client, b"x", latitude="95", longitude="10").status_code == 422
    assert post_report(client, b"x", latitude="10", longitude="10", accuracy_m="-3").status_code == 422
    r = post_report(client, b"definitely not a jpeg", latitude="12.9", longitude="77.5")
    assert r.status_code == 422 and r.json()["detail"]["stage"] == "input_validation"  # invalid image handled
    assert client.get("/api/v1/pitscout/summary", headers=H).json()["reports"] == 0  # nothing persisted


def test_empty_database_endpoints_return_empty_not_fake(client):
    assert client.get("/api/v1/potholes", headers=H).json() == {"total": 0, "items": []}
    assert client.get("/api/v1/map/potholes", headers=H).json()["features"] == []
    s = client.get("/api/v1/pitscout/summary", headers=H).json()
    assert s["potholes"] == 0 and s["reports"] == 0 and s["videos"] == 0
    assert client.get("/api/v1/potholes/nope", headers=H).status_code == 404
    assert client.get("/api/v1/potholes?status=bogus", headers=H).status_code == 422


# ---------------------------------------------------------------- image end-to-end (real model)
@needs_video
def test_image_report_dedup_end_to_end(client, road_frame):  # TEST 1 through the real stack
    a = post_report(client, road_frame, {"X-Reporter-Id": "user-a", "Idempotency-Key": "k1"},
                    latitude="12.971600", longitude="77.594600", accuracy_m="6", location_source="gps")
    assert a.status_code == 201, a.text
    a = a.json()
    assert a["location_status"] == "verified" and len(a["detections"]) >= 1
    assert all(d["match_status"] == "new" for d in a["detections"])
    n = len(a["detections"])

    replay = post_report(client, road_frame, {"X-Reporter-Id": "user-a", "Idempotency-Key": "k1"},
                         latitude="12.971600", longitude="77.594600", accuracy_m="6")
    assert replay.json()["id"] == a["id"] and replay.json()["idempotent_replay"] is True

    b = post_report(client, road_frame, {"X-Reporter-Id": "user-b"},  # ~2 m away
                    latitude="12.971618", longitude="77.594600", accuracy_m="8", location_source="gps").json()
    assert [d["match_status"] for d in b["detections"]] == ["matched"] * n
    assert {d["pothole_id"] for d in b["detections"]} == {d["pothole_id"] for d in a["detections"]}

    pots = client.get("/api/v1/potholes", headers=H).json()
    assert pots["total"] == n and all(p["report_count"] == 2 for p in pots["items"])
    detail = client.get(f"/api/v1/potholes/{pots['items'][0]['id']}", headers=H).json()
    assert len(detail["reports"]) == 2 and len(detail["detections"]) == 2
    assert [h["to"] for h in detail["status_history"]] == ["reported"]
    ev = client.get(detail["detections"][0]["evidence_url"])
    assert ev.status_code == 200 and ev.headers["content-type"].startswith("image/")
    feats = client.get("/api/v1/map/potholes", headers=H).json()["features"]
    assert len(feats) == n and feats[0]["geometry"]["coordinates"] == [pytest.approx(77.5946), pytest.approx(12.9716)]

    upd = client.patch(f"/api/v1/potholes/{detail['id']}/status", headers=H, json={"status": "verified", "note": "site visit"})
    assert upd.status_code == 200 and upd.json()["verification_status"] == "verified"
    assert client.patch(f"/api/v1/potholes/{detail['id']}/status", headers=H, json={"status": "nope"}).status_code == 422
    s = client.get("/api/v1/pitscout/summary", headers=H).json()
    assert s["reports"] == 2 and s["potholes"] == n


@needs_video
def test_image_report_without_gps_stays_pending_then_gets_location(client, road_frame):  # TEST 4 through the real stack
    r = post_report(client, road_frame).json()
    assert r["location_status"] == "pending" and r["location"] is None
    assert all(d["match_status"] == "pending_location" for d in r["detections"])
    assert client.get("/api/v1/potholes", headers=H).json()["total"] == 0
    assert client.get("/api/v1/map/potholes", headers=H).json()["features"] == []

    ok = client.post(f"/api/v1/pothole-reports/{r['id']}/location", headers=H,
                     json={"latitude": 12.9716, "longitude": 77.5946, "location_source": "manual"})
    assert ok.status_code == 200 and ok.json()["location_status"] == "unverified"
    assert client.get("/api/v1/potholes", headers=H).json()["total"] == len(r["detections"])
    assert client.post(f"/api/v1/pothole-reports/{r['id']}/location", headers=H,
                       json={"latitude": 1.0, "longitude": 2.0}).status_code == 409
    bad = client.post(f"/api/v1/pothole-reports/{r['id']}/location", headers=H, json={"latitude": 200, "longitude": 2})
    assert bad.status_code in (409, 422)


# ---------------------------------------------------------------- video
def test_video_upload_validation(client):
    r = client.post("/api/v1/videos", headers=H, files={"file": ("x.txt", b"nope", "text/plain")})
    assert r.status_code == 422
    r = client.post("/api/v1/videos", headers=H, files={"file": ("bad.mp4", b"\x00" * 4096, "video/mp4")})
    assert r.status_code == 422 and "video" in r.json()["detail"].lower()
    assert not list(settings.UPLOADS_DIR.glob("video_*"))  # rejected upload is not left on disk
    assert client.get("/api/v1/videos/missing", headers=H).status_code == 404


@needs_video
def test_process_video_tracks_reduce_detections_and_release_file(tmp_path):  # TEST 5 on real footage
    copy = tmp_path / "clip.mp4"
    shutil.copy(VIDEOS[0], copy)
    seen = []
    res = video_service.process_video(copy, tmp_path / "out", sample_fps=5, progress_cb=seen.append)
    copy.unlink()  # raises PermissionError on Windows if the capture handle leaked
    assert seen == sorted(seen) and 0 <= seen[0] < seen[-1] <= 0.99
    assert res["video"]["stride"] >= 1 and res["sampled_frames"] > 10
    assert res["raw_detections"] > len(res["tracks"]) >= 1  # one physical pothole seen in several frames = one track
    assert res["total_unique_potholes"] == sum(t["confirmed"] for t in res["tracks"])
    for t in res["tracks"]:
        assert t["hits"] == len(t["frames"]) and t["first_timestamp_s"] <= t["last_timestamp_s"]
        assert (tmp_path / "out" / f"track_{t['track_id']}.jpg").exists()
        assert all(0 < f["confidence"] <= 1 and len(f["bbox"]) == 4 for f in t["frames"])


@needs_video
def test_video_job_api_flow_and_report(client):
    with open(VIDEOS[0], "rb") as fh:
        r = client.post("/api/v1/videos", headers=H, files={"file": ("ride.mp4", fh, "video/mp4")}, data={"sample_fps": "5"})
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]
    job = client.get(f"/api/v1/videos/{job_id}", headers=H).json()  # background task ran before the response returned
    assert job["status"] == "completed" and job["progress"] == 1.0, job
    res = job["result"]
    assert all("embedding" not in t and t["evidence_url"].startswith("/static/evidence/video/") for t in res["tracks"])
    assert client.get(res["tracks"][0]["evidence_url"]).status_code == 200
    assert not list(settings.UPLOADS_DIR.glob("video_*"))  # temp upload cleaned up
    assert job_id in [j["id"] for j in client.get("/api/v1/videos", headers=H).json()["items"]]

    n = res["total_unique_potholes"]
    assert n >= 1
    rep = client.post(f"/api/v1/videos/{job_id}/report", headers={**H, "Idempotency-Key": "v1"},
                      json={"latitude": 12.9716, "longitude": 77.5946, "accuracy_m": 10})
    assert rep.status_code == 201, rep.text
    rep = rep.json()
    assert rep["source"] == "video" and len(rep["detections"]) == n
    assert all(d["track_id"] is not None and d["timestamp_s"] is not None for d in rep["detections"])
    assert client.get("/api/v1/potholes", headers=H).json()["total"] >= 1
    again = client.post(f"/api/v1/videos/{job_id}/report", headers={**H, "Idempotency-Key": "v1"},
                        json={"latitude": 12.9716, "longitude": 77.5946, "accuracy_m": 10}).json()
    assert again["id"] == rep["id"] and again["idempotent_replay"] is True
    shutil.rmtree(settings.EVIDENCE_DIR / "video" / job_id, ignore_errors=True)
