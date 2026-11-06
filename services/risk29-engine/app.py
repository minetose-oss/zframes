from __future__ import annotations

import os

# Vercel functions have a writable /tmp filesystem; keep Phase 1B's bounded JSON
# snapshot/history store there. Persistent history moves to a real database in a
# later phase.
os.environ.setdefault("RISK29_DATA_DIR", "/tmp/risk29-engine")
os.environ.setdefault("RISK29_REFRESH_SECONDS", "300")

from risk29_engine.main import app  # noqa: E402,F401
