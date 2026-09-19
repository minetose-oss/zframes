from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from risk29_engine.registry import build_registry


def _config() -> dict:
    path = Path(__file__).parents[1] / "risk29_engine" / "signals.yaml"
    return yaml.safe_load(path.read_text())


def test_registry_reports_current_10_of_29_without_inventing_future_signals():
    registry = build_registry(_config())

    assert registry.registryVersion == "risk29-registry-v1"
    assert registry.targetSignals == 29
    assert registry.configuredSignals == 10
    assert registry.remainingSignals == 19
    assert len(registry.categories) == 8
    assert len(registry.signals) == 10
    assert sum(category.weight for category in registry.categories) == pytest.approx(100)


def test_registry_signal_ids_are_unique():
    config = _config()
    config["signals"].append(dict(config["signals"][0]))

    with pytest.raises(ValueError, match="registry signal ids must be unique"):
        build_registry(config)


def test_registry_rejects_unknown_category():
    config = _config()
    config["signals"][0]["category"] = "not-a-category"

    with pytest.raises(ValueError, match="references unknown category"):
        build_registry(config)
