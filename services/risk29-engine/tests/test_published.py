from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest

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
