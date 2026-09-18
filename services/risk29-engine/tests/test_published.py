from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest

from risk29_engine.models import Risk29History, Risk29HistoryPoint
from risk29_engine.publish import _coalesce_history, publish
from risk29_engine.published import PublishedSnapshotClient


def _snapshot_payload():
    categories = []
    for category_id, label in (
        ("macro", "Macro"),
        ("credit", "Credit"),
        ("valuation", "Valuation"),
        ("sentiment", "Sentiment"),
        ("qualitative", "Qualitative"),
        ("liquidity", "Liquidity"),
        ("global", "Global"),
        ("technical", "Technical"),
    ):
        categories.append(
            {
                "id": category_id,
                "label": label,
                "weight": 1,
                "score": None,
                "state": "unavailable",
                "availableSignals": 0,
                "totalSignals": 0,
            }
        )
    return {
        "schemaVersion": "1",
        "modelVersion": "test-model",
        "thresholdVersion": "test-threshold",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "score": None,
        "state": "unavailable",
        "regime": "unavailable",
        "categories": categories,
        "signals": [],
        "changes": [],
        "health": {"available": 0, "stale": 0, "errored": 0, "total": 0},
    }


@pytest.mark.asyncio
async def test_published_client_validates_snapshot_and_history():
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    history = {
        "schemaVersion": "1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "points": [
            {
                "time": now_ms,
                "score": 42.0,
                "state": "watch",
                "categoryScores": {"macro": 42.0},
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("latest.json"):
            return httpx.Response(200, text=json.dumps(_snapshot_payload()))
        if request.url.path.endswith("history.json"):
            return httpx.Response(200, text=json.dumps(history))
        return httpx.Response(404)

    client = PublishedSnapshotClient(
        "https://example.test/risk29",
        transport=httpx.MockTransport(handler),
    )

    snapshot = await client.latest()
    published_history = await client.history(30)

    assert snapshot.modelVersion == "test-model"
    assert snapshot.state == "unavailable"
    assert len(published_history.points) == 1
    assert published_history.points[0].score == 42.0


@pytest.mark.asyncio
async def test_published_client_rejects_malformed_payload():
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"schemaVersion": "1"})
    )
    client = PublishedSnapshotClient(
        "https://example.test/risk29",
        transport=transport,
    )

    with pytest.raises(ValueError):
        await client.latest()


def test_coalesce_history_replaces_duplicate_short_interval_points():
    history = Risk29History(
        generatedAt="2026-09-16T12:00:00+00:00",
        points=[
            Risk29HistoryPoint(time=1_000_000, score=30, state="normal"),
            Risk29HistoryPoint(time=1_300_000, score=31, state="watch"),
            Risk29HistoryPoint(time=5_000_000, score=32, state="watch"),
        ],
    )

    coalesced = _coalesce_history(history, minimum_interval_seconds=1800)

    assert [point.time for point in coalesced.points] == [1_300_000, 5_000_000]
    assert [point.score for point in coalesced.points] == [31, 32]


@pytest.mark.asyncio
async def test_publish_refuses_to_replace_durable_history_after_seed_error(
    tmp_path, monkeypatch
):
    async def fake_seed_previous(base_url, data_dir):
        return {"latest": "loaded", "history": "error"}

    monkeypatch.setattr(
        "risk29_engine.publish._seed_previous",
        fake_seed_previous,
    )

    with pytest.raises(RuntimeError, match="prior durable Risk29 publication"):
        await publish(
            tmp_path / "out",
            existing_base_url="https://example.test/risk29",
            minimum_available=7,
        )
