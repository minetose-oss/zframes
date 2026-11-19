from __future__ import annotations

import os
import sys
from pathlib import Path

# Vercel can execute the detected entrypoint from a generated function bundle
# whose import path is not guaranteed to include this project root. Make the
# package directory explicit so local modules resolve reliably in production.
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Phase 1B.2 separates calculation from serving. The scheduler workflow runs
# from main (GitHub cron only runs on the default branch) and commits the
# validated snapshot to risk29-live-data. That branch is what this URL reads,
# and it is the Vercel production branch. It is not removed when the PR merges.
os.environ.setdefault(
    "RISK29_PUBLISHED_BASE_URL",
    "https://raw.githubusercontent.com/minetose-oss/zframes/risk29-live-data/risk29",
)
os.environ.setdefault("RISK29_DATA_DIR", "/tmp/risk29-engine")
os.environ.setdefault("RISK29_REFRESH_SECONDS", "300")

from risk29_engine.main import app  # noqa: E402,F401
