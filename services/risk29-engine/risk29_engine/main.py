from __future__ import annotations

import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .engine import Risk29Engine
from .models import Risk29History, Risk29Snapshot
from .sources import PublicSourceClient

is_vercel = os.getenv("VERCEL") == "1"
# Vercel entrypoint imports this module directly; app.py defaults do not run.
# The package directory is read-only in serverless, so snapshots must use /tmp.
if is_vercel:
    os.environ.setdefault("RISK29_DATA_DIR", "/tmp/risk29-engine")
    os.environ.setdefault("RISK29_REFRESH_SECONDS", "300")
source_client = PublicSourceClient(
    # Vercel must never wait on slow public upstreams long enough to hit the
    # function invocation ceiling. On serverless we prefer a visible
    # `unavailable` signal over a 504 for the entire snapshot.
    timeout_seconds=float(
        os.getenv("RISK29_HTTP_TIMEOUT_SECONDS", "2.5" if is_vercel else "20")
    ),
    retry_attempts=int(
        os.getenv("RISK29_HTTP_RETRY_ATTEMPTS", "1" if is_vercel else "2")
    ),
)
engine = Risk29Engine(source_client)

app = FastAPI(
    title="Risk29 Engine",
    version="0.1.1",
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


@app.get("/risk29/brief-th.json")
async def brief_th() -> dict:
    """Thai brief derived from the same live snapshot as latest.json."""
    snapshot = await engine.latest()
    score = snapshot.score
    unavailable = score is None or snapshot.state == "unavailable"
    ranked = sorted(
        (signal for signal in snapshot.signals if signal.riskScore is not None),
        key=lambda signal: signal.riskScore,
        reverse=True,
    )[:3]
    drivers = [f"{signal.label} (risk {signal.riskScore:.0f})" for signal in ranked]
    incomplete = snapshot.health.available < snapshot.health.total
    return {
        "schemaVersion": "1",
        "generatedAt": snapshot.generatedAt,
        "score": score,
        "state": snapshot.state,
        "posture": "ข้อมูลไม่เพียงพอสำหรับตัดสินใจ" if unavailable else
                   ("ระมัดระวังความเสี่ยง" if snapshot.state in ("warning", "alert") else "เลือกลงทุนและคุมความเสี่ยง"),
        "whatChanged": f"พบสัญญาณเปลี่ยนแปลง {len(snapshot.changes)} รายการ",
        "why": (
            f"ข้อมูลพร้อมใช้ {snapshot.health.available}/{snapshot.health.total} สัญญาณ; "
            + ("ตัวขับเคลื่อนความเสี่ยง: " + ", ".join(drivers) if drivers else "ไม่มีตัวขับเคลื่อนที่ตรวจสอบได้")
        ),
        "actionToday": (
            "งดใช้คะแนนรวมตัดสินใจลงทุนจนกว่าข้อมูลจะครบตามเกณฑ์"
            if unavailable else
            "ควบคุมขนาดสถานะและติดตามสัญญาณเสี่ยงก่อนเพิ่มการลงทุน"
        ),
        "confidence": "unavailable" if unavailable else ("degraded" if incomplete else "normal"),
        "topDrivers": drivers,
    }
