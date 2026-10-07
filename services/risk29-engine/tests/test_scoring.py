from datetime import date, datetime, timezone

from risk29_engine.scoring import (
    SeriesPoint,
    core_inflation_momentum_features,
    equity_trend_score,
    sahm_labor_deterioration_features,
    freshness_from_date,
    level_change_features,
    piecewise,
    spread_series,
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



def test_core_inflation_momentum_uses_monthly_3m_annualized_and_12m_gap():
    points = []
    for i in range(18):
        month_index = (2025 * 12 + 3) + i
        year, month_zero = divmod(month_index, 12)
        points.append(
            SeriesPoint(
                date(year, month_zero + 1, 1),
                300.0 * ((1.0025) ** i),
            )
        )

    current_3m, current_gap, previous_3m, previous_gap = (
        core_inflation_momentum_features(points)
    )

    assert 2.9 < current_3m < 3.2
    assert abs(current_gap) < 0.2
    assert previous_3m is not None
    assert previous_gap is not None



def test_sahm_labor_deterioration_tracks_level_and_three_month_change():
    points = [
        SeriesPoint(date(2026, month, 1), value)
        for month, value in zip(
            range(1, 7),
            [0.10, 0.12, 0.14, 0.18, 0.24, 0.31],
        )
    ]

    current, change_3m, previous, previous_change_3m = (
        sahm_labor_deterioration_features(points)
    )

    assert current == 0.31
    assert round(change_3m or 0, 2) == 0.17
    assert previous == 0.24
    assert round(previous_change_3m or 0, 2) == 0.12



def test_level_change_features_tracks_spread_widening():
    points = [
        SeriesPoint(date(2026, 1, 1), 1.5 + i * 0.01)
        for i in range(70)
    ]

    current, change, previous, previous_change = level_change_features(points, 63)

    assert current > 2.0
    assert change > 0.6
    assert previous is not None
    assert previous_change is not None



def test_spread_series_aligns_matching_dates_only():
    left = [
        SeriesPoint(date(2026, 1, 1), 8.0),
        SeriesPoint(date(2026, 1, 2), 8.4),
        SeriesPoint(date(2026, 1, 3), 8.7),
    ]
    right = [
        SeriesPoint(date(2026, 1, 2), 2.0),
        SeriesPoint(date(2026, 1, 3), 2.1),
    ]

    spread = spread_series(left, right)

    assert [point.date for point in spread] == [date(2026, 1, 2), date(2026, 1, 3)]
    assert [round(point.value, 2) for point in spread] == [6.4, 6.6]
