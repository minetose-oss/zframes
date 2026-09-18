from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from statistics import fmean
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


def pct_change(points: Sequence[SeriesPoint], periods: int) -> float | None:
    if len(points) <= periods:
        return None
    latest = points[-1].value
    previous = points[-1 - periods].value
    if previous == 0:
        return None
    return ((latest - previous) / previous) * 100.0


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
