"""Coordinate validation and geodesic helpers (no external geo dependency)."""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

EARTH_RADIUS_M = 6_371_008.8
LOCATION_SOURCES = ("gps", "manual")
VERIFIED_MAX_ACCURACY_M = 50.0  # gps fix at least this good => "verified"
MAX_ACCURACY_M = 5_000.0


def validate_location(
    lat: Any, lon: Any, accuracy_m: Optional[Any] = None, source: str = "gps"
) -> Dict[str, Any]:
    """Return a normalised location dict or raise ValueError. Never invents values."""
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError("latitude and longitude must be numbers")
    if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
        raise ValueError("latitude and longitude must be finite")
    if not -90.0 <= lat_f <= 90.0:
        raise ValueError("latitude must be between -90 and 90")
    if not -180.0 <= lon_f <= 180.0:
        raise ValueError("longitude must be between -180 and 180")
    if lat_f == 0.0 and lon_f == 0.0:
        raise ValueError("(0, 0) is rejected as a likely placeholder, not a real location")
    if source not in LOCATION_SOURCES:
        raise ValueError(f"location source must be one of {LOCATION_SOURCES}")
    acc = None
    if accuracy_m not in (None, ""):
        try:
            acc = float(accuracy_m)
        except (TypeError, ValueError):
            raise ValueError("accuracy_m must be a number")
        if not math.isfinite(acc) or acc < 0 or acc > MAX_ACCURACY_M:
            raise ValueError(f"accuracy_m must be between 0 and {MAX_ACCURACY_M:.0f}")
    verified = source == "gps" and acc is not None and acc <= VERIFIED_MAX_ACCURACY_M
    return {"lat": lat_f, "lon": lon_f, "accuracy_m": acc, "source": source, "verified": verified}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bounding_box(lat: float, lon: float, radius_m: float) -> Dict[str, float]:
    """Degree box that contains the circle; used as an index-friendly SQL prefilter."""
    dlat = math.degrees(radius_m / EARTH_RADIUS_M)
    cos_lat = max(0.01, math.cos(math.radians(lat)))  # shortcut: poles degrade to a wide box
    dlon = min(180.0, dlat / cos_lat)
    return {"lat_min": lat - dlat, "lat_max": lat + dlat, "lon_min": lon - dlon, "lon_max": lon + dlon}
