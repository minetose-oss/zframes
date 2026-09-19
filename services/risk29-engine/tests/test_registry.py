from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from risk29_engine.main import app
from risk29_engine.registry import build_registry


EXPECTED_CATEGORY_COUNTS = {
    "macro": 4,
    "credit": 4,
    "valuation": 3,
    "sentiment": 4,
    "qualitative": 2,
    "liquidity": 4,
    "global": 4,
    "technical": 4,
}


def _config() -> dict:
    path = Path(__file__).parents[1] / "risk29_engine" / "signals.yaml"
    return yaml.safe_load(path.read_text())


def test_registry_reports_proposed_29_with_10_live_and_19_planned():
    registry = build_registry(_config())

    assert registry.registryVersion == "risk29-proposed-v1"
    assert registry.targetSignals == 29
    assert registry.configuredSignals == 29
    assert registry.liveSignals == 11
    assert registry.plannedSignals == 18
    assert registry.remainingSignals == 0
    assert len(registry.categories) == 8
    assert len(registry.signals) == 29
    assert sum(category.weight for category in registry.categories) == pytest.approx(100)
    assert {
        category.id: category.configuredSignals for category in registry.categories
    } == EXPECTED_CATEGORY_COUNTS


def test_registry_keeps_planned_signals_out_of_executable_engine_config():
    config = _config()

    assert len(config["signals"]) == 11
    assert len(config["planned_signals"]) == 18


def test_registry_signal_ids_are_unique():
    config = _config()
    config["planned_signals"].append(dict(config["signals"][0]))

    with pytest.raises(ValueError, match="registry signal ids must be unique"):
        build_registry(config)


def test_registry_rejects_unknown_category():
    config = _config()
    config["planned_signals"][0]["category"] = "not-a-category"

    with pytest.raises(ValueError, match="references unknown category"):
        build_registry(config)


def test_registry_endpoint_exposes_live_and_planned_counts():
    response = TestClient(app).get("/risk29/registry.json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["registryVersion"] == "risk29-proposed-v1"
    assert payload["targetSignals"] == 29
    assert payload["configuredSignals"] == 29
    assert payload["liveSignals"] == 11
    assert payload["plannedSignals"] == 18
    assert payload["remainingSignals"] == 0
