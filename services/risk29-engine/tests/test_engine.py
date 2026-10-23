from datetime import date, datetime, timedelta, timezone

import pytest

from risk29_engine.engine import Risk29Engine
from risk29_engine.scoring import SeriesPoint


class FakeSources:
    def __init__(self):
        self.end = date(2026, 9, 15)

    def _series(self, start: float, step: float, count: int = 240):
        first = self.end - timedelta(days=count - 1)
        return [SeriesPoint(first + timedelta(days=i), start + step * i) for i in range(count)]

    async def fred(self, series_id: str):
        if series_id == "VIXCLS":
            return self._series(17.0, 0.015)
        if series_id == "SP500":
            return self._series(6200, 1.8)
        if series_id == "NASDAQCOM":
            return self._series(21000, 7.0)
        if series_id == "BAMLH0A0HYM2":
            return self._series(3.0, 0.001)
        if series_id == "BAMLC0A0CM":
            return self._series(0.75, 0.0004)
        if series_id == "DFII10":
            return self._series(1.6, 0.0005)
        if series_id == "DTWEXBGS":
            return self._series(118.0, 0.01)
        raise AssertionError(series_id)

    async def treasury_curve(self):
        return self._series(0.45, -0.0002, 30)

    async def ofr(self):
        return self._series(-0.2, 0.001, 60)

    async def lbma_gold(self):
        return self._series(3200, 2.0, 240)


@pytest.mark.asyncio
async def test_engine_builds_contract_and_history(tmp_path):
    now = datetime(2026, 9, 16, 2, tzinfo=timezone.utc)
    engine = Risk29Engine(
        FakeSources(),
        data_dir=tmp_path,
        refresh_seconds=300,
        now_fn=lambda: now,
    )

    snapshot = await engine.latest(force=True)

    assert snapshot.schemaVersion == "1"
    assert snapshot.modelVersion == "risk29-p1-engine-0.1.1"
    assert snapshot.thresholdVersion == "risk29-p1-provisional-v1"
    assert len(snapshot.signals) == 10
    assert snapshot.health.total == 10
    assert snapshot.health.errored == 0
    assert snapshot.health.available == 10
    assert snapshot.score is not None
    assert snapshot.state != "unavailable"
    assert [category.id for category in snapshot.categories] == [
        "macro",
        "credit",
        "valuation",
        "sentiment",
        "qualitative",
        "liquidity",
        "global",
        "technical",
    ]
    valuation = next(category for category in snapshot.categories if category.id == "valuation")
    qualitative = next(category for category in snapshot.categories if category.id == "qualitative")
    assert valuation.score is None and valuation.state == "unavailable"
    assert qualitative.score is None and qualitative.state == "unavailable"

    history = engine.history(30)
    assert len(history.points) == 1
    assert history.points[0].score == snapshot.score


class BrokenSources(FakeSources):
    async def ofr(self):
        raise RuntimeError("upstream unavailable")


@pytest.mark.asyncio
async def test_one_source_failure_does_not_zero_the_model(tmp_path):
    now = datetime(2026, 9, 16, 2, tzinfo=timezone.utc)
    engine = Risk29Engine(
        BrokenSources(),
        data_dir=tmp_path,
        now_fn=lambda: now,
    )

    snapshot = await engine.latest(force=True)
    ofr = next(signal for signal in snapshot.signals if signal.id == "ofr_fsi")

    assert ofr.state == "unavailable"
    assert ofr.value is None
    assert ofr.riskScore is None
    assert ofr.freshness == "error"
    assert snapshot.health.errored == 1
    assert snapshot.score is not None
    liquidity = next(category for category in snapshot.categories if category.id == "liquidity")
    assert liquidity.state == "unavailable"
    assert liquidity.score is None


class FredTimeoutSources(FakeSources):
    async def fred(self, series_id: str):
        raise TimeoutError(f"FRED timeout: {series_id}")


@pytest.mark.asyncio
async def test_low_coverage_fails_closed_instead_of_showing_low_risk(tmp_path):
    now = datetime(2026, 9, 16, 2, tzinfo=timezone.utc)
    engine = Risk29Engine(
        FredTimeoutSources(),
        data_dir=tmp_path,
        now_fn=lambda: now,
    )

    snapshot = await engine.latest(force=True)

    assert snapshot.health.available == 3
    assert snapshot.health.errored == 7
    assert snapshot.score is None
    assert snapshot.state == "unavailable"
    assert snapshot.regime == "unavailable"

    # Partial detail remains available for diagnosis; we only suppress the
    # misleading aggregate score/regime.
    macro = next(category for category in snapshot.categories if category.id == "macro")
    liquidity = next(category for category in snapshot.categories if category.id == "liquidity")
    assert macro.score is not None
    assert liquidity.score is not None
