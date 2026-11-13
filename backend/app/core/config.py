import os
from pathlib import Path

# Load .env file if present
_env_file = Path(__file__).resolve().parent.parent.parent / ".env"
if _env_file.exists():
    with open(_env_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class Settings:
    APP_NAME: str = "RoadGuard AI"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = os.getenv("DEBUG", "False").lower() in ("true", "1")
    BASE_DIR: Path = BASE_DIR

    # Authentication
    API_KEY: str = os.getenv("ROADGUARD_API_KEY", "roadguard-production-api-key-2026")

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR}/roadguard.db")

    # Storage
    STORAGE_DIR: Path = BASE_DIR / "storage"
    UPLOADS_DIR: Path = BASE_DIR / "storage" / "uploads"
    ANNOTATED_DIR: Path = BASE_DIR / "storage" / "annotated"
    REPORTS_DIR: Path = BASE_DIR / "storage" / "reports"

    # Models
    MODELS_DIR: Path = BASE_DIR.parent / "models"
    DETECTION_MODEL_PATH: Path = BASE_DIR.parent / "models" / "detection" / "best.pt"
    AUTHENTICITY_MODEL_PATH: Path = BASE_DIR.parent / "models" / "authenticity" / "best.pt"
    ROAD_CLASSIFIER_PATH: Path = BASE_DIR.parent / "models" / "road_classifier" / "best.pt"

    # Upload & Image Validation limits
    MAX_FILE_SIZE_MB: int = 50
    MIN_IMAGE_DIMENSION: int = 64
    MAX_IMAGE_DIMENSION: int = 8192
    MAX_IMAGE_PIXELS: int = 178956970  # Decompression bomb guard
    ALLOWED_EXTENSIONS: set = {".jpg", ".jpeg", ".png", ".webp"}

    # CORS
    CORS_ORIGINS: list = ["*"]

    # Thresholds
    ROAD_CONFIDENCE_THRESHOLD: float = float(os.getenv("ROAD_CONFIDENCE_THRESHOLD", "0.50"))
    AUTHENTICITY_UNCERTAIN_LOW: float = float(os.getenv("AUTHENTICITY_UNCERTAIN_LOW", "0.40"))
    AUTHENTICITY_UNCERTAIN_HIGH: float = float(os.getenv("AUTHENTICITY_UNCERTAIN_HIGH", "0.65"))
    DETECTION_CONFIDENCE_THRESHOLD: float = float(os.getenv("DETECTION_CONFIDENCE_THRESHOLD", "0.15"))
    DETECTION_IOU_THRESHOLD: float = float(os.getenv("DETECTION_IOU_THRESHOLD", "0.45"))

    # Class-specific detection thresholds to minimize false positives
    CLASS_CONFIDENCE_THRESHOLDS: dict = {
        "pothole": 0.15,
        "manhole_cover": 0.15,
        "sewage_hole": 0.15,
        "longitudinal_crack": 0.14,
        "transverse_crack": 0.14,
        "alligator_crack": 0.14,
    }

    # --- PitScout: pothole identity / duplicate matching (all env-overridable) ---
    # shortcut: thresholds are provisional; calibrated only on track pairs from one test
    # video (see TESTING_REPORT.md). Recalibrate on labelled same/different pothole pairs.
    MATCH_BASE_RADIUS_M: float = float(os.getenv("MATCH_BASE_RADIUS_M", "15"))
    MATCH_MAX_RADIUS_M: float = float(os.getenv("MATCH_MAX_RADIUS_M", "100"))
    UNKNOWN_ACCURACY_M: float = float(os.getenv("UNKNOWN_ACCURACY_M", "25"))  # assumed when no accuracy given
    VISUAL_MATCH_MIN: float = float(os.getenv("VISUAL_MATCH_MIN", "0.60"))
    VISUAL_REJECT_BELOW: float = float(os.getenv("VISUAL_REJECT_BELOW", "0.25"))

    # --- PitScout: video ---
    EVIDENCE_DIR: Path = BASE_DIR / "storage" / "evidence"
    ALLOWED_VIDEO_EXTENSIONS: set = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
    MAX_VIDEO_SIZE_MB: int = int(os.getenv("MAX_VIDEO_SIZE_MB", "200"))
    MAX_VIDEO_SECONDS: int = int(os.getenv("MAX_VIDEO_SECONDS", "600"))
    VIDEO_DEFAULT_SAMPLE_FPS: float = float(os.getenv("VIDEO_DEFAULT_SAMPLE_FPS", "5"))
    VIDEO_MIN_TRACK_HITS: int = int(os.getenv("VIDEO_MIN_TRACK_HITS", "2"))
    UPLOAD_RATE_LIMIT_PER_MIN: int = int(os.getenv("UPLOAD_RATE_LIMIT_PER_MIN", "30"))

    # Severity thresholds
    SEVERITY_HIGH_AREA_RATIO: float = 0.05
    SEVERITY_CRITICAL_AREA_RATIO: float = 0.15


settings = Settings()
