from __future__ import annotations

from risk29_engine.briefing import build_material_alert, build_thai_brief
from risk29_engine.models import (
    Risk29Category,
    Risk29Change,
    Risk29Health,
    Risk29HistoryPoint,
    Risk29Signal,
    Risk29Snapshot,
)


def _snapshot(*, state: str = "watch", score: float | None = 40) -> Risk29Snapshot:
    categories = [
        Risk29Category(
            id="macro",
            label="Macro",
            weight=0.18,
            score=55,
            state="watch",
            availableSignals=1,
            totalSignals=1,
        ),
        Risk29Category(id="credit", label="Credit", weight=0.14, score=35, state="normal", availableSignals=1, totalSignals=1),
        Risk29Category(id="valuation", label="Valuation", weight=0.12, score=45, state="watch", availableSignals=1, totalSignals=1),
        Risk29Category(id="sentiment", label="Sentiment", weight=0.16, score=40, state="watch", availableSignals=1, totalSignals=1),
        Risk29Category(id="qualitative", label="Qualitative", weight=0.06, score=30, state="normal", availableSignals=1, totalSignals=1),
        Risk29Category(id="liquidity", label="Liquidity", weight=0.14, score=42, state="watch", availableSignals=1, totalSignals=1),
        Risk29Category(id="global", label="Global", weight=0.10, score=38, state="normal", availableSignals=1, totalSignals=1),
        Risk29Category(id="technical", label="Technical", weight=0.10, score=47, state="watch", availableSignals=1, totalSignals=1),
    ]
    signals = []
    for index, category in enumerate(categories):
        signals.append(
            Risk29Signal(
                id=f"s-{category.id}",
                label=f"Signal {category.label}",
                category=category.id,
                source="test",
                value=1,
                unit="index",
                riskScore=float(70 - index * 4),
                state="watch",
                asOf="2026-10-14",
                fetchedAt="2026-10-14T04:00:00+00:00",
                ageSeconds=0,
                freshness="fresh",
                thresholdVersion="test-v1",
            )
        )
    return Risk29Snapshot(
        modelVersion="test-model",
        thresholdVersion="test-v1",
        generatedAt="2026-10-14T04:00:00+00:00",
        score=score,
        state=state,
        regime=state,
        categories=categories,
        signals=signals,
        changes=[],
        health=Risk29Health(available=8, stale=0, errored=0, total=8),
    )


def _previous(score: float = 40, state: str = "watch") -> Risk29HistoryPoint:
    return Risk29HistoryPoint(
        time=1791950400000,
        score=score,
        state=state,
        categoryScores={
            "macro": 55,
            "credit": 35,
            "valuation": 45,
            "sentiment": 40,
            "qualitative": 30,
            "liquidity": 42,
            "global": 38,
            "technical": 47,
        },
    )


def test_thai_brief_maps_watch_to_selective_action() -> None:
    brief = build_thai_brief(_snapshot(), _previous())
    assert brief.state == "watch"
    assert "เลือกลงทุน" in brief.posture
    assert "หลีกเลี่ยงการไล่ราคา" in brief.actionToday
    assert brief.confidence == "normal"
    assert len(brief.topDrivers) == 3
    assert brief.dataHealth is not None
    assert brief.dataHealth.total == 8
    assert brief.dataHealth.usable == 8
    assert brief.dataHealth.coveragePct == 100.0
    assert brief.dataHealth.issues == []


def test_thai_brief_exposes_signal_level_stale_issue() -> None:
    snapshot = _snapshot()
    snapshot.signals[0].freshness = "stale"
    snapshot.signals[0].ageSeconds = 604800
    snapshot.health.stale = 1

    brief = build_thai_brief(snapshot, _previous())

    assert brief.confidence == "degraded"
    assert brief.dataHealth is not None
    assert brief.dataHealth.stale == 1
    assert brief.dataHealth.usable == 7
    assert brief.dataHealth.coveragePct == 87.5
    assert len(brief.dataHealth.issues) == 1
    issue = brief.dataHealth.issues[0]
    assert issue.id == "s-macro"
    assert issue.freshness == "stale"
    assert issue.ageSeconds == 604800


def test_material_alert_is_clear_when_nothing_material_changed() -> None:
    alert = build_material_alert(_snapshot(), _previous())
    assert alert.shouldNotify is False
    assert alert.severity == "clear"
    assert alert.reasons == []


def test_material_alert_fires_on_five_point_score_move() -> None:
    alert = build_material_alert(_snapshot(score=46), _previous(score=40))
    assert alert.shouldNotify is True
    assert any("6.0" in reason for reason in alert.reasons)


def test_material_alert_fires_on_engine_change() -> None:
    snapshot = _snapshot()
    snapshot.changes = [
        Risk29Change(
            signalId="s-macro",
            label="Signal Macro",
            fromState="normal",
            toState="watch",
            scoreDelta=12,
            summary="material transition",
        )
    ]
    alert = build_material_alert(snapshot, _previous())
    assert alert.shouldNotify is True
    assert any("material signal change" in reason for reason in alert.reasons)


def test_unavailable_snapshot_fails_closed() -> None:
    snapshot = _snapshot(state="unavailable", score=None)
    alert = build_material_alert(snapshot, _previous())
    brief = build_thai_brief(snapshot, _previous())
    assert alert.shouldNotify is True
    assert brief.confidence == "degraded"
    assert "ตรวจสอบข้อมูล" in brief.posture


def test_material_alert_does_not_repeat_unchanged_data_issue() -> None:
    previous_snapshot = _snapshot()
    previous_snapshot.signals[0].freshness = "stale"
    previous_snapshot.health.stale = 1

    current = _snapshot()
    current.signals[0].freshness = "stale"
    current.health.stale = 1

    alert = build_material_alert(
        current,
        _previous(),
        previous_snapshot=previous_snapshot,
    )
    assert alert.shouldNotify is False
    assert alert.reasons == []


def test_material_alert_fires_when_data_issue_is_new() -> None:
    previous_snapshot = _snapshot()
    current = _snapshot()
    current.signals[0].freshness = "stale"
    current.health.stale = 1

    alert = build_material_alert(
        current,
        _previous(),
        previous_snapshot=previous_snapshot,
    )
    assert alert.shouldNotify is True
    assert any("data-health issue" in reason for reason in alert.reasons)
