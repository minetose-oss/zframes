"""Validate Risk29 published snapshots without turning missing data into zero."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
from typing import Any

EXPECTED_SIGNALS = 29
ALLOWED_FRESHNESS = {"fresh", "delayed", "stale", "missing", "unavailable", "error"}
REQUIRED_BRIEF = {"generatedAt", "score", "state", "confidence"}
REQUIRED_LATEST = {"generatedAt", "score", "state", "signals"}


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.astimezone(timezone.utc)


def validate(brief: dict, latest: dict, *, now: datetime | None = None,
             source: str = "unknown", previous: dict | None = None) -> dict:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    errors = []
    for name, payload, required in (
        ("brief", brief, REQUIRED_BRIEF), ("latest", latest, REQUIRED_LATEST)
    ):
        if not isinstance(payload, dict):
            raise ValueError(f"{name}: expected object")
        missing = required - payload.keys()
        if missing:
            errors.append(f"{name}: missing fields {sorted(missing)}")
    try:
        bt = parse_timestamp(brief.get("generatedAt"))
        lt = parse_timestamp(latest.get("generatedAt"))
        age = (now - bt).total_seconds()
    except (ValueError, TypeError) as exc:
        errors.append(f"timestamp: {exc}")
        bt = lt = None
        age = None
    if bt is not None and (age < -300 or age > 86400):
        errors.append("payload timestamp outside accepted 24h window")
    if bt is not None and lt is not None and bt != lt:
        errors.append("generatedAt mismatch")
    if brief.get("score") != latest.get("score") or brief.get("state") != latest.get("state"):
        errors.append("score/state mismatch")
    signals = latest.get("signals")
    if not isinstance(signals, list):
        errors.append("signals is not a list")
        signals = []
    ids = [s.get("id") for s in signals if isinstance(s, dict)]
    if len(signals) != EXPECTED_SIGNALS or len(set(ids)) != EXPECTED_SIGNALS or None in ids:
        errors.append("expected 29 distinct signal IDs")
    counts = Counter()
    exceptions = []
    for s in signals:
        if not isinstance(s, dict):
            counts["unknown"] += 1
            continue
        freshness = s.get("freshness")
        if freshness not in ALLOWED_FRESHNESS:
            freshness = "unknown"
        counts[freshness] += 1
        if freshness in {"stale", "missing", "unavailable", "error", "unknown"}:
            exceptions.append({k: s.get(k) for k in ("id", "category", "asOf", "ageSeconds", "reason", "freshness")})
    available = counts["fresh"] + counts["delayed"] + counts["stale"]
    comparison = {"status": "COMPARISON UNAVAILABLE"}
    if isinstance(previous, dict):
        try:
            prev_at = parse_timestamp(previous.get("generatedAt"))
            if bt and prev_at < bt and isinstance(previous.get("score"), (int, float)):
                comparison = {
                    "status": "AVAILABLE",
                    "previousGeneratedAt": prev_at.isoformat(),
                    "scoreDelta": round(brief["score"] - previous["score"], 4),
                    "previousState": previous.get("state"),
                    "stateChanged": previous.get("state") != brief.get("state"),
                }
        except (ValueError, TypeError, KeyError):
            pass
    consistency = "CONSISTENCY WARNING" if any("mismatch" in e for e in errors) else "PASS"
    return {
        "checkedAt": now.isoformat(), "sourceUsed": source,
        "generatedAt": brief.get("generatedAt"), "payloadAgeSeconds": age,
        "freshnessPass": age is not None and 0 <= age <= 86400 and not errors,
        "confidence": brief.get("confidence", "unknown"),
        "counts": {k: counts[k] for k in ("fresh", "delayed", "stale", "missing", "unavailable", "error", "unknown")},
        "totalSignals": len(signals),
        "availableCoveragePct": round(100 * available / EXPECTED_SIGNALS, 2),
        "freshCoveragePct": round(100 * counts["fresh"] / EXPECTED_SIGNALS, 2),
        "exceptions": exceptions, "consistency": consistency,
        "comparison": comparison, "errors": errors,
        "decisionGate": "FAIL" if errors else ("WARNING" if brief.get("confidence") == "degraded" or counts["stale"] or counts["unknown"] else "PASS"),
        "currentScore": brief.get("score") if not errors else None,
        "currentState": brief.get("state") if not errors else None,
    }


def main() -> None:
    import argparse
    from pathlib import Path
    p = argparse.ArgumentParser()
    p.add_argument("--brief", required=True)
    p.add_argument("--latest", required=True)
    p.add_argument("--previous")
    p.add_argument("--output", default="risk29/data-health.json")
    args = p.parse_args()
    def read(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))
    result = validate(read(args.brief), read(args.latest),
                      previous=read(args.previous) if args.previous else None,
                      source="local-files")
    dest = Path(args.output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"decisionGate": result["decisionGate"], "errors": result["errors"]}))
    if result["decisionGate"] == "FAIL":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
