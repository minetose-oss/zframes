from datetime import date, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest

from risk29_engine.scoring import SeriesPoint
from risk29_engine.sources import PublicSourceClient


@pytest.mark.asyncio
async def test_primary_outage_uses_official_history(monkeypatch):
    client = PublicSourceClient()
    points = [SeriesPoint(date(2025, 1, 1) + timedelta(days=i), 20.0, "CBOE Official") for i in range(220)]
    monkeypatch.setattr(client, "_fred_primary", AsyncMock(side_effect=httpx.ConnectError("offline")))
    monkeypatch.setattr(client, "_extend_official_history", AsyncMock(return_value=points))
    assert await client.fred("VIXCLS") == points


@pytest.mark.asyncio
async def test_insufficient_backup_fails_closed(monkeypatch):
    client = PublicSourceClient()
    monkeypatch.setattr(client, "_fred_primary", AsyncMock(side_effect=httpx.ConnectError("offline")))
    monkeypatch.setattr(client, "_extend_official_history", AsyncMock(return_value=[]))
    with pytest.raises(ValueError, match="insufficient"):
        await client.fred("DCOILWTICO")


@pytest.mark.asyncio
async def test_backup_outage_retains_primary(monkeypatch):
    client = PublicSourceClient()
    base = [SeriesPoint(date(2025, 1, 2), 20.0)]
    monkeypatch.setattr(client, "_get_text", AsyncMock(side_effect=httpx.ConnectError("offline")))
    assert await client._extend_official_history("VIXCLS", base, date(2025, 1, 3)) == base


@pytest.mark.asyncio
@pytest.mark.parametrize("overlap,expected_count", [(20.0, 2), (21.0, 1)])
async def test_cboe_overlap_and_provenance(monkeypatch, overlap, expected_count):
    client = PublicSourceClient()
    base = [SeriesPoint(date(2025, 1, 2), 20.0)]
    csv = f"DATE,CLOSE\n01/02/2025,{overlap}\n01/03/2025,21.5\n01/04/2025,22\n"
    monkeypatch.setattr(client, "_get_text", AsyncMock(return_value=csv))
    result = await client._extend_official_history("VIXCLS", base, date(2025, 1, 3))
    assert len(result) == expected_count
    if expected_count == 2:
        assert result[-1].source == "CBOE Official"
        assert result[-1].date == date(2025, 1, 3)
