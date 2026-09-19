from __future__ import annotations

from typing import Any

from .models import Risk29Registry, Risk29RegistryCategory, Risk29RegistrySignal


def build_registry(config: dict[str, Any]) -> Risk29Registry:
    categories_cfg = config.get("categories", {})
    signals_cfg = list(config.get("signals", []))

    if not isinstance(categories_cfg, dict):
        raise ValueError("Risk29 categories config must be a mapping")

    category_ids = set(categories_cfg)
    for signal in signals_cfg:
        category = signal.get("category")
        if category not in category_ids:
            raise ValueError(
                f"signal {signal.get('id', '<unknown>')} references unknown category {category!r}"
            )

    configured_by_category = {
        category_id: sum(signal.get("category") == category_id for signal in signals_cfg)
        for category_id in categories_cfg
    }

    categories = [
        Risk29RegistryCategory(
            id=category_id,
            label=str(category_cfg["label"]),
            weight=float(category_cfg["weight"]),
            configuredSignals=configured_by_category[category_id],
        )
        for category_id, category_cfg in categories_cfg.items()
    ]

    signals = [
        Risk29RegistrySignal(
            id=str(signal["id"]),
            label=str(signal["label"]),
            category=signal["category"],
            source=str(signal["source"]),
            sourceSeries=signal.get("source_series"),
            unit=str(signal["unit"]),
            transform=str(signal["transform"]),
        )
        for signal in signals_cfg
    ]

    target_signals = int(config.get("target_signal_count", 29))
    configured_signals = len(signals)

    return Risk29Registry(
        registryVersion=str(config.get("registry_version", "risk29-registry-v1")),
        modelVersion=str(config["model_version"]),
        thresholdVersion=str(config["threshold_version"]),
        targetSignals=target_signals,
        configuredSignals=configured_signals,
        remainingSignals=target_signals - configured_signals,
        categories=categories,
        signals=signals,
    )
