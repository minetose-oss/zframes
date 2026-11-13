from datetime import date, datetime, timezone

from risk29_engine.scoring import (
    SeriesPoint,
    equity_trend_score,
    freshness_from_date,
    piecewise,
    state_from_score,
)


def test_piecewise_interpolates_and_clamps():
    knots = [[0, 10], [10, 50], [20, 100]]
    assert piecewise(-1, knots) == 10
    assert piecewise(5, knots) == 30
    assert piecewise(25, knots) == 100


def test_state_boundaries_are_versioned_engine_rules():
    assert state_from_score(34.99) == "normal"
    assert state_from_score(35) == "watch"
    assert state_from_score(55) == "warning"
    assert state_from_score(75) == "alert"
    assert state_from_score(None) == "unavailable"


def test_equity_trend_penalizes_price_below_long_moving_averages():
    points = [SeriesPoint(date(2026, 1, 1), 100 + i * 0.1) for i in range(200)]
    calm = equity_trend_score(points)
    sold_off = points + [SeriesPoint(date(2026, 9, 1), 70)]
    stressed = equity_trend_score(sold_off[-200:])
    assert stressed > calm


def test_freshness_becomes_stale_after_configured_window():
    now = datetime(2026, 9, 16, 12, tzinfo=timezone.utc)
    fresh, _ = freshness_from_date(date(2026, 9, 15), now, 72, 120)
    stale, _ = freshness_from_date(date(2026, 9, 1), now, 72, 120)
    assert fresh == "fresh"
    assert stale == "stale"
