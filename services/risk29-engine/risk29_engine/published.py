from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from .models import Risk29History, Risk29Snapshot


class PublishedSnapshotClient:
    """Read precomputed Risk29 wire payloads from a durable static origin."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float = 4.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.transport = transport

    async def _get_text(self, name: str) -> str:
        timeout = httpx.Timeout(self.timeout_seconds)
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            transport=self.transport,
        ) as client:
            response = await client.get(
                f"{self.base_url}/{name}",
                headers={"User-Agent": "risk29-engine/published-reader"},
            )
            response.raise_for_status()
            return response.text

    async def latest(self) -> Risk29Snapshot:
        return Risk29Snapshot.model_validate_json(await self._get_text("latest.json"))

    async def history(self, days: int = 30) -> Risk29History:
        days = max(1, min(days, 365))
        history = Risk29History.model_validate_json(await self._get_text("history.json"))
        cutoff = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
        return Risk29History(
            generatedAt=history.generatedAt,
            points=[point for point in history.points if point.time >= cutoff],
        )
