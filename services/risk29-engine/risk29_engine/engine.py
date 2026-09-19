from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import yaml

from .models import (
    Risk29Category,
    Risk29Change,
    Risk29Health,
    Risk29History,
    Risk29HistoryPoint,
    Risk29Signal,
    Risk29Snapshot,
)
from .scoring import (
    SeriesPoint,
    core_inflation_momentum_features,
    direction_from_scores,
    equity_trend_score,
    freshness_from_date,
    mean_score,
    one_day_change,
    pct_change,
    piecewise,
    regime_from_score,
    state_from_score,
)
from .sources import LBMA_GOLD_URL, OFR_URL, FRED_URL, SourceClient

CATEGORY_ORDER = [
    "macro",
    "credit",
    "valuation",
    "sentiment",
    "qualitative",
    "liquidity",
    "global",
    "technical",
]

SOURCE_URLS = {
    "fred": FRED_URL,
    "ofr": OFR_URL,
    "lbma_gold": LBMA_GOLD_URL,
    "treasury_curve": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
}


class JsonSnapshotStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.latest_path = root / "latest.json"
        self.history_path = root / "history.json"

    def load_latest(self) -> Risk29Snapshot | None:
        if not self.latest_path.exists():
            return None
        try:
            return Risk29Snapshot.model_validate_json(self.latest_path.read_text())
        except Exception:
            return None

    def save_latest(self, snapshot: Risk29Snapshot) -> None:
        self.latest_path.write_text(snapshot.model_dump_json(indent=2))

    def load_history(self) -> Risk29History:
        if not self.history_path.exists():
            return Risk29History(
                generatedAt=datetime.now(timezone.utc).isoformat(),
                points=[],
            )
        try:
            return Risk29History.model_validate_json(self.history_path.read_text())
        except Exception:
            return Risk29History(
                generatedAt=datetime.now(timezone.utc).isoformat(),
                points=[],
            )

    def append_history(self, snapshot: Risk29Snapshot) -> None:
        history = self.load_history()
        generated = datetime.fromisoformat(snapshot.generatedAt.replace("Z", "+00:00"))
        point = Risk29HistoryPoint(
            time=int(generated.timestamp() * 1000),
            score=snapshot.score,
            state=snapshot.state,
            categoryScores={
                category.id: category.score
                for category in snapshot.categories
                if category.score is not None
            },
        )
        if history.points and point.time <= history.points[-1].time:
            return
        history.points.append(point)
        # Local JSON is a Phase 1A store, not the final database. Keep enough
        # points for a full year at the production twice-daily cadence, plus
        # headroom for manual publishes, while still bounding local growth.
        history.points = history.points[-1200:]
        history.generatedAt = snapshot.generatedAt
        self.history_path.write_text(history.model_dump_json(indent=2))


class Risk29Engine:
    def __init__(
        self,
        sources: SourceClient,
        *,
        config_path: Path | None = None,
        data_dir: Path | None = None,
        refresh_seconds: int | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        path = config_path or Path(__file__).with_name("signals.yaml")
        self.config = yaml.safe_load(path.read_text())
        if not isinstance(self.config, dict):
            raise ValueError("Risk29 config must be a mapping")
        self.sources = sources
        root = data_dir or Path(os.getenv("RISK29_DATA_DIR", str(Path(__file__).parent / ".data")))
        self.store = JsonSnapshotStore(root)
        self.refresh_seconds = refresh_seconds or int(os.getenv("RISK29_REFRESH_SECONDS", "300"))
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self._cache: Risk29Snapshot | None = None
        self._cache_until = 0.0
        self._lock = asyncio.Lock()

    @property
    def threshold_version(self) -> str:
        return str(self.config["threshold_version"])

    @property
    def model_version(self) -> str:
        return str(self.config["model_version"])

    async def latest(self, *, force: bool = False) -> Risk29Snapshot:
        now_mono = time.monotonic()
        if not force and self._cache is not None and now_mono < self._cache_until:
            return self._cache
        async with self._lock:
            now_mono = time.monotonic()
            if not force and self._cache is not None and now_mono < self._cache_until:
                return self._cache
            snapshot = await self._build_snapshot()
            self.store.save_latest(snapshot)
            self.store.append_history(snapshot)
            self._cache = snapshot
            self._cache_until = time.monotonic() + self.refresh_seconds
            return snapshot

    def history(self, days: int = 30) -> Risk29History:
        days = max(1, min(days, 365))
        history = self.store.load_history()
        cutoff = int((self.now_fn() - timedelta(days=days)).timestamp() * 1000)
        return Risk29History(
            generatedAt=history.generatedAt,
            points=[point for point in history.points if point.time >= cutoff],
        )

    async def _build_snapshot(self) -> Risk29Snapshot:
        now = self.now_fn().astimezone(timezone.utc)
        configs: list[dict[str, Any]] = list(self.config.get("signals", []))
        signals = await asyncio.gather(*(self._build_signal(item, now) for item in configs))
        categories = self._aggregate_categories(signals, configs)

        health = Risk29Health(
            available=sum(
                signal.state != "unavailable"
                and signal.freshness != "error"
                and signal.value is not None
                and signal.riskScore is not None
                for signal in signals
            ),
            stale=sum(signal.freshness == "stale" for signal in signals),
            errored=sum(signal.freshness == "error" for signal in signals),
            total=len(signals),
        )

        weighted = [
            (category.score, category.weight)
            for category in categories
            if category.score is not None and category.weight > 0
        ]
        active_weight = sum(weight for _, weight in weighted)

        configured_categories = [
            category
            for category in categories
            if category.totalSignals > 0 and category.weight > 0
        ]
        configured_weight = sum(category.weight for category in configured_categories)
        available_weight = sum(
            category.weight for category in configured_categories if category.score is not None
        )
        weight_coverage = available_weight / configured_weight if configured_weight else 0.0
        signal_coverage = health.available / health.total if health.total else 0.0
        min_signal_coverage = float(self.config.get("minimum_signal_coverage", 0.70))
        min_weight_coverage = float(self.config.get("minimum_weight_coverage", 0.75))
        enough_coverage = (
            signal_coverage >= min_signal_coverage
            and weight_coverage >= min_weight_coverage
        )

        # Missing data must never manufacture a reassuring low-risk reading.
        # We keep partial category/signal detail visible, but the aggregate is
        # unavailable until enough of the configured model is live.
        overall = (
            round(sum(score * weight for score, weight in weighted) / active_weight, 2)
            if active_weight and enough_coverage
            else None
        )
        previous = self.store.load_latest()
        changes = self._changes(previous, signals)
        state = state_from_score(overall)
        return Risk29Snapshot(
            modelVersion=self.model_version,
            thresholdVersion=self.threshold_version,
            generatedAt=now.isoformat(),
            score=overall,
            state=state,
            regime=regime_from_score(overall),
            categories=categories,
            signals=signals,
            changes=changes,
            health=health,
        )

    async def _build_signal(self, cfg: dict[str, Any], now: datetime) -> Risk29Signal:
        signal_id = str(cfg["id"])
        fetch_kind = str(cfg["fetch"])
        fetched_at = now.isoformat()
        try:
            points = await self._load_points(cfg)
            if not points:
                raise ValueError("source returned no observations")
            score, previous_score = self._score_points(cfg, points)
            latest = points[-1]
            freshness_cfg = cfg.get("freshness") or {}
            freshness, age_seconds = freshness_from_date(
                latest.date,
                now,
                float(freshness_cfg.get("fresh_hours", 72)),
                float(freshness_cfg.get("delayed_hours", 120)),
            )
            transform = str(cfg.get("transform"))
            if transform == "core_inflation_3m_annualized_vs_12m":
                current_3m, _gap, previous_3m, _previous_gap = (
                    core_inflation_momentum_features(points)
                )
                signal_value = current_3m
                change = (
                    current_3m - previous_3m if previous_3m is not None else None
                )
                change_window = "1m" if change is not None else None
            else:
                signal_value = latest.value
                change_percent = transform in {"equity_trend", "momentum_20d"}
                change = one_day_change(points, percent=change_percent)
                change_window = "1d" if change is not None else None
            state = state_from_score(score)
            return Risk29Signal(
                id=signal_id,
                label=str(cfg["label"]),
                category=cfg["category"],
                source=str(cfg["source"]),
                sourceSeries=str(cfg.get("source_series")) if cfg.get("source_series") else None,
                sourceUrl=SOURCE_URLS.get(fetch_kind),
                value=round(signal_value, 6),
                unit=str(cfg["unit"]),
                riskScore=round(score, 2),
                state=state,
                direction=direction_from_scores(score, previous_score),
                change=round(change, 6) if change is not None else None,
                changeWindow=change_window,
                asOf=latest.date.isoformat(),
                fetchedAt=fetched_at,
                ageSeconds=age_seconds,
                freshness=freshness,
                thresholdVersion=self.threshold_version,
            )
        except Exception as exc:
            return Risk29Signal(
                id=signal_id,
                label=str(cfg["label"]),
                category=cfg["category"],
                source=str(cfg["source"]),
                sourceSeries=str(cfg.get("source_series")) if cfg.get("source_series") else None,
                sourceUrl=SOURCE_URLS.get(fetch_kind),
                value=None,
                unit=str(cfg["unit"]),
                riskScore=None,
                state="unavailable",
                asOf=None,
                fetchedAt=fetched_at,
                ageSeconds=None,
                freshness="error",
                reason=f"{type(exc).__name__}: {exc}"[:500],
                thresholdVersion=self.threshold_version,
            )

    async def _load_points(self, cfg: dict[str, Any]) -> list[SeriesPoint]:
        fetch_kind = str(cfg["fetch"])
        if fetch_kind == "fred":
            return await self.sources.fred(str(cfg["source_series"]))
        if fetch_kind == "treasury_curve":
            return await self.sources.treasury_curve()
        if fetch_kind == "ofr":
            return await self.sources.ofr()
        if fetch_kind == "lbma_gold":
            return await self.sources.lbma_gold()
        raise ValueError(f"unknown fetch source {fetch_kind}")

    def _score_points(self, cfg: dict[str, Any], points: list[SeriesPoint]) -> tuple[float, float | None]:
        transform = str(cfg["transform"])
        knots = cfg.get("points") or []
        if transform == "piecewise_latest":
            current = piecewise(points[-1].value, knots)
            previous = piecewise(points[-2].value, knots) if len(points) >= 2 else None
            return current, previous
        if transform == "equity_trend":
            current = equity_trend_score(points)
            previous = equity_trend_score(points[:-1]) if len(points) >= 201 else None
            return current, previous
        if transform == "momentum_20d":
            feature = pct_change(points, 20)
            if feature is None:
                raise ValueError("20-session momentum requires at least 21 observations")
            current = piecewise(feature, knots)
            previous_feature = pct_change(points[:-1], 20) if len(points) >= 22 else None
            previous = piecewise(previous_feature, knots) if previous_feature is not None else None
            return current, previous
        if transform == "core_inflation_3m_annualized_vs_12m":
            current_3m, current_gap, previous_3m, previous_gap = (
                core_inflation_momentum_features(points)
            )
            acceleration_knots = cfg.get("acceleration_points") or []
            level_weight = float(cfg.get("level_weight", 0.7))
            acceleration_weight = float(cfg.get("acceleration_weight", 0.3))
            if abs(level_weight + acceleration_weight - 1.0) > 1e-9:
                raise ValueError("core inflation weights must sum to 1")
            current = (
                piecewise(current_3m, knots) * level_weight
                + piecewise(current_gap, acceleration_knots) * acceleration_weight
            )
            previous = (
                piecewise(previous_3m, knots) * level_weight
                + piecewise(previous_gap, acceleration_knots) * acceleration_weight
                if previous_3m is not None and previous_gap is not None
                else None
            )
            return current, previous
        raise ValueError(f"unknown transform {transform}")

    def _aggregate_categories(
        self,
        signals: list[Risk29Signal],
        configs: list[dict[str, Any]],
    ) -> list[Risk29Category]:
        category_cfg: dict[str, dict[str, Any]] = self.config["categories"]
        out: list[Risk29Category] = []
        for category_id in CATEGORY_ORDER:
            members = [signal for signal in signals if signal.category == category_id]
            total = sum(str(cfg.get("category")) == category_id for cfg in configs)
            # Stale observations remain visible but are intentionally not used to
            # claim a current category score.
            usable = [
                signal
                for signal in members
                if signal.riskScore is not None
                and signal.state != "unavailable"
                and signal.freshness in {"fresh", "delayed"}
            ]
            score = mean_score(signal.riskScore for signal in usable if signal.riskScore is not None)
            meta = category_cfg[category_id]
            out.append(
                Risk29Category(
                    id=category_id,
                    label=str(meta["label"]),
                    weight=float(meta["weight"]),
                    score=score,
                    state=state_from_score(score),
                    availableSignals=len(usable),
                    totalSignals=total,
                )
            )
        return out

    @staticmethod
    def _changes(previous: Risk29Snapshot | None, signals: list[Risk29Signal]) -> list[Risk29Change]:
        if previous is None:
            return []
        old = {signal.id: signal for signal in previous.signals}
        changes: list[Risk29Change] = []
        for signal in signals:
            prior = old.get(signal.id)
            if prior is None or signal.riskScore is None or prior.riskScore is None:
                continue
            delta = round(signal.riskScore - prior.riskScore, 2)
            state_changed = signal.state != prior.state
            if not state_changed and abs(delta) < 5:
                continue
            summary = (
                f"{signal.label} moved {prior.state.upper()} → {signal.state.upper()}."
                if state_changed
                else f"{signal.label} risk score moved {delta:+.1f} points."
            )
            changes.append(
                Risk29Change(
                    signalId=signal.id,
                    label=signal.label,
                    fromState=prior.state,
                    toState=signal.state,
                    scoreDelta=delta,
                    summary=summary,
                )
            )
        changes.sort(key=lambda item: abs(item.scoreDelta or 0), reverse=True)
        return changes
