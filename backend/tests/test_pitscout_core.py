"""PitScout core: GPS validation, geo matching, tracking, visual similarity, duplicate handling,
transactions and concurrency. DB tests use a real temp SQLite file (no mocks)."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pytest
from sqlalchemy import create_engine, event, func
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.database.base import Base
from app.models.pitscout import DetectionResult, EvidenceFile, Location, Pothole, PotholeReport, StatusHistory
from app.services import pothole_service as svc
from app.services.duplicate_service import MATCH, NEW, UNCERTAIN, decide
from app.services.geo import bounding_box, haversine_m, validate_location
from app.services.similarity import context_crop, cosine, embed_crop
from app.services.tracker import IoUTracker

# ---------------------------------------------------------------- synthetic pothole photos
def make_patch(seed: int, size: int = 200) -> np.ndarray:
    r = np.random.default_rng(seed)
    base = cv2.GaussianBlur(r.normal(128, 18, (size, size)).clip(0, 255).astype(np.float32), (0, 0), 1.2)
    mask = np.zeros((size, size), np.float32)
    c = (size // 2 + int(r.integers(-10, 10)), size // 2 + int(r.integers(-10, 10)))
    cv2.ellipse(mask, c, (int(r.integers(35, 55)), int(r.integers(22, 40))), int(r.integers(0, 180)), 0, 360, 1.0, -1)
    for _ in range(14):
        cv2.circle(mask, (int(c[0] + r.integers(-45, 45)), int(c[1] + r.integers(-35, 35))), int(r.integers(5, 14)), 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 3)
    img = base * (1 - 0.65 * mask) + r.normal(0, 8, (size, size)) * mask
    return np.stack([img] * 3, -1).clip(0, 255).astype(np.uint8)


def relit_and_tilted(img: np.ndarray) -> np.ndarray:
    """Different lighting + camera angle + lower quality: brighter, mild perspective, blur, JPEG."""
    h, w = img.shape[:2]
    out = np.clip(img.astype(np.float32) * 1.3 + 25, 0, 255).astype(np.uint8)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[8, 6], [w - 12, 0], [w, h - 5], [14, h]])
    out = cv2.warpPerspective(out, cv2.getPerspectiveTransform(src, dst), (w, h), borderMode=cv2.BORDER_REFLECT)
    out = cv2.GaussianBlur(out, (0, 0), 1.5)
    return cv2.imdecode(cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 40])[1], 1)


def candidate(img: np.ndarray, conf: float = 0.7, ev: int = 0) -> dict:
    h, w = img.shape[:2]
    bbox = [w // 2 - 45, h // 2 - 30, w // 2 + 45, h // 2 + 30]
    return {"bbox": bbox, "confidence": conf, "embedding": embed_crop(context_crop(img, bbox)),
            "image_width": w, "image_height": h, "area_ratio": 90 * 60 / (w * h), "evidence_idx": ev}


def evidence(img: np.ndarray) -> dict:
    return {"kind": "image", "ext": ".jpg", "data": cv2.imencode(".jpg", img)[1].tobytes()}


LAT, LON = 12.9716, 77.5946


def gps(dlat_m: float = 0.0, acc: float = 5.0) -> dict:
    return {"lat": LAT + dlat_m / 111_320.0, "lon": LON, "accuracy_m": acc, "source": "gps"}


@pytest.fixture()
def factory(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "EVIDENCE_DIR", tmp_path / "evidence")
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False)
    engine.dispose()


def submit(factory, imgs, location, **kw):
    with factory() as db:
        rep, created = svc.create_report(
            db, source="image", candidates=[candidate(i, ev=n) for n, i in enumerate(imgs)],
            evidence=[evidence(i) for i in imgs], location=location, **kw)
        return svc.report_dict(db, rep), created


def count(factory, model):
    with factory() as db:
        return db.query(func.count(model.id)).scalar()


# ---------------------------------------------------------------- GPS validation
@pytest.mark.parametrize("lat,lon", [(91, 0.5), (-91, 0.5), (1, 181), (1, -181), ("x", 1), (float("nan"), 1),
                                    (float("inf"), 1), (None, 1), (0, 0)])
def test_invalid_coordinates_rejected(lat, lon):
    with pytest.raises(ValueError):
        validate_location(lat, lon)


def test_valid_location_and_verification_rules():
    assert validate_location(12.97, 77.59, 8, "gps")["verified"] is True
    assert validate_location(12.97, 77.59, 400, "gps")["verified"] is False  # poor fix
    assert validate_location(12.97, 77.59, None, "gps")["verified"] is False  # unknown accuracy
    assert validate_location("12.97", "77.59", None, "manual")["verified"] is False
    for bad in (-1, 99999, "abc"):
        with pytest.raises(ValueError):
            validate_location(12.97, 77.59, bad)
    with pytest.raises(ValueError):
        validate_location(12.97, 77.59, 5, "satellite")


def test_haversine_and_bounding_box():
    assert haversine_m(0.5, 10, 0.5, 10) == 0
    assert haversine_m(0, 10, 1, 10) == pytest.approx(111_195, rel=0.002)
    assert haversine_m(LAT, LON, LAT + 10 / 111_195, LON) == pytest.approx(10, rel=0.01)
    b = bounding_box(LAT, LON, 50)
    east = LON + 49 / (111_320 * np.cos(np.radians(LAT)))
    assert b["lon_min"] < LON < east < b["lon_max"] and b["lat_min"] < LAT < b["lat_max"]


# ---------------------------------------------------------------- tracking
def box_at(x, y, w=30, h=20):
    return [x, y, x + w, y + h]


def test_tracker_same_pothole_across_frames_is_one_track():  # TEST 5 (logic)
    tr = IoUTracker()
    ids = {tr.update([box_at(300 + 12 * k, 200 + 25 * k, 30 + 4 * k, 20 + 3 * k)])[0].id for k in range(8)}
    assert ids == {1} and len(tr.all_tracks()) == 1 and tr.all_tracks()[0].hits == 8


def test_tracker_separates_distinct_potholes_and_expires_old_tracks():
    tr = IoUTracker(max_age=2)
    a, b = tr.update([box_at(50, 50), box_at(600, 300)])
    assert a.id != b.id
    for _ in range(4):  # nothing detected: tracks expire
        tr.update([])
    again = tr.update([box_at(50, 50)])[0]
    assert again.id not in (a.id, b.id)
    assert len(tr.all_tracks()) == 3


# ---------------------------------------------------------------- visual similarity
def test_same_pothole_survives_lighting_and_angle_change():  # TEST 3 signal
    a = make_patch(1)
    sim = cosine(embed_crop(a), embed_crop(relit_and_tilted(a)))
    assert sim >= settings.VISUAL_MATCH_MIN, sim


def test_different_potholes_score_below_match_threshold():
    sims = [cosine(embed_crop(make_patch(i)), embed_crop(make_patch(j))) for i, j in [(1, 2), (1, 3), (2, 3), (4, 5)]]
    assert max(sims) < settings.VISUAL_MATCH_MIN, sims


def test_tiny_crop_refused():
    with pytest.raises(ValueError):
        embed_crop(np.zeros((4, 4, 3), np.uint8))


# ---------------------------------------------------------------- decision rules (pure)
def cand(vis, dist=3.0, radius=40.0, size=0.9, pid="p"):
    return {"pothole_id": pid, "distance_m": dist, "radius_m": radius, "visual_sim": vis, "size_ratio": size}


def test_decision_rules():
    assert decide([])[0] == NEW
    assert decide([cand(0.9)])[0] == MATCH
    assert decide([cand(0.1)])[0] == NEW  # close but visually different
    assert decide([cand(0.4)])[0] == UNCERTAIN
    assert decide([cand(None)])[0] == UNCERTAIN  # no comparable evidence: never auto-merge
    assert decide([cand(0.9, pid="a"), cand(0.9, pid="b")])[0] == UNCERTAIN  # ambiguous twins
    assert decide([cand(0.95, pid="a"), cand(0.7, dist=30, pid="b")])[0] == MATCH


def test_closeness_alone_never_merges():
    assert decide([cand(0.0, dist=0.0)])[0] != MATCH
    assert decide([cand(0.59, dist=0.0)])[0] != MATCH


# ---------------------------------------------------------------- duplicate handling (DB)
def test_same_pothole_same_location_different_user_reuses_record(factory):  # TEST 1
    img = make_patch(1)
    r1, _ = submit(factory, [img], gps(), reporter_id="user-a")
    r2, _ = submit(factory, [img], gps(1.5), reporter_id="user-b")
    assert r1["detections"][0]["match_status"] == "new" and r2["detections"][0]["match_status"] == "matched"
    assert r1["detections"][0]["pothole_id"] == r2["detections"][0]["pothole_id"]
    assert count(factory, Pothole) == 1 and count(factory, PotholeReport) == 2
    with factory() as db:
        p = db.query(Pothole).one()
        assert p.report_count == 2
        assert {r.reporter_id for r in db.query(PotholeReport)} == {"user-a", "user-b"}  # originals preserved
        assert count(factory, EvidenceFile) == 2 and count(factory, Location) == 2  # evidence + location history


def test_different_potholes_close_together_are_not_merged(factory):  # TEST 2
    r1, _ = submit(factory, [make_patch(1)], gps())
    r2, _ = submit(factory, [make_patch(2)], gps(4))
    assert r2["detections"][0]["match_status"] in ("new", "uncertain")
    assert r2["detections"][0]["pothole_id"] != r1["detections"][0]["pothole_id"]
    assert count(factory, Pothole) <= 2 and count(factory, PotholeReport) == 2


def test_same_pothole_different_lighting_and_angle_matches(factory):  # TEST 3
    img = make_patch(3)
    submit(factory, [img], gps())
    r2, _ = submit(factory, [relit_and_tilted(img)], gps(3))
    assert r2["detections"][0]["match_status"] == "matched"
    assert count(factory, Pothole) == 1


def test_far_apart_identical_looking_potholes_stay_separate(factory):
    img = make_patch(1)
    submit(factory, [img], gps())
    r2, _ = submit(factory, [img], gps(400))
    assert r2["detections"][0]["match_status"] == "new" and count(factory, Pothole) == 2


def test_gps_unavailable_report_pending_then_resolved(factory):  # TEST 4
    img = make_patch(1)
    r, _ = submit(factory, [img], None)
    assert r["status"] == "processed" and r["location_status"] == "pending" and r["location"] is None
    assert r["detections"][0]["match_status"] == "pending_location"
    assert count(factory, Pothole) == 0  # never invent a location, never create a located record
    with factory() as db:
        out = svc.report_dict(db, svc.add_location(db, r["id"], {"lat": LAT, "lon": LON, "accuracy_m": None, "source": "manual"}))
        assert out["location_status"] == "unverified" and out["detections"][0]["match_status"] == "new"
        with pytest.raises(svc.Conflict):
            svc.add_location(db, r["id"], {"lat": LAT, "lon": LON, "accuracy_m": None, "source": "manual"})
    assert count(factory, Pothole) == 1


def test_invalid_location_persists_nothing(factory):
    with pytest.raises(ValueError):
        submit(factory, [make_patch(1)], {"lat": 123, "lon": 5, "accuracy_m": 5, "source": "gps"})
    assert count(factory, PotholeReport) == 0 and count(factory, Pothole) == 0


def test_two_potholes_in_one_report_are_never_merged_with_each_other(factory):
    img = make_patch(1)
    r, _ = submit(factory, [img, img], gps())  # identical crops, same fix, same report
    ids = {d["pothole_id"] for d in r["detections"]}
    assert len(ids) == 2 and count(factory, Pothole) == 2


def test_uncertain_is_flagged_and_can_be_resolved(factory):
    img = make_patch(1)
    r1, _ = submit(factory, [img], gps())
    # nearby, but the crop is too small to embed: no comparable visual evidence => must not auto-merge
    c = candidate(img)
    c["embedding"] = None
    with factory() as db:
        rep, _ = svc.create_report(db, source="image", candidates=[c], evidence=[evidence(img)], location=gps(2))
        d = svc.report_dict(db, rep)["detections"][0]
    assert d["match_status"] == "uncertain" and d["pothole_id"] is None and d["match_meta"]["candidates"]
    assert count(factory, Pothole) == 1  # nothing merged, nothing duplicated
    with factory() as db:
        det = svc.resolve_uncertain(db, d["id"], r1["detections"][0]["pothole_id"], "tester")
        assert det.match_status == "matched" and det.pothole_id == r1["detections"][0]["pothole_id"]
        assert db.query(Pothole).one().report_count == 2
        with pytest.raises(svc.Conflict):
            svc.resolve_uncertain(db, d["id"], None, "tester")


def test_idempotency_key_prevents_duplicate_report(factory):
    img = make_patch(1)
    r1, c1 = submit(factory, [img], gps(), idempotency_key="abc-1")
    r2, c2 = submit(factory, [img], gps(), idempotency_key="abc-1")
    assert c1 and not c2 and r1["id"] == r2["id"]
    assert count(factory, PotholeReport) == 1 and count(factory, Pothole) == 1


def test_failed_transaction_rolls_back_and_removes_evidence(factory, tmp_path):
    bad = candidate(make_patch(1))
    bad["evidence_idx"] = 5  # IndexError mid-transaction, after evidence files were written
    with factory() as db:
        with pytest.raises(IndexError):
            svc.create_report(db, source="image", candidates=[bad], evidence=[evidence(make_patch(1))], location=gps())
    assert count(factory, PotholeReport) == 0 and count(factory, EvidenceFile) == 0
    assert not list((tmp_path / "evidence").rglob("*.jpg"))


def test_status_lifecycle_history(factory):
    r, _ = submit(factory, [make_patch(1)], gps())
    pid = r["detections"][0]["pothole_id"]
    with factory() as db:
        svc.set_status(db, pid, "verified", "checked on site", "tester")
        with pytest.raises(ValueError):
            svc.set_status(db, pid, "teleported", None, "tester")
        p = db.get(Pothole, pid)
        assert p.verification_status == "verified"
        assert [(h.from_status, h.to_status) for h in p.history] == [(None, "reported"), ("reported", "verified")]


def test_concurrent_reports_of_same_pothole_create_one_record(factory, monkeypatch):  # TEST 6
    img = make_patch(1)
    real_decide = svc.decide

    def slow_decide(cands):  # widen the read-then-write window so an unprotected race reliably shows up
        time.sleep(0.05)
        return real_decide(cands)

    monkeypatch.setattr(svc, "decide", slow_decide)
    n = 8
    barrier = threading.Barrier(n)

    def worker(i):
        barrier.wait()
        with factory() as db:
            rep, _ = svc.create_report(
                db, source="image", candidates=[candidate(img)], evidence=[evidence(img)],
                location=gps(i * 0.3), reporter_id=f"u{i}")
            return rep.detections[0].match_status

    with ThreadPoolExecutor(n) as ex:
        results = list(ex.map(worker, range(n)))
    assert sorted(results).count("new") == 1 and results.count("matched") == n - 1, results
    with factory() as db:
        assert db.query(func.count(Pothole.id)).scalar() == 1
        assert db.query(Pothole).one().report_count == n
        assert db.query(func.count(StatusHistory.id)).scalar() == 1


def test_concurrent_retries_with_same_idempotency_key_create_one_report(factory):
    """The key lookup is a read-then-write; without the serialized write lock the losers hit the
    unique constraint (IntegrityError) instead of replaying the first report."""
    img = make_patch(1)
    n = 6

    @event.listens_for(factory.kw["bind"], "after_cursor_execute")
    def widen(conn, cursor, statement, *a):  # pause right after the key lookup
        if statement.lstrip().upper().startswith("SELECT") and "idempotency_key" in statement:
            time.sleep(0.05)

    barrier = threading.Barrier(n)

    def worker(_):
        barrier.wait()
        with factory() as db:
            rep, created = svc.create_report(db, source="image", candidates=[candidate(img)],
                                             evidence=[evidence(img)], location=gps(), idempotency_key="same-key")
            return rep.id, created

    with ThreadPoolExecutor(n) as ex:
        out = list(ex.map(worker, range(n)))
    assert len({rid for rid, _ in out}) == 1 and [c for _, c in out].count(True) == 1
    assert count(factory, PotholeReport) == 1 and count(factory, Pothole) == 1
