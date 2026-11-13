# PitScout – Development Roadmap

Legend: ✅ done and verified (see TESTING_REPORT.md) · 🟡 done with caveats · ⬜ not done

## Phases (from the master prompt)
| Phase | Status | Notes |
|---|---|---|
| 1 Audit + architecture | ✅ | PROJECT_AUDIT.md, SYSTEM_ARCHITECTURE.md |
| 2 Improve/validate image detection | 🟡 | Preserved and re-verified (36 original tests pass; reused by the report flow). Detector itself **not** improved: a model improvement needs a real training/evaluation effort (see below) |
| 3 Video detection + tracking | ✅ | Sampling, progress, tracks, evidence, corrupt-file handling, resource release |
| 4 GPS | 🟡 | Capture/manual/map/validation/pending flow done; real browser permission prompt not exercised |
| 5 Duplicate identification | 🟡 | Built and tested end-to-end; **thresholds uncalibrated on real data** |
| 6 DB + backend integration | ✅ | Schema, Alembic baseline, transactional write path, APIs. PostgreSQL path untested |
| 7 Frontend integration | ✅ | /report /video /map /potholes /potholes/[id] /history |
| 8 Testing / debugging | ✅ | 39 new tests; lint, types, build clean |
| 9 Docs + deployment prep | 🟡 | Docs done; **no deployment performed or verified; Dockerfiles do not exist** |

## Recommended next steps (priority order)
1. **Model quality (blocks real-world usefulness).** Retrain well beyond 3 epochs on RDD2022 / a pothole-specific set at 640 px; evaluate on a held-out set; only then revisit the 0.15 confidence floor. Without this, most detections on real footage are low-confidence.
2. **Calibrate duplicate thresholds** on a labelled set of same/different pothole pairs (different phones, times, angles). Report precision/recall of MATCH vs the two thresholds; consider a learned embedding (e.g. a small CNN/DINO-style model) if HOG proves too weak. Add rotation-robustness if needed.
3. **Authentication & users.** Add a `users` table and per-user auth (the unused `app/` stack already has JWT/argon2) so reports, reviewers and rate limits are per user; protect `/static/evidence` with signed URLs; remove the hard-coded default key and fail startup without one in production.
4. **Per-frame GPS for video** (GPX/telemetry upload or live capture) so potholes from one drive get their own coordinates instead of one shared point.
5. **Deployment:** write the missing Dockerfiles, fix `docker-compose.yml`, run on PostgreSQL (verify the advisory-lock path and add a concurrency test against it), move uploads/evidence to object storage, move video jobs to a real queue (RQ/Celery) for multi-worker deployments, tighten CORS, use a keyed map tile provider.
6. **Large uploads on serverless hosts:** Vercel's request-body limit (≈4.5 MB) will block the proxy for videos; use direct-to-backend uploads with short-lived signed tokens.
7. **Consolidate the two inference pipelines** and move the `/inspect` page onto the strict one; remove fabricated fallbacks listed in the audit.
8. **Automated frontend tests** (Playwright) incl. geolocation permission mocking (grant/deny), the `uncertain` review flow and add-location-later.
9. PostGIS + clustering once volume justifies it (see architecture §7).
10. Re-verification workflow: scheduled re-checks of `reported` potholes, merge/split tooling for records, and an audit view of `match_meta`.

## Scope not delivered (explicit)
Users table/accounts · evaluation of detector accuracy · calibrated duplicate thresholds · PostgreSQL verification · deployment · real-device GPS verification · CI.
