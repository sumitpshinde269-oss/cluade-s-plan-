# PitScout – API Documentation

Base URL (backend): `http://localhost:8000` · Interactive docs: `/docs` · Frontend proxy: `/api/pitscout/<path>` (adds the key server-side).

**Auth:** every route below requires `Authorization: Bearer <ROADGUARD_API_KEY>` or `X-API-Key: <key>` → otherwise `401`.
**Errors:** `{"detail": "<message>"}` (or `{"detail": {"message", "stage", "pipeline_status"}}` for image rejections). Codes: `401` auth, `404` unknown id, `409` state conflict, `413` too large, `422` validation, `429` rate limited (uploads, default 30/min/IP), `503` (proxy only) backend unreachable.
**Optional headers on report creation:** `Idempotency-Key` (≤128 chars; retries replay the same report), `X-Reporter-Id` (≤64 chars, opaque).

## Image reports
### `POST /api/v1/pothole-reports` → `201`
`multipart/form-data`: `file` (jpg/jpeg/png/webp ≤ 50 MB, must decode), optional `latitude`, `longitude` (both or neither), `accuracy_m`, `location_source` (`gps`|`manual`, default `gps`).
Runs the existing inspection pipeline; non-road / AI-generated / corrupt images → `422` with `stage`. Potholes found are matched against existing records.
```json
{ "id": "…", "source": "image", "status": "processed|no_potholes",
  "location_status": "verified|unverified|pending",
  "location": {"lat":12.9716,"lon":77.5946,"accuracy_m":8,"source":"manual","verified":false},
  "detections": [{ "id":"…","pothole_id":"…|null","match_status":"new|matched|uncertain|pending_location",
     "confidence":0.30,"bbox":[x1,y1,x2,y2],"image_width":848,"image_height":480,
     "evidence_url":"/static/evidence/<report>/<sha>.jpg",
     "match_meta":{"reason":"…","thresholds":{…},"candidates":[{"pothole_id":"…","distance_m":2.0,"radius_m":33,"visual_sim":1.0,"size_ratio":1.0,"score":0.97}]}}],
  "summary": {"new":2,"matched":0,"uncertain":0,"pending_location":0},
  "idempotent_replay": false, "detector_candidates": 4 }
```
### `GET /api/v1/pothole-reports?limit=50&offset=0` · `GET /api/v1/pothole-reports/{id}`
Newest first / single report (same shape as above).
### `POST /api/v1/pothole-reports/{id}/location`
JSON `{"latitude","longitude","accuracy_m"?,"location_source"?}`. Only for `location_status=pending` (else `409`); resolves its pending detections. Returns the report.
### `POST /api/v1/detections/{detection_id}/resolve`
JSON `{"pothole_id": "<candidate id>" | null}` – human decision on an `uncertain` detection: link to one of its candidates, or `null` = it is a new pothole. `409` if not uncertain / not a candidate. Returns the report.

## Video
### `POST /api/v1/videos` → `202`
`multipart/form-data`: `file` (mp4/mov/avi/mkv/webm ≤ 200 MB, ≤ 600 s), `sample_fps` (0.5–30, default 5), optional `confidence` (0.05–0.95). Validated by actually opening/decoding it (`422` otherwise). Returns `{"id","status":"queued","video":{fps,frame_count,width,height,duration_s}}`. Processing runs in the background; the upload is deleted afterwards.
### `GET /api/v1/videos/{id}` / `GET /api/v1/videos`
`status` `queued|processing|completed|failed`, `progress` 0–1, `error`. When completed (field shape is real; the numbers below are illustrative):
```json
{ "result": { "video": {…,"stride":5,"sample_fps":5}, "sampled_frames":44, "frames_with_detections":16,
  "raw_detections":18, "total_unique_potholes":3, "unconfirmed_tracks":5, "min_track_hits":2,
  "tracks":[{ "track_id":6,"confirmed":true,"hits":9,"first_timestamp_s":5.5,"last_timestamp_s":7.9,
    "best_confidence":0.33,"mean_confidence":0.25,"best_frame_index":205,"best_bbox":[…],
    "evidence_url":"/static/evidence/video/<job>/track_6.jpg",
    "frames":[{"frame_index":160,"timestamp_s":5.84,"bbox":[…],"confidence":0.17}] }] } }
```
### `POST /api/v1/videos/{id}/report` → `201`
JSON `{"latitude"?,"longitude"?,"accuracy_m"?,"location_source"?,"track_ids"?: [int]}` (default: confirmed tracks). One location applies to all tracks. Honors `Idempotency-Key`. Returns a report (`source: "video"`, detections carry `track_id`, `frame_index`, `timestamp_s`).

## Pothole records
### `GET /api/v1/potholes?status=&bbox=lat_min,lon_min,lat_max,lon_max&limit=50&offset=0`
`{"total","items":[{id,lat,lon,lifecycle_status,verification_status,report_count,best_confidence,created_at,updated_at}]}`.
### `GET /api/v1/potholes/{id}`
Adds `detections` (with evidence + match metadata), `reports` (with location history) and `status_history`.
### `PATCH /api/v1/potholes/{id}/status`
JSON `{"status": "reported|verified|scheduled|repaired|rejected", "note"?}` → appends status history (`422` for an unknown status).
### `GET /api/v1/map/potholes?status=&limit=2000`
GeoJSON `FeatureCollection` of potholes with a location (rejected ones excluded); `properties`: `id, lifecycle_status, report_count, best_confidence, verification_status`.
### `GET /api/v1/pitscout/summary`
Real counts only: `{"potholes","potholes_by_status","reports","videos","detections_by_match_status"}`.

## Evidence files
`GET /static/evidence/<path>` (served by the backend, **unauthenticated like the existing `/static/uploads`**; paths contain a random id + content hash). The frontend reaches it via `/api/pitscout/evidence/<path>`.

## Unchanged pre-existing API
`/api/v1/inspect`, `/inspect/batch`, `/inspection/{id}`, `/api/v1/analysis/*`, `/api/v1/analytics/*`, `/api/v1/reports/*`, `/api/v1/datasets/*`, `/api/v1/training/*`, `/api/v1/models`, health endpoints – see `/docs`.

## Migrations
`cd backend && python -m alembic upgrade head` (reads `DATABASE_URL`). Baseline `0001` creates the whole backend schema. Databases already created by the app's startup `create_all` should be able to adopt it with `alembic stamp 0001` (**not tested**; only upgrade → drift check → downgrade → upgrade on a fresh database was run).
