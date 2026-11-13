"""PitScout schema: Pothole -> Reports -> DetectionResults/EvidenceFiles, Locations, StatusHistory.

Identity (Pothole) is separate from submissions (PotholeReport / DetectionResult), which are
never deleted or rewritten when a duplicate is linked. shortcut: no Users table; reporter_id
is an opaque string (the backend currently has a single shared API key, no user accounts).
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import relationship

from app.database.base import Base, gen_uuid, now_utc

LIFECYCLE = ("reported", "verified", "scheduled", "repaired", "rejected")


class Pothole(Base):
    __tablename__ = "potholes"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    updated_at = Column(DateTime, default=now_utc, onupdate=now_utc, nullable=False)
    lat = Column(Float, nullable=False)  # canonical position = first report's; every report's fix is in locations
    lon = Column(Float, nullable=False)
    lifecycle_status = Column(String(16), default="reported", nullable=False)
    verification_status = Column(String(16), default="unverified", nullable=False)  # unverified | verified
    report_count = Column(Integer, default=1, nullable=False)
    best_confidence = Column(Float, nullable=False)

    detections = relationship("DetectionResult", back_populates="pothole")
    history = relationship("StatusHistory", back_populates="pothole", order_by="StatusHistory.created_at")

    __table_args__ = (Index("ix_potholes_lat_lon", "lat", "lon"), Index("ix_potholes_status", "lifecycle_status"))


class PotholeReport(Base):
    __tablename__ = "pothole_reports"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    source = Column(String(8), nullable=False)  # image | video
    reporter_id = Column(String(64), nullable=True)
    idempotency_key = Column(String(128), unique=True, nullable=True)
    video_job_id = Column(String(36), nullable=True)
    status = Column(String(16), nullable=False)  # processed | no_potholes
    location_status = Column(String(12), nullable=False)  # verified | unverified | pending
    original_filename = Column(String(255), nullable=True)

    detections = relationship("DetectionResult", back_populates="report", cascade="all, delete-orphan")
    evidence = relationship("EvidenceFile", back_populates="report", cascade="all, delete-orphan")
    locations = relationship("Location", back_populates="report", cascade="all, delete-orphan")


class Location(Base):
    __tablename__ = "locations"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    # One fix per report (the capturing device's position). A pothole's location history is
    # derived: locations -> reports -> detection_results.pothole_id.
    report_id = Column(String(36), ForeignKey("pothole_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    accuracy_m = Column(Float, nullable=True)
    source = Column(String(8), nullable=False)  # gps | manual
    verified = Column(Boolean, default=False, nullable=False)

    report = relationship("PotholeReport", back_populates="locations")


class EvidenceFile(Base):
    __tablename__ = "evidence_files"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    report_id = Column(String(36), ForeignKey("pothole_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(16), nullable=False)  # image | video_frame
    path = Column(Text, nullable=False)  # relative to EVIDENCE_DIR
    sha256 = Column(String(64), nullable=False)

    report = relationship("PotholeReport", back_populates="evidence")


class DetectionResult(Base):
    __tablename__ = "detection_results"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    report_id = Column(String(36), ForeignKey("pothole_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    pothole_id = Column(String(36), ForeignKey("potholes.id"), nullable=True, index=True)  # NULL until resolved
    evidence_id = Column(String(36), ForeignKey("evidence_files.id"), nullable=True)
    confidence = Column(Float, nullable=False)
    bbox = Column(JSON, nullable=False)  # [x1, y1, x2, y2] in evidence image pixels
    image_width = Column(Integer, nullable=False)
    image_height = Column(Integer, nullable=False)
    area_ratio = Column(Float, nullable=False)
    embedding = Column(JSON, nullable=True)
    frame_index = Column(Integer, nullable=True)
    timestamp_s = Column(Float, nullable=True)
    track_id = Column(Integer, nullable=True)
    match_status = Column(String(16), nullable=False)  # matched | new | uncertain | pending_location
    match_meta = Column(JSON, nullable=True)  # decision, reasons, ranked candidates with signal values

    report = relationship("PotholeReport", back_populates="detections")
    pothole = relationship("Pothole", back_populates="detections")


class StatusHistory(Base):
    __tablename__ = "status_history"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    pothole_id = Column(String(36), ForeignKey("potholes.id"), nullable=False, index=True)
    from_status = Column(String(16), nullable=True)
    to_status = Column(String(16), nullable=False)
    note = Column(Text, nullable=True)
    actor = Column(String(64), nullable=True)

    pothole = relationship("Pothole", back_populates="history")


class VideoJob(Base):
    __tablename__ = "video_jobs"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=now_utc, nullable=False)
    updated_at = Column(DateTime, default=now_utc, onupdate=now_utc, nullable=False)
    status = Column(String(12), default="queued", nullable=False)  # queued | processing | completed | failed
    progress = Column(Float, default=0.0, nullable=False)  # 0..1
    original_filename = Column(String(255), nullable=True)
    params = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)  # summary + tracks (tracks carry embeddings; stripped in API output)
    error = Column(Text, nullable=True)
