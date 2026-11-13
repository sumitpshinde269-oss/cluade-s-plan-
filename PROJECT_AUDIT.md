# PitScout – Project Audit

Audit of the repository as found at commit `2bfc008` (before PitScout work), plus the state after this work.
Everything below was checked by reading the code, running it, or running tests; items I could not verify are marked *unverified*.

## 1. What the repository is

The repository is named **RoadGuard AI** internally (README, package names, API title). It is the codebase PitScout is being built on; the visible brand in the UI was changed to *PitScout* during this work (text only: nav, page title, footer).

| Layer | Technology (verified from code / `package.json`) |
|---|---|
| Frontend | Next.js 16.4.6 (App Router, `cacheComponents` on), React 19.3, TypeScript 5, Tailwind 4.3.3, framer-motion, recharts, react-dropzone, leaflet + react-leaflet (installed but **unused before this work**) |
| Inspection backend (`backend/`) | FastAPI, SQLAlchemy 2 (sync), SQLite in WAL mode (`backend/roadguard.db`), Pillow, OpenCV, PyTorch, Ultralytics YOLO |
| Second backend (`app/`) | FastAPI + JWT auth, users/refresh tokens, argon2, rate-limit/security middleware, Alembic (root `migrations/`), PostgreSQL-ready. **Not connected to the frontend or to `backend/`.** Root `requirements.txt` and root `alembic.ini` belong to this stack. |
| Model | `models/detection/best.pt`, YOLOv8n, classes `Pothole`, `Crack`, `Manhole` |
| Tests | `backend/tests/` (36 tests, all passing at audit time) |

### The model (important)
`models/runs/roadguard_kaggle_train/` records the training run that most likely produced `best.pt` (*unverified link*): **3 epochs, 416 px, YOLOv8n**. Final recorded metrics: precision 0.78, **recall 0.143, mAP50 0.146**, mAP50-95 0.050. This is a very weakly trained detector. On the two real test videos it produced low-confidence (0.15–0.33), small boxes on a gravel road. Nothing in this work changes the model, and no accuracy improvement is claimed.

### Image detection pipeline (backend)
`POST /api/v1/inspect` → `InspectionPipeline.process_image`: validation (EXIF, dimension limits) → road/non-road classifier → authenticity (AI-generated) classifier → YOLO detection → false-positive filter → geometry → severity → probable causes. Rejections are explicit. Results are stored in `inspections`/`analyses`.

A **second, older pipeline** (`services/*` + `workers/job_manager.py`, exposed under `/api/v1/analysis/*`) also exists. **The existing `/inspect` UI page calls the older `/analysis` path**, not the stricter `/inspect` pipeline.

## 2. Status of requested capabilities

| Capability | Before this work | After this work |
|---|---|---|
| Image upload + detection + boxes + confidence + multi-detection | **Implemented** (both pipelines; `/inspect` page) | Preserved untouched; reused by the new report flow |
| Image validation / invalid image handling | Implemented (type, size, decode, min dimension) | Reused |
| Video detection | **Missing** (no video code existed) | Implemented: `video_service.py` |
| Frame sampling / progress / summary / corrupt-file handling | Missing | Implemented |
| Object tracking (one pothole across frames) | Missing | Implemented (IoU + velocity + Hungarian, see ARCHITECTURE) |
| GPS capture, manual entry, validation, map | **Missing** (only a header in the unused `app/` stack that *blocks* geolocation) | Implemented |
| Duplicate identification (geo + visual + decision) | **Missing** | Implemented (`duplicate_service.py`) |
| Canonical pothole / report / evidence / location / status schema | Missing (`inspections` only) | Implemented + Alembic baseline migration |
| Pothole records UI, map, details, history | Missing | Implemented |
| Users table | Exists only in the unused `app/` stack | **Not added** to `backend/` (see limitations) |

## 3. Defects and weaknesses found

Pre-existing (verified):

1. **Hardcoded default API key** `roadguard-production-api-key-2026` in `backend/app/core/config.py` and in the frontend proxy routes. Startup now logs a warning when it is in use; the default itself was left so the project still runs.
2. **Frontend/backend key mismatch is silent.** `backend/.env` can set a custom key while `frontend/.env.local` does not, so every proxied call fails with 401 (hit during this work). Documented in `.env.example` / README.
3. **ML dependencies undeclared.** No requirements file covered `backend/` (the root file is for `app/`). Added `backend/requirements.txt`.
4. **`docker-compose.yml` references `backend/Dockerfile` and `frontend/Dockerfile`, which do not exist.** Deployment via compose does not work; not fixed here.
5. **Two parallel inference pipelines** (see above); the UI uses the weaker one.
6. **Fabricated data in the UI:** `/api/v1/reports/[id]` returns invented road/cost data when the backend is down; the `/inspect` page fills in default severity, causes and recommended actions when the API omits them; the home page shows hard-coded `94.8%` / `89.2%` demo labels. Not changed (outside this scope) but the new PitScout pages show **only real API data** and render empty states otherwise.
7. **CORS** allows any origin with credentials (`allow_origin_regex=^https?://.*`).
8. `/static/uploads` and `/static/annotated` are served **without authentication** (UUID file names are the only protection). The new `/static/evidence` mount follows the same pattern.
9. `/inspect/batch` skips size/type validation and persistence; `datetime.utcnow()` is deprecated (16 warnings in the suite).
10. The shared YOLO predictor had no lock; concurrent requests could interleave. A lock was added around `predict` (needed once background video jobs share the model).

Introduced-risk notes: `ultralytics.trackers` auto-installs `lap` on import (it did so in this environment). PitScout's tracker does not depend on it.

## 4. Uncommitted changes found that were NOT made by this work

At the end of the session (files modified 16:47–16:48, while this work was documenting) the working tree contained edits to `frontend/src/app/api/v1/{inspect,analysis/image,analysis/[id]/result}/route.ts`, `frontend/src/app/inspect/page.tsx` and a new `frontend/src/lib/serverlessInspection.ts`. They were not written by this work and were left untouched. What they do (read from the code):

* The old routes no longer default `BACKEND_URL` to `http://localhost:8000`; when it is unset **or the backend call fails**, they call `performServerlessInspection`, which **fabricates an inspection result**: one detection whose class is chosen from the file name / aspect ratio, a hard-coded confidence (0.88), severity, causes, authenticity "natural 0.94" and `model_ready: true`. The `analysis/[id]/result` route even feeds it a 100-byte dummy buffer.
* Previously these routes returned an honest `503` ("backend unreachable, no detections fabricated").
* Effect: on the original `/inspect` page, any backend outage or missing `BACKEND_URL` now shows made-up potholes as if they were model output. This contradicts the project rule against fake functionality. It does **not** affect the PitScout pages (`/report`, `/video`, `/map`, `/potholes`, `/history`), whose proxy is separate and returns `503` with a clear message when the backend is down.
* Recommendation: restore the honest `503` behaviour (or label any demo output unmistakably as simulated and never persist it). Verified after these edits appeared: `tsc`, ESLint on the new files and `npm run build` still pass.

## 5. Integrations / MCP / plugins
No external service was connected. OpenStreetMap raster tiles are loaded directly by the browser (no key required; fine for development, use a keyed tile provider for production traffic). No cloud storage, database service or deployment target was configured or used.
