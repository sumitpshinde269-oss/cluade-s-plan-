"""Alembic environment for the PitScout/RoadGuard backend (the `backend/` stack)."""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.core.config import settings
from app.database.base import Base
import app.models.database  # noqa: F401  (register tables)
import app.models.pitscout  # noqa: F401

config = context.config
fileConfig(config.config_file_name)
target_metadata = Base.metadata
url = settings.DATABASE_URL
sqlite = url.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, render_as_batch=sqlite)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(url)
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=sqlite, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_offline() if context.is_offline_mode() else run_migrations_online()
