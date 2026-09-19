from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Risk29CategoryId = Literal[
    "macro",
    "credit",
    "valuation",
    "sentiment",
    "qualitative",
    "liquidity",
    "global",
    "technical",
]
Risk29State = Literal["normal", "watch", "warning", "alert", "unavailable"]
Risk29Direction = Literal["improving", "worsening", "flat"]
Risk29Freshness = Literal["fresh", "delayed", "stale", "error"]
Risk29RegistryStatus = Literal["live", "planned"]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)



class Risk29RegistrySignal(WireModel):
    id: str
    label: str
    category: Risk29CategoryId
    status: Risk29RegistryStatus
    source: str
    sourceSeries: str | None = None
    unit: str
    transform: str


class Risk29RegistryCategory(WireModel):
    id: Risk29CategoryId
    label: str
    weight: float = Field(ge=0)
    configuredSignals: int = Field(ge=0)
    liveSignals: int = Field(ge=0)
    plannedSignals: int = Field(ge=0)


class Risk29Registry(WireModel):
    schemaVersion: Literal["1"] = "1"
    registryVersion: str
    modelVersion: str
    thresholdVersion: str
    targetSignals: int = Field(ge=1)
    configuredSignals: int = Field(ge=0)
    liveSignals: int = Field(ge=0)
    plannedSignals: int = Field(ge=0)
    remainingSignals: int = Field(ge=0)
    categories: list[Risk29RegistryCategory]
    signals: list[Risk29RegistrySignal]

    @model_validator(mode="after")
    def registry_invariants(self) -> "Risk29Registry":
        signal_ids = [signal.id for signal in self.signals]
        if len(signal_ids) != len(set(signal_ids)):
            raise ValueError("registry signal ids must be unique")
        if self.configuredSignals != len(self.signals):
            raise ValueError("configuredSignals must equal registry signal count")
        if self.configuredSignals > self.targetSignals:
            raise ValueError("configuredSignals cannot exceed targetSignals")
        if self.remainingSignals != self.targetSignals - self.configuredSignals:
            raise ValueError("remainingSignals mismatch")
        category_ids = [category.id for category in self.categories]
        if len(category_ids) != 8 or len(set(category_ids)) != 8:
            raise ValueError("registry must contain all eight categories exactly once")
        live_signals = sum(signal.status == "live" for signal in self.signals)
        planned_signals = sum(signal.status == "planned" for signal in self.signals)
        if self.liveSignals != live_signals:
            raise ValueError("liveSignals mismatch")
        if self.plannedSignals != planned_signals:
            raise ValueError("plannedSignals mismatch")
        if self.liveSignals + self.plannedSignals != self.configuredSignals:
            raise ValueError("registry status counts must equal configuredSignals")

        for category in self.categories:
            category_signals = [
                signal for signal in self.signals if signal.category == category.id
            ]
            if category.configuredSignals != len(category_signals):
                raise ValueError(f"configured signal count mismatch for {category.id}")
            if category.liveSignals != sum(
                signal.status == "live" for signal in category_signals
            ):
                raise ValueError(f"live signal count mismatch for {category.id}")
            if category.plannedSignals != sum(
                signal.status == "planned" for signal in category_signals
            ):
                raise ValueError(f"planned signal count mismatch for {category.id}")
        return self


class Risk29Signal(WireModel):
    id: str
    label: str
    category: Risk29CategoryId
    source: str
    sourceSeries: str | None = None
    sourceUrl: str | None = None
    value: float | None
    unit: str
    riskScore: float | None = Field(default=None, ge=0, le=100)
    state: Risk29State
    direction: Risk29Direction | None = None
    change: float | None = None
    changeWindow: str | None = None
    asOf: str | None
    fetchedAt: str
    ageSeconds: float | None = Field(default=None, ge=0)
    freshness: Risk29Freshness
    reason: str | None = None
    thresholdVersion: str

    @model_validator(mode="after")
    def unavailable_is_null(self) -> "Risk29Signal":
        if self.state == "unavailable" and (self.value is not None or self.riskScore is not None):
            raise ValueError("unavailable signals must have null value and riskScore")
        if self.freshness == "error" and not self.reason:
            raise ValueError("errored signals must include reason")
        return self


class Risk29Category(WireModel):
    id: Risk29CategoryId
    label: str
    weight: float = Field(ge=0)
    score: float | None = Field(default=None, ge=0, le=100)
    state: Risk29State
    availableSignals: int = Field(ge=0)
    totalSignals: int = Field(ge=0)


class Risk29Change(WireModel):
    signalId: str
    label: str
    fromState: Risk29State
    toState: Risk29State
    scoreDelta: float | None
    summary: str


class Risk29Health(WireModel):
    available: int = Field(ge=0)
    stale: int = Field(ge=0)
    errored: int = Field(ge=0)
    total: int = Field(ge=0)


class Risk29Snapshot(WireModel):
    schemaVersion: Literal["1"] = "1"
    modelVersion: str
    thresholdVersion: str
    generatedAt: str
    score: float | None = Field(default=None, ge=0, le=100)
    state: Risk29State
    regime: str
    categories: list[Risk29Category]
    signals: list[Risk29Signal]
    changes: list[Risk29Change]
    health: Risk29Health

    @model_validator(mode="after")
    def contract_invariants(self) -> "Risk29Snapshot":
        ids = [category.id for category in self.categories]
        expected = {
            "macro",
            "credit",
            "valuation",
            "sentiment",
            "qualitative",
            "liquidity",
            "global",
            "technical",
        }
        if len(ids) != 8 or set(ids) != expected:
            raise ValueError("snapshot must contain all eight categories exactly once")
        signal_ids = [signal.id for signal in self.signals]
        if len(signal_ids) != len(set(signal_ids)):
            raise ValueError("signal ids must be unique")
        for signal in self.signals:
            if signal.thresholdVersion != self.thresholdVersion:
                raise ValueError(f"threshold version mismatch for {signal.id}")
        known = set(signal_ids)
        if any(change.signalId not in known for change in self.changes):
            raise ValueError("changes must reference known signals")
        available = sum(
            signal.state != "unavailable"
            and signal.freshness != "error"
            and signal.value is not None
            and signal.riskScore is not None
            for signal in self.signals
        )
        stale = sum(signal.freshness == "stale" for signal in self.signals)
        errored = sum(signal.freshness == "error" for signal in self.signals)
        if self.health.total != len(self.signals):
            raise ValueError("health.total must equal signal count")
        if self.health.available != available:
            raise ValueError("health.available mismatch")
        if self.health.stale != stale:
            raise ValueError("health.stale mismatch")
        if self.health.errored != errored:
            raise ValueError("health.errored mismatch")
        if self.state == "unavailable" and self.score is not None:
            raise ValueError("unavailable snapshot must have null score")
        return self


class Risk29HistoryPoint(WireModel):
    time: int = Field(ge=0)
    score: float | None = Field(default=None, ge=0, le=100)
    state: Risk29State
    categoryScores: dict[Risk29CategoryId, float] = Field(default_factory=dict)


class Risk29History(WireModel):
    schemaVersion: Literal["1"] = "1"
    generatedAt: str
    points: list[Risk29HistoryPoint]

    @model_validator(mode="after")
    def time_is_monotonic(self) -> "Risk29History":
        times = [point.time for point in self.points]
        if any(current <= previous for previous, current in zip(times, times[1:])):
            raise ValueError("history points must be strictly increasing")
        return self
