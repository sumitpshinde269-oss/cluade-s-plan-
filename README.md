# PitScout — AI pothole detection, mapping and duplicate-aware reporting

PitScout detects potholes in **photos and videos**, ties them to **GPS locations**, and keeps **one record per physical pothole**: a second report of the same pothole is linked to the existing record as extra evidence instead of creating a duplicate. (The codebase was built as *RoadGuard AI*; some internal names still say so.)

> **Read this first — model quality.** The bundled detector (`models/detection/best.pt`, YOLOv8n) comes from a 3-epoch training run with recorded mAP50 ≈ 0.146 and recall ≈ 0.143. It finds few potholes and with low confidence. PitScout's workflow is built and tested around it, but **no detection-accuracy claim is made**. See `DEVELOPMENT_ROADMAP.md`.

## What it does
| Area | Pages / API |
|---|---|
| Report a pothole from a photo (+ location) | `/report`, `POST /api/v1/pothole-reports` |
| Video detection with sampling, progress, tracking (one pothole across frames = one track) and per-track evidence | `/video`, `POST /api/v1/videos` |
| GPS from the browser (explicit permission), manual coordinates or map click; missing location ⇒ *pending verification* | `LocationPicker`, `POST /pothole-reports/{id}/location` |
| Duplicate handling: **MATCH** (linked), **NEW**, **UNCERTAIN** (flagged for a human; never auto-merged) | `/report`, `/potholes/[id]`, `POST /detections/{id}/resolve` |
| Pothole records, details, evidence, location + status history, lifecycle updates | `/potholes`, `/potholes/[id]` |
| Interactive map (OpenStreetMap) and detection history | `/map`, `/history` |
| Original RoadGuard inspection pages (kept) | `/inspect`, `/dashboard`, `/analytics`, `/datasets`, `/training`, `/reports/[id]` |

Docs: [PROJECT_AUDIT](PROJECT_AUDIT.md) · [SYSTEM_ARCHITECTURE](SYSTEM_ARCHITECTURE.md) · [API_DOCUMENTATION](API_DOCUMENTATION.md) · [DEVELOPMENT_ROADMAP](DEVELOPMENT_ROADMAP.md) · [TESTING_REPORT](TESTING_REPORT.md)

## Install

Requirements: Python 3.11+ (tested on 3.14), Node 20–24, ~2 GB disk for PyTorch.

```bash
# backend (inspection + PitScout API)
cd backend
python -m pip install -r requirements.txt

# frontend
cd ../frontend
npm install
```
(The *root* `requirements.txt` belongs to the separate, currently unused `app/` auth stack and does not install the ML dependencies.)

## Configure (environment)
Copy the entries documented in `.env.example` (PitScout section):

* `backend/.env` → `ROADGUARD_API_KEY=<long random string>` (and optionally `DATABASE_URL`, thresholds).
* `frontend/.env.local` → **the same** `ROADGUARD_API_KEY=<same value>` and `BACKEND_URL=http://localhost:8000`. The Next.js server proxy adds the key; it is never sent to the browser. **If the two keys differ, every request fails with 401.**
* If neither is set, both fall back to a built-in default key and the backend logs a warning. Do not deploy like that.

## Run
```bash
# terminal 1
cd backend && python -m uvicorn app.main:app --port 8000
# terminal 2
cd frontend && npm run dev -- --port 3000
```
Open http://localhost:3000 · API docs http://localhost:8000/docs. Tables are created on startup; for versioned schema changes use Alembic:

```bash
cd backend && python -m alembic upgrade head      # DATABASE_URL decides the target
```

Geolocation in browsers only works on `https://` or `http://localhost`. If you add a `Permissions-Policy` header, allow `geolocation=(self)`.

## Test
```bash
cd backend && python -m pytest tests -q            # 75 tests (uses docs/testts/*.mp4 for real-model tests)
cd frontend && npx tsc --noEmit && npm run build
```
Results and limits of what they prove: [TESTING_REPORT.md](TESTING_REPORT.md).

## Deployment
**Not deployed or verified.** `docker-compose.yml` references `backend/Dockerfile` and `frontend/Dockerfile`, which do not exist yet. Minimum for a real deployment: strong unique API key, PostgreSQL (`DATABASE_URL`), persistent volume or object storage for `backend/storage/`, restricted CORS, HTTPS, a keyed map-tile provider, a job queue instead of in-process background tasks, and signed/authenticated evidence URLs. Details in `DEVELOPMENT_ROADMAP.md`.

## Known limitations
* Weak detector (see above); duplicate thresholds are provisional and untuned on real same/different pothole pairs; visual matching is rotation/viewpoint sensitive, so such cases fall back to *UNCERTAIN* (safe, but needs a human).
* One location per video report: all potholes from one clip share the same coordinates.
* No user accounts: one shared API key, `reporter_id` is an opaque header. Evidence/uploads are served unauthenticated by UUID path.
* Tracking is IoU + velocity with no appearance model; overlapping potholes can swap ids.
* In-process background tasks (a restart loses running video jobs); in-memory rate limiter; one global DB write lock per report.
* PostgreSQL path (advisory lock) and real-device GPS prompt were not exercised.
* Pre-existing issues (fabricated fallbacks in a few old UI paths, two inference pipelines, permissive CORS) are listed in `PROJECT_AUDIT.md`.

## Original RoadGuard pipeline (unchanged)
Strict sequential inspection: image validation → road/non-road → authenticity (AI-generated) → YOLO detection → false-positive filter → geometry → severity → probable causes. Classes follow the CRDDC RDD2022 benchmark.

### Dataset & training
RoadGuard uses the **RDD2022** dataset (CC BY 4.0).
```bash
python -m ml.datasets.convert_voc_to_yolo --input datasets/raw/rdd2022 --output datasets/processed/rdd2022
python -m ml.detection.train --dataset datasets/processed/rdd2022 --epochs 50 --batch 8 --device cpu
```
Place the resulting `best.pt` in `models/detection/best.pt`; the backend loads it automatically.

## License & attributions
Dataset: RDD2022 / Sekilab (CC BY 4.0). Map tiles © OpenStreetMap contributors. Platform: MIT.
