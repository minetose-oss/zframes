from __future__ import annotations

import os

# Phase 1B.2 separates calculation from serving. GitHub Actions publishes a
# validated snapshot to the dedicated data branch; Vercel only reads those
# small JSON payloads and never waits on FRED/Treasury/OFR/LBMA at request time.
os.environ.setdefault(
    "RISK29_PUBLISHED_BASE_URL",
    "https://raw.githubusercontent.com/minetose-oss/zframes/risk29-live-data/risk29",
)
os.environ.setdefault("RISK29_DATA_DIR", "/tmp/risk29-engine")
os.environ.setdefault("RISK29_REFRESH_SECONDS", "300")

from risk29_engine.main import app  # noqa: E402,F401
