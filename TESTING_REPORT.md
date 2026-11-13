# PitScout – Testing Report

Run on Windows 11, Python 3.14.0, CPU-only PyTorch 2.14.1, Ultralytics 8.4.211, OpenCV 5.0.0.93, SciPy 1.18.1, SQLAlchemy 2.1.8, Node (Next.js 16.4.6).

## Results

| Check | Command | Result |
|---|---|---|
| Backend tests, whole suite | `cd backend && python -m pytest tests -q` | **75 passed** (36 pre-existing + 39 new), 0 failed, 0 skipped (wall time varied between 25 s and 130 s across runs on this machine; cause not investigated) |
| New: core logic | `tests/test_pitscout_core.py` | 31 passed |
| New: API + end-to-end | `tests/test_pitscout_api.py` | 8 passed |
| Frontend type-check | `cd frontend && npx tsc --noEmit` | exit 0 |
| Frontend lint (new files) | `npx eslint src/app/{report,video,map,history,potholes} src/components/pitscout src/lib/pitscout.ts src/app/api/pitscout` | exit 0, no findings |
| Frontend production build | `npm run build` | exit 0, 25 pages |
| Migration | `alembic upgrade head` → `alembic check` → `downgrade base` → `upgrade head` (temp DB) | clean, "No new upgrade operations detected" |

Not run: PostgreSQL (advisory-lock path, `asyncpg`/`psycopg2` URL), Docker (no Dockerfiles exist), any deployment, Playwright/Cypress (no frontend test runner is configured; frontend workflows were verified manually, below).

## Mapping to the required tests

| Required case | Test(s) | Notes |
|---|---|---|
| Image detection | existing 36 tests + `test_image_report_dedup_end_to_end`, `test_report_input_validation` | Real model, real frame (video frame 195: 2 pothole detections) |
| Video frame processing | `test_process_video_tracks_reduce_detections_and_release_file`, `test_video_job_api_flow_and_report`, `test_video_upload_validation` | Real MP4; corrupt/unsupported files rejected; capture handle released (the file can be deleted on Windows right after); temp upload removed |
| Object tracking | `test_tracker_*` (unit), video tests (real footage: raw detections > tracks ≥ 1) | |
| GPS validation | `test_invalid_coordinates_rejected` (9 cases), `test_valid_location_and_verification_rules`, API 422 cases | |
| Geospatial matching | `test_haversine_and_bounding_box`, `test_far_apart_identical_looking_potholes_stay_separate` | |
| Visual similarity | `test_same_pothole_survives_lighting_and_angle_change`, `test_different_potholes_score_below_match_threshold`, `test_tiny_crop_refused` | **Synthetic textures** + real-video measurements; no labelled real pairs |
| **TEST 1** same pothole, same place, different user | `test_same_pothole_same_location_different_user_reuses_record` (DB) and `test_image_report_dedup_end_to_end` (full stack) | one pothole row, `report_count=2`, originals + evidence + both locations kept |
| **TEST 2** different potholes close together | `test_different_potholes_close_together_are_not_merged`, `test_closeness_alone_never_merges`, `test_two_potholes_in_one_report_are_never_merged_with_each_other` | |
| **TEST 3** lighting / angle | `test_same_pothole_different_lighting_and_angle_matches` | Synthetic brightness+perspective+blur+JPEG variant. 9° rotation scores ≈0.68 vs 0.60 threshold (thin margin) |
| **TEST 4** GPS unavailable | `test_gps_unavailable_report_pending_then_resolved`, `test_image_report_without_gps_stays_pending_then_gets_location` | report valid, `pending`, no pothole, not on map; location added later resolves it |
| **TEST 5** one pothole across frames | `test_tracker_same_pothole_across_frames_is_one_track` + real video test | On the first test video: 18 raw detections → 8 tracks (3 confirmed, 5 unconfirmed) |
| **TEST 6** simultaneous reports | `test_concurrent_reports_of_same_pothole_create_one_record` (8 threads → 1 new, 7 matched, 1 pothole, `report_count=8`), `test_concurrent_retries_with_same_idempotency_key_create_one_report` | See "Test quality notes" |
| Database transactions | `test_failed_transaction_rolls_back_and_removes_evidence`, `test_invalid_location_persists_nothing`, `test_idempotency_key_prevents_duplicate_report` | |
| API validation / auth | `test_requires_api_key`, `test_report_input_validation`, `test_empty_database_endpoints_return_empty_not_fake` | |
| Frontend workflows | manual browser run (below) | not automated |

## Test quality notes (what the tests do and do not prove)

* **Negative control for concurrency.** With the write lock disabled, the idempotency-race test fails (`sqlite3.IntegrityError: UNIQUE constraint failed`); with it, it passes. The *matching* race test (TEST 6) passed even with the explicit lock disabled, because on SQLite the report INSERT already takes the single write lock before candidates are read. So TEST 6 verifies the behaviour, but on SQLite it does not isolate my lock; the explicit lock is what protects idempotency and what PostgreSQL relies on (untested here).
* A first version of the progress assertion in the video test was wrong (progress legitimately starts at 0.0); it was fixed in the test, not in the code.
* API tests run the real YOLO model and real pipeline on frames from `docs/testts/*.mp4`; they skip if that footage is absent. They use a temporary database and clean evidence/uploads afterwards (verified: no leftovers).
* Detection results on that footage are **low-confidence (0.15–0.34) on an unpaved gravel road**; the tests assert plumbing and consistency, not that those detections are real potholes. **No detection accuracy is claimed.** The recorded training run behind `best.pt` is 3 epochs, mAP50 ≈ 0.146, recall ≈ 0.143.

## Manual browser verification (local dev servers, scratch database, test data)

Done in the in-app browser against `next dev` + `uvicorn`:

* `/report`: uploaded a real frame, entered manual coordinates, submitted → "2 new" with boxes drawn on the photo; a second submission 2 m away → "0 new · 2 duplicate(s) linked" with reason text.
* `/potholes`: real counts (2 potholes, 2 reports, `report_count=2` each); `/potholes/[id]`: evidence, "2.0 m apart (limit 33 m) · visual similarity 1.00", location history with both fixes, status history, status form; `/map`: both markers at the entered location; `/history`: 3 reports.
* `/video`: uploaded the 1.8 MB clip → progress → "3 unique potholes tracked, 5 unconfirmed, 18 raw detections, 44 frames analysed, 16 frames with potholes", per-track evidence and frame table; submit as report → "3 new".
* Mobile (375 px): no horizontal overflow on `/report`, `/potholes`, `/history`, `/video`, `/map`; hamburger navigation. Browser console: no errors.
* Not exercised in a browser: the real **"Use my current location"** permission prompt and its denied/unavailable branches (the in-app browser cannot grant a real GPS fix; the code paths are written but unverified), the `uncertain` review buttons, and the add-location-later form.
* A real finding from this session: the frontend proxy returned 401 until its server-side key matched `backend/.env` (documented).
