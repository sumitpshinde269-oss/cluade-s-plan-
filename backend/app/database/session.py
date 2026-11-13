from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from app.core.config import settings
from app.database.base import Base
import logging

logger = logging.getLogger("roadguard.db")

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    echo=settings.DEBUG,
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    """Enable WAL mode and foreign keys on every new SQLite connection."""
    if not _is_sqlite:
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db() -> None:
    """Create all tables if they don't exist."""
    # Import models so they are registered on Base.metadata
    import app.models.database  # noqa: F401
    import app.models.pitscout  # noqa: F401
    Base.metadata.create_all(bind=engine)
    logger.info("Database initialised (SQLite WAL mode).")


def get_db():
    """FastAPI dependency — yields a DB session and closes it afterwards."""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
