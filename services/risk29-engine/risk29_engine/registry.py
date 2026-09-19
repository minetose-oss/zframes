from __future__ import annotations

from typing import Any

from .models import Risk29Registry, Risk29RegistryCategory, Risk29RegistrySignal


def build_registry(config: dict[str, Any]) -> Risk29Registry:
    categories_cfg = config.get("categories", {})
    live_cfg = [dict(signal, status="live") for signal in config.get("signals", [])]
    planned_cfg = [
        dict(signal, status="planned") for signal in config.get("planned_signals", [])
    ]
    signals_cfg = [*live_cfg, *planned_cfg]

    if not isinstance(categories_cfg, dict):
        raise ValueError("Risk29 categories config must be a mapping")

    category_ids = set(categories_cfg)
    for signal in signals_cfg:
        category = signal.get("category")
        if category not in category_ids:
            raise ValueError(
                f"signal {signal.get('id', '<unknown>')} references unknown category {category!r}"
            )

    signals = [
        Risk29RegistrySignal(
            id=str(signal["id"]),
            label=str(signal["label"]),
            category=signal["category"],
            status=signal["status"],
            source=str(signal["source"]),
            sourceSeries=signal.get("source_series"),
            unit=str(signal["unit"]),
            transform=str(signal["transform"]),
        )
        for signal in signals_cfg
    ]

    categories = []
    for category_id, category_cfg in categories_cfg.items():
        category_signals = [
            signal for signal in signals if signal.category == category_id
        ]
        categories.append(
            Risk29RegistryCategory(
                id=category_id,
                label=str(category_cfg["label"]),
                weight=float(category_cfg["weight"]),
                configuredSignals=len(category_signals),
                liveSignals=sum(signal.status == "live" for signal in category_signals),
                plannedSignals=sum(
                    signal.status == "planned" for signal in category_signals
                ),
            )
        )

    target_signals = int(config.get("target_signal_count", 29))
    configured_signals = len(signals)
    live_signals = sum(signal.status == "live" for signal in signals)
    planned_signals = sum(signal.status == "planned" for signal in signals)

    return Risk29Registry(
        registryVersion=str(config.get("registry_version", "risk29-registry-v1")),
        modelVersion=str(config["model_version"]),
        thresholdVersion=str(config["threshold_version"]),
        targetSignals=target_signals,
        configuredSignals=configured_signals,
        liveSignals=live_signals,
        plannedSignals=planned_signals,
        remainingSignals=target_signals - configured_signals,
        categories=categories,
        signals=signals,
    )
