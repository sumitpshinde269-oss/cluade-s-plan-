# PitScout – System Architecture

## 1. Overview

```
Browser (Next.js pages: /report /video /map /potholes /history)
   │  fetch / XHR            ← API key never reaches the browser
   ▼
Next.js server proxy  /api/pitscout/[...path]   (allow-list, streams bodies, adds X-API-Key)
   ▼
FastAPI backend (backend/app)  ── routes/pitscout.py
   ├─ image report → inspection_pipeline (existing 8-stage pipeline, unchanged)
   ├─ video upload → BackgroundTasks → video_service (cv2 sampling → detector → tracker)
   └─ pothole_service.create_report  ← single transactional write path
          ├─ geo.py            coordinate validation, haversine, bbox prefilter
          ├─ similarity.py     HOG embedding of a context crop, cosine
          └─ duplicate_service MATCH / NEW / UNCERTAIN decision
   ▼
SQLite (WAL) by default, PostgreSQL via DATABASE_URL     storage/evidence/<report>/<sha>.jpg
```

Only `pothole` detections feed PitScout records. Cracks/manholes still flow through the original inspection features unchanged.

## 2. Data model (`models/pitscout.py`, baseline migration `0001`)

```
potholes 1 ──< detection_results >── 1 pothole_reports 1 ──< locations (one fix per report)
    │                  │                       └──< evidence_files
    └──< status_history└── evidence_id → evidence_files
video_jobs (independent; reports reference video_job_id)
```

* **Pothole** = identity only: canonical `lat/lon` (first report's), `lifecycle_status` (`reported|verified|scheduled|repaired|rejected`), `verification_status`, `report_count`, `best_confidence`.
* **PotholeReport** = one submission (image or video), never rewritten when a duplicate is linked. `idempotency_key` is UNIQUE. `location_status`: `verified | unverified | pending`.
* **DetectionResult** = one detected pothole in one report: bbox, confidence, embedding, `match_status` (`new | matched | uncertain | pending_location`), `match_meta` (reason, thresholds, ranked candidates with distance / visual similarity / score), frame index / timestamp / track id for video.
* **Location** = the capturing device's fix (lat, lon, accuracy, source `gps|manual`, verified). A pothole's *location history* is derived through detections → report → location. (A report has one fix but may contain several potholes, so `pothole_id` is deliberately **not** on `locations` or `evidence_files`.)
* **StatusHistory** = every lifecycle transition (actor, note, timestamp).
* Indexes: `potholes(lat, lon)`, `potholes(lifecycle_status)`, FK indexes on `detection_results`, `evidence_files`, `locations`, `status_history`. FKs are enforced (`PRAGMA foreign_keys=ON` on SQLite).

Chain: **Pothole → Detections → Reports → Evidence / Location / Status history**, as required.

## 3. Duplicate identification

For each detected pothole with a location:

1. **Candidate search.** SQL degree-box prefilter on `potholes(lat, lon)` using `MATCH_MAX_RADIUS_M` (100 m), then exact haversine. Rejected potholes are excluded; potholes already linked by the *same report* are excluded (two boxes in one photo are different potholes).
2. **Accuracy-aware radius.** `radius = min(MAX, BASE(15) + accuracy_new + accuracy_candidate)`; a missing accuracy is replaced by `UNKNOWN_ACCURACY_M` (25 m, an explicit assumption, never stored as data). The candidate's accuracy is the best fix across its reports.
3. **Visual signal.** Embedding = HOG of a CLAHE-normalised 64×64 grey crop taken at 3× the box (context included); similarity = cosine against **every** stored detection of the candidate (max).
4. **Decision (`duplicate_service.decide`, pure and unit-tested):**
   * no candidate in radius → **NEW**
   * any in-radius candidate without comparable evidence → **UNCERTAIN**
   * best visual ≥ `VISUAL_MATCH_MIN` (0.60) and not tied with a second candidate (score margin 0.05) → **MATCH**
   * all comparable candidates < `VISUAL_REJECT_BELOW` (0.25) → **NEW**
   * otherwise → **UNCERTAIN** (no merge, `pothole_id` stays NULL, a human resolves it via `POST /detections/{id}/resolve`)

Proximity alone can never produce a MATCH. Ranking score (explanatory only) = 0.6·visual + 0.3·proximity + 0.1·size-ratio.

**Why HOG with context.** On the real test video, same-track crops vs different-track crops had mean cosine 0.27 vs 0.15 (tight crop), 0.36 vs 0.17 (3× context). Embeddings from the YOLO backbone (`model.embed`) were rejected: 0.984 vs 0.956 (no separation). On synthetic variants of one pothole (brightness, ±perspective, blur, JPEG) cosine was 0.67–0.94; unrelated synthetic potholes 0.14–0.40. **The thresholds are provisional**: calibrated on one video's tracks and synthetic data, not on labelled real same/different pothole pairs. A 9° rotation already scores only ≈0.68; larger viewpoint changes will usually land in UNCERTAIN, which is the safe failure.

## 4. Transactions, idempotency, concurrency

All writes go through one function path (`create_report`, `add_location`, `resolve_uncertain`):

* The transaction first takes the DB write lock: `BEGIN IMMEDIATE` (SQLite) or `pg_advisory_xact_lock` (PostgreSQL, *implemented but not run here*). Candidate search, decision and insert therefore happen under the lock, so a second simultaneous report re-reads the first one's committed pothole (matching **re-validation**).
* `Idempotency-Key` header → UNIQUE column. Retries replay the original report; concurrent retries wait on the lock instead of failing with an integrity error (verified with a negative control: removing the lock makes the test fail with `UNIQUE constraint failed`).
* On any exception: rollback and delete evidence files written in that attempt.
* Honest finding: for the *matching* race alone, SQLite already serialises because the report INSERT precedes the candidate query; the explicit lock matters for idempotency and for PostgreSQL (MVCC reads don't block).
* shortcut: the Postgres lock is one global key; shard it by geo-cell when write volume demands.

## 5. Video pipeline (`video_service.py`)

`probe_video` (opens, FPS in 1–240, first frame decodes, duration ≤ `MAX_VIDEO_SECONDS`) → `process_video`: `grab()` every frame, `retrieve()` every `round(fps / sample_fps)`-th, RGB → **existing** `damage_detector.predict` → pothole class only → **existing** false-positive filter → tracker. Per track we keep only the best-confidence frame (JPEG + embedding) to bound memory. `VideoCapture` is released in `finally`; the uploaded temp file is deleted in `finally`; one undecodable frame is skipped, not fatal. Progress is persisted on `video_jobs` and polled by the UI. A track is **confirmed** after `VIDEO_MIN_TRACK_HITS` (2) sampled frames; unconfirmed tracks are shown separately and never submitted by default.

**Tracker** (`tracker.py`): constant-velocity box prediction, association by Hungarian assignment on `normalised centre distance − IoU`, accepted if IoU ≥ 0.1 *or* distance ≤ 2 box sides (small boxes move farther than their own size between sampled frames, giving IoU 0), `max_age` 3 sampled frames. Chosen over Ultralytics ByteTrack because: ByteTrack through `model.track` would bypass the project's detector wrapper and false-positive filter, its Kalman model assumes consecutive frames (we sample), and importing it auto-installs `lap`. Measured effect on the first test video: IoU-only → 10 tracks, with distance gate → 8 tracks (one 9-hit track instead of three fragments). shortcut: no appearance model; overlapping potholes can swap ids → upgrade to ByteTrack/BoT-SORT.

A video report applies **one** location to all submitted tracks (no per-frame GPS exists in the input).

## 6. Location handling
Browser Geolocation (explicit button, explanatory text, handles denied / unavailable / timeout / insecure context) or manual lat/lon (+ optional accuracy) or a map click. Server validation: finite numbers, lat ∈ [-90, 90], lon ∈ [-180, 180], (0, 0) rejected as a placeholder, accuracy 0–5000 m, source ∈ {gps, manual}. `verified` = GPS with accuracy ≤ 50 m. **No location → report saved with `location_status=pending`, detections `pending_location`, no pothole created, nothing on the map** until `POST /pothole-reports/{id}/location` supplies one.

## 7. PostGIS decision
Not adopted. At the current scale a B-tree box prefilter on `(lat, lon)` plus haversine on a handful of rows is sufficient and keeps SQLite as a zero-infrastructure default. PostGIS (GiST index, `ST_DWithin`, KNN) becomes worthwhile around 10⁵–10⁶ potholes, for polygon/ward queries, or for clustering; the migration path is `DATABASE_URL` → PostgreSQL plus a geography column and swapping `find_candidates`' prefilter.

## 8. Security controls
API key (Bearer or `X-API-Key`, constant-time compare) on every PitScout route; extension allow-lists; streaming size caps (images 50 MB, videos 200 MB) with partial-file cleanup; decode-based validation (not just extension); server-generated file names; per-IP upload rate limit (in-memory); coordinate validation; no coordinates in logs; generic error text for unexpected failures; Next proxy allow-list (admin/training endpoints are *not* reachable) with path-traversal rejection and server-side key. Known gaps are in the audit and in README "Known limitations".

## 9. Significant decisions
| Decision | Reason |
|---|---|
| Reuse existing pipeline/detector/filter; no model changes | Requirement: preserve image detection; accuracy cannot be claimed without evaluation |
| Own small tracker | See §5 |
| Detection-level (not report-level) linking | One photo can contain several distinct potholes |
| UNCERTAIN leaves detection unlinked | Never merge on doubt; human decision recorded in `match_meta.resolved_by` |
| Pending-location reports create no pothole | Never fabricate or silently assign a location |
| No `users` table | Backend has one shared API key; adding accounts means wiring the separate `app/` auth stack — product decision, see roadmap |
