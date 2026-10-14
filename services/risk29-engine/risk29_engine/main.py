from __future__ import annotations

import os
from datetime import datetime

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from .briefing import Risk29MaterialAlert, Risk29ThaiBrief, build_material_alert, build_thai_brief
from .engine import Risk29Engine
from .models import Risk29History, Risk29Registry, Risk29Snapshot
from .published import PublishedSnapshotClient
from .registry import build_registry
from .sources import PublicSourceClient

is_vercel = os.getenv("VERCEL") == "1"
source_client = PublicSourceClient(
    # Local/dev can calculate on demand. Serverless production uses the
    # precomputed publication path below, so these limits are only a fallback.
    timeout_seconds=float(
        os.getenv("RISK29_HTTP_TIMEOUT_SECONDS", "2.5" if is_vercel else "20")
    ),
    retry_attempts=int(
        os.getenv("RISK29_HTTP_RETRY_ATTEMPTS", "1" if is_vercel else "2")
    ),
)
engine = Risk29Engine(source_client)

published_base_url = os.getenv("RISK29_PUBLISHED_BASE_URL", "").strip()
published_client = (
    PublishedSnapshotClient(
        published_base_url,
        timeout_seconds=float(os.getenv("RISK29_PUBLISHED_TIMEOUT_SECONDS", "4")),
    )
    if published_base_url
    else None
)

app = FastAPI(
    title="Risk29 Engine",
    version="0.1.2",
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
        "dataMode": "published" if published_client is not None else "live",
    }


@app.get("/risk29/registry.json", response_model=Risk29Registry)
def registry(response: Response) -> Risk29Registry:
    response.headers["Cache-Control"] = "public, max-age=300, s-maxage=3600"
    return build_registry(engine.config)


@app.get("/risk29/latest.json", response_model=Risk29Snapshot)
async def latest(response: Response) -> Risk29Snapshot:
    if published_client is None:
        response.headers["Cache-Control"] = "no-store"
        return await engine.latest()

    response.headers["Cache-Control"] = "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
    try:
        return await published_client.latest()
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Published Risk29 snapshot is temporarily unavailable",
        ) from exc


@app.get("/risk29/brief-th.json", response_model=Risk29ThaiBrief)
async def thai_brief(response: Response) -> Risk29ThaiBrief:
    if published_client is not None:
        response.headers["Cache-Control"] = "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
        try:
            return await published_client.thai_brief()
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Published Risk29 Thai brief is temporarily unavailable",
            ) from exc

    response.headers["Cache-Control"] = "no-store"
    snapshot = await engine.latest()
    history = engine.history(365)
    generated_at_ms = int(datetime.fromisoformat(
        snapshot.generatedAt.replace("Z", "+00:00")
    ).timestamp() * 1000)
    previous = next(
        (point for point in reversed(history.points) if point.time < generated_at_ms),
        None,
    )
    return build_thai_brief(snapshot, previous)


@app.get("/risk29/alert.json", response_model=Risk29MaterialAlert)
async def material_alert(response: Response) -> Risk29MaterialAlert:
    if published_client is not None:
        response.headers["Cache-Control"] = "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
        try:
            return await published_client.material_alert()
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Published Risk29 material alert is temporarily unavailable",
            ) from exc

    response.headers["Cache-Control"] = "no-store"
    previous_snapshot = engine.store.load_latest()
    snapshot = await engine.latest()
    history = engine.history(365)
    generated_at_ms = int(datetime.fromisoformat(
        snapshot.generatedAt.replace("Z", "+00:00")
    ).timestamp() * 1000)
    previous = next(
        (point for point in reversed(history.points) if point.time < generated_at_ms),
        None,
    )
    return build_material_alert(
        snapshot,
        previous,
        previous_snapshot=previous_snapshot,
    )


@app.get("/risk29/history.json", response_model=Risk29History)
async def history(
    response: Response,
    days: int = Query(default=30, ge=1, le=365),
) -> Risk29History:
    if published_client is None:
        response.headers["Cache-Control"] = "no-store"
        return engine.history(days)

    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=300, stale-while-revalidate=900"
    try:
        return await published_client.history(days)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Published Risk29 history is temporarily unavailable",
        ) from exc
