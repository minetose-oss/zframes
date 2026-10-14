from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from math import sqrt
from statistics import fmean, pstdev
from typing import Iterable, Sequence

from .models import Risk29Direction, Risk29Freshness, Risk29State


@dataclass(frozen=True)
class SeriesPoint:
    date: date
    value: float


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def piecewise(value: float, points: Sequence[Sequence[float]]) -> float:
    """Linear interpolation over x/y knots; supports rising or falling y values."""
    if not points:
        raise ValueError("piecewise transform requires points")
    ordered = sorted((float(x), float(y)) for x, y in points)
    if value <= ordered[0][0]:
        return clamp(ordered[0][1])
    if value >= ordered[-1][0]:
        return clamp(ordered[-1][1])
    for (x0, y0), (x1, y1) in zip(ordered, ordered[1:]):
        if x0 <= value <= x1:
            if x1 == x0:
                return clamp(y1)
            ratio = (value - x0) / (x1 - x0)
            return clamp(y0 + ratio * (y1 - y0))
    return clamp(ordered[-1][1])


def spread_series(
    left: Sequence[SeriesPoint],
    right: Sequence[SeriesPoint],
) -> list[SeriesPoint]:
    right_by_date = {point.date: point.value for point in right}
    points = [
        SeriesPoint(point.date, point.value - right_by_date[point.date])
        for point in left
        if point.date in right_by_date
    ]
    if not points:
        raise ValueError("spread series has no overlapping observations")
    points.sort(key=lambda point: point.date)
    return points


def net_liquidity_series(
    assets: Sequence[SeriesPoint],
    treasury_general_account: Sequence[SeriesPoint],
    reverse_repo: Sequence[SeriesPoint],
    *,
    max_lag_days: int = 10,
) -> list[SeriesPoint]:
    """
    Build the common market proxy: Fed assets - Treasury General Account - ON RRP.

    WALCL and WTREGEN are reported in millions of dollars while RRPONTSYD is
    reported in billions. The derived series is normalized to billions of
    dollars and anchored to the weekly Fed-balance-sheet observation dates.
    Missing components are never replaced with zero; the latest observation on
    or before the anchor date is used only when it is recent enough.
    """
    if not assets or not treasury_general_account or not reverse_repo:
        raise ValueError("net liquidity requires all three component series")

    asset_points = sorted(assets, key=lambda point: point.date)
    tga_points = sorted(treasury_general_account, key=lambda point: point.date)
    rrp_points = sorted(reverse_repo, key=lambda point: point.date)

    tga_index = -1
    rrp_index = -1
    combined: list[SeriesPoint] = []

    for asset in asset_points:
        while (
            tga_index + 1 < len(tga_points)
            and tga_points[tga_index + 1].date <= asset.date
        ):
            tga_index += 1
        while (
            rrp_index + 1 < len(rrp_points)
            and rrp_points[rrp_index + 1].date <= asset.date
        ):
            rrp_index += 1

        if tga_index < 0 or rrp_index < 0:
            continue

        tga = tga_points[tga_index]
        rrp = rrp_points[rrp_index]
        if (asset.date - tga.date).days > max_lag_days:
            continue
        if (asset.date - rrp.date).days > max_lag_days:
            continue

        # WALCL/WTREGEN: millions USD. RRPONTSYD: billions USD.
        value_billions = (asset.value - tga.value) / 1000.0 - rrp.value
        combined.append(SeriesPoint(asset.date, value_billions))

    if not combined:
        raise ValueError("net liquidity series has no aligned recent observations")
    return combined


def average_pairwise_correlation_series(
    series: Sequence[Sequence[SeriesPoint]],
    *,
    window: int = 20,
) -> list[SeriesPoint]:
    """
    Build a daily average absolute pairwise-correlation series from price indexes.

    All assets are aligned on common observation dates first. Correlations are
    calculated on simple returns over the trailing window. A missing or flat
    pair is skipped rather than treated as zero correlation.
    """
    if len(series) < 3:
        raise ValueError("cross-asset correlation requires at least three assets")
    if window < 5:
        raise ValueError("cross-asset correlation window must be at least 5")

    maps = [{point.date: point.value for point in points} for points in series]
    common_dates = sorted(set.intersection(*(set(mapping) for mapping in maps)))
    if len(common_dates) <= window:
        raise ValueError("cross-asset correlation has insufficient overlapping history")

    aligned = [[mapping[day] for day in common_dates] for mapping in maps]
    returns: list[list[float]] = []
    for values in aligned:
        asset_returns: list[float] = []
        for previous, current in zip(values, values[1:]):
            if previous <= 0:
                raise ValueError("cross-asset correlation requires positive price levels")
            asset_returns.append((current / previous) - 1.0)
        returns.append(asset_returns)

    def _corr(left: Sequence[float], right: Sequence[float]) -> float | None:
        if len(left) != len(right) or len(left) < 2:
            return None
        left_mean = fmean(left)
        right_mean = fmean(right)
        left_sigma = pstdev(left)
        right_sigma = pstdev(right)
        if left_sigma <= 1e-12 or right_sigma <= 1e-12:
            return None
        covariance = fmean(
            (x - left_mean) * (y - right_mean)
            for x, y in zip(left, right)
        )
        return covariance / (left_sigma * right_sigma)

    points: list[SeriesPoint] = []
    for end in range(window, len(common_dates)):
        pairwise: list[float] = []
        for left_index in range(len(returns)):
            left = returns[left_index][end - window:end]
            for right_index in range(left_index + 1, len(returns)):
                right = returns[right_index][end - window:end]
                correlation = _corr(left, right)
                if correlation is not None:
                    pairwise.append(abs(correlation))
        if not pairwise:
            continue
        points.append(SeriesPoint(common_dates[end], fmean(pairwise)))

    if not points:
        raise ValueError("cross-asset correlation produced no usable observations")
    return points


def pct_change(points: Sequence[SeriesPoint], periods: int) -> float | None:
    if len(points) <= periods:
        return None
    latest = points[-1].value
    previous = points[-1 - periods].value
    if previous == 0:
        return None
    return ((latest - previous) / previous) * 100.0


def realized_volatility(
    points: Sequence[SeriesPoint],
    periods: int,
    *,
    annualization: int = 252,
) -> float | None:
    """Annualized realized volatility from simple daily returns, in percent."""
    if periods < 2 or len(points) <= periods:
        return None
    window = points[-(periods + 1):]
    returns: list[float] = []
    for previous, current in zip(window, window[1:]):
        if previous.value <= 0:
            return None
        returns.append((current.value / previous.value) - 1.0)
    if len(returns) < periods:
        return None
    return pstdev(returns) * sqrt(float(annualization)) * 100.0


def rolling_percentile(
    values: Sequence[float],
    current: float,
) -> float | None:
    """Percentile rank of current versus a historical sample, from 0 to 100."""
    if not values:
        return None
    less = sum(value < current for value in values)
    equal = sum(value == current for value in values)
    return 100.0 * (less + 0.5 * equal) / len(values)


def realized_volatility_regime_features(
    points: Sequence[SeriesPoint],
    *,
    short_periods: int = 20,
    long_periods: int = 60,
    percentile_lookback: int = 252,
    min_percentile_observations: int = 60,
) -> tuple[
    float,
    float,
    float,
    float,
    float | None,
    float | None,
    float | None,
    float | None,
]:
    """
    Return RV20, RV60, RV20/RV60 and prior-observation equivalents.

    The percentile used by the engine is computed from trailing RV20 history,
    avoiding look-ahead while keeping the transform auditable.
    """
    if len(points) <= long_periods:
        raise ValueError("realized-volatility regime requires more price history")

    current_rv20 = realized_volatility(points, short_periods)
    current_rv60 = realized_volatility(points, long_periods)
    previous_rv20 = realized_volatility(points[:-1], short_periods)
    previous_rv60 = realized_volatility(points[:-1], long_periods)
    if current_rv20 is None or current_rv60 is None or current_rv60 <= 1e-12:
        raise ValueError("realized-volatility regime could not compute current volatility")

    current_ratio = current_rv20 / current_rv60
    previous_ratio = (
        previous_rv20 / previous_rv60
        if previous_rv20 is not None and previous_rv60 is not None and previous_rv60 > 1e-12
        else None
    )

    history: list[float] = []
    start = max(short_periods + 1, len(points) - percentile_lookback)
    for end in range(start, len(points) + 1):
        rv = realized_volatility(points[:end], short_periods)
        if rv is not None:
            history.append(rv)
    if len(history) < min_percentile_observations:
        raise ValueError(
            f"realized-volatility percentile requires at least {min_percentile_observations} observations"
        )
    current_percentile = rolling_percentile(history[:-1] or history, current_rv20)

    previous_percentile = None
    if previous_rv20 is not None and len(history) >= 2:
        previous_percentile = rolling_percentile(history[:-2] or history[:-1], previous_rv20)

    if current_percentile is None:
        raise ValueError("realized-volatility percentile is unavailable")

    return (
        current_rv20,
        current_rv60,
        current_ratio,
        current_percentile,
        previous_rv20,
        previous_rv60,
        previous_ratio,
        previous_percentile,
    )


def oil_shock_features(
    points: Sequence[SeriesPoint],
    *,
    momentum_periods: int = 20,
    volatility_periods: int = 20,
) -> tuple[float, float, float | None, float | None]:
    """Return oil momentum and realized volatility, plus prior-observation versions."""
    current_momentum = pct_change(points, momentum_periods)
    current_volatility = realized_volatility(points, volatility_periods)
    previous_momentum = pct_change(points[:-1], momentum_periods)
    previous_volatility = realized_volatility(points[:-1], volatility_periods)
    if current_momentum is None or current_volatility is None:
        raise ValueError("oil shock requires at least 21 usable observations")
    return current_momentum, current_volatility, previous_momentum, previous_volatility


def annualized_pct_change(
    points: Sequence[SeriesPoint],
    periods: int,
    *,
    periods_per_year: int = 12,
) -> float | None:
    if len(points) <= periods:
        return None
    latest = points[-1].value
    previous = points[-1 - periods].value
    if previous <= 0 or latest <= 0:
        return None
    exponent = periods_per_year / periods
    return ((latest / previous) ** exponent - 1.0) * 100.0


def core_inflation_momentum_features(
    points: Sequence[SeriesPoint],
) -> tuple[float, float, float | None, float | None]:
    """
    Return current 3m annualized core-CPI inflation, its gap versus 12m YoY,
    and the prior-observation versions of both features.

    CPILFESL is a monthly index. Using observation-count periods instead of
    calendar-day offsets keeps the transform robust to release timing.
    """
    current_3m = annualized_pct_change(points, 3)
    current_12m = pct_change(points, 12)
    if current_3m is None or current_12m is None:
        raise ValueError("core inflation momentum requires at least 13 observations")

    previous_3m = annualized_pct_change(points[:-1], 3)
    previous_12m = pct_change(points[:-1], 12)
    current_gap = current_3m - current_12m
    previous_gap = (
        previous_3m - previous_12m
        if previous_3m is not None and previous_12m is not None
        else None
    )
    return current_3m, current_gap, previous_3m, previous_gap


def sahm_labor_deterioration_features(
    points: Sequence[SeriesPoint],
) -> tuple[float, float | None, float | None, float | None]:
    """
    Return the current Sahm-rule indicator, its three-observation change,
    and the prior-observation versions used for direction scoring.

    SAHMREALTIME is already expressed in percentage points, so the transform
    intentionally scores the published indicator directly rather than
    reconstructing it from unemployment-rate inputs.
    """
    if len(points) < 4:
        raise ValueError("Sahm labor deterioration requires at least 4 observations")

    current = points[-1].value
    change_3m = current - points[-4].value
    previous = points[-2].value
    previous_change_3m = (
        previous - points[-5].value if len(points) >= 5 else None
    )
    return current, change_3m, previous, previous_change_3m


def level_change_features(
    points: Sequence[SeriesPoint],
    periods: int,
) -> tuple[float, float, float | None, float | None]:
    if periods < 1 or len(points) <= periods:
        raise ValueError(f"level-and-change transform requires at least {periods + 1} observations")

    current_level = points[-1].value
    current_change = current_level - points[-1 - periods].value
    previous_level = points[-2].value if len(points) >= 2 else None
    previous_change = (
        previous_level - points[-2 - periods].value
        if previous_level is not None and len(points) > periods + 1
        else None
    )
    return current_level, current_change, previous_level, previous_change


def rolling_zscore_features(
    points: Sequence[SeriesPoint],
    *,
    lookback: int = 252,
    min_observations: int = 60,
) -> tuple[float, float, float | None, float | None]:
    if lookback < 2:
        raise ValueError("rolling z-score lookback must be at least 2")
    if min_observations < 2:
        raise ValueError("rolling z-score minimum observations must be at least 2")

    def _zscore(sequence: Sequence[SeriesPoint]) -> float | None:
        window = sequence[-lookback:]
        if len(window) < min_observations:
            return None
        values = [point.value for point in window]
        mean = fmean(values)
        sigma = pstdev(values)
        if sigma <= 1e-12:
            return 0.0
        return (values[-1] - mean) / sigma

    current_zscore = _zscore(points)
    if current_zscore is None:
        raise ValueError(
            f"rolling z-score requires at least {min_observations} observations"
        )

    current_level = points[-1].value
    previous_level = points[-2].value if len(points) >= 2 else None
    previous_zscore = _zscore(points[:-1]) if len(points) >= 2 else None
    return current_level, current_zscore, previous_level, previous_zscore


def one_day_change(points: Sequence[SeriesPoint], percent: bool) -> float | None:
    if len(points) < 2:
        return None
    latest = points[-1].value
    previous = points[-2].value
    if percent:
        if previous == 0:
            return None
        return ((latest - previous) / previous) * 100.0
    return latest - previous


def moving_average(points: Sequence[SeriesPoint], periods: int) -> float | None:
    if len(points) < periods:
        return None
    return fmean(point.value for point in points[-periods:])


def equity_trend_score(points: Sequence[SeriesPoint]) -> float:
    """
    POC technical transform.

    The transform is intentionally simple and auditable: price below MA20, MA50,
    and MA200 progressively raises risk, while a sharp 20-session decline adds a
    momentum penalty. Final production thresholds require backtesting.
    """
    if len(points) < 200:
        raise ValueError("equity trend requires at least 200 observations")
    latest = points[-1].value
    ma20 = moving_average(points, 20)
    ma50 = moving_average(points, 50)
    ma200 = moving_average(points, 200)
    momentum20 = pct_change(points, 20)
    assert ma20 is not None and ma50 is not None and ma200 is not None

    score = 12.0
    if latest < ma20:
        score += 18.0
    if latest < ma50:
        score += 24.0
    if latest < ma200:
        score += 34.0
    if momentum20 is not None:
        if momentum20 < -10:
            score += 20.0
        elif momentum20 < -5:
            score += 12.0
        elif momentum20 < 0:
            score += 6.0
    return clamp(score)


def state_from_score(score: float | None) -> Risk29State:
    if score is None:
        return "unavailable"
    if score < 35:
        return "normal"
    if score < 55:
        return "watch"
    if score < 75:
        return "warning"
    return "alert"


def regime_from_score(score: float | None) -> str:
    if score is None:
        return "unavailable"
    if score < 30:
        return "risk-on"
    if score < 45:
        return "neutral"
    if score < 65:
        return "risk-off-transition"
    return "risk-off"


def direction_from_scores(current: float | None, previous: float | None) -> Risk29Direction | None:
    if current is None or previous is None:
        return None
    delta = current - previous
    if abs(delta) < 1.0:
        return "flat"
    return "worsening" if delta > 0 else "improving"


def freshness_from_date(
    as_of: date | None,
    now: datetime,
    fresh_hours: float,
    delayed_hours: float,
) -> tuple[Risk29Freshness, float | None]:
    if as_of is None:
        return "error", None
    observed = datetime(as_of.year, as_of.month, as_of.day, tzinfo=timezone.utc)
    age_seconds = max(0.0, (now.astimezone(timezone.utc) - observed).total_seconds())
    age_hours = age_seconds / 3600.0
    if age_hours <= fresh_hours:
        return "fresh", age_seconds
    if age_hours <= delayed_hours:
        return "delayed", age_seconds
    return "stale", age_seconds


def mean_score(values: Iterable[float]) -> float | None:
    usable = list(values)
    return round(fmean(usable), 2) if usable else None
