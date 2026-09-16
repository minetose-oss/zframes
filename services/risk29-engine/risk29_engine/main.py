from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .engine import Risk29Engine
from .models import Risk29History, Risk29Snapshot
from .sources import PublicSourceClient

source_client = PublicSourceClient(
    timeout_seconds=float(os.getenv("RISK29_HTTP_TIMEOUT_SECONDS", "20"))
)
engine = Risk29Engine(source_client)

app = FastAPI(
    title="Risk29 Engine",
    version="0.1.0",
    description="Versioned Risk29 calculation service consumed by zframes.",
)

# Local/dev friendliness. Production should narrow this at the reverse proxy or
# replace it with an explicit dashboard origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("RISK29_CORS_ORIGINS", "*").split(",")],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {
        "status": "ok",
        "modelVersion": engine.model_version,
        "thresholdVersion": engine.threshold_version,
    }


@app.get("/risk29/latest.json", response_model=Risk29Snapshot)
async def latest() -> Risk29Snapshot:
    return await engine.latest()


@app.get("/risk29/history.json", response_model=Risk29History)
def history(days: int = Query(default=30, ge=1, le=365)) -> Risk29History:
    return engine.history(days)
