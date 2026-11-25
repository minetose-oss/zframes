"""Fail-closed validation for Risk29 brief/latest snapshots (stdlib only)."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

UTC = dt.timezone.utc
BAD = {"stale", "missing", "unavailable", "error"}
KNOWN = {"fresh", "delayed"} | BAD
BASE = "https://risk29-engine-phase1b-live.vercel.app/risk29/"
FALLBACK = "https://raw.githubusercontent.com/minetose-oss/zframes/risk29-live-data/risk29/"


def read_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=12) as response:
        obj = json.load(response)
    if not isinstance(obj, dict):
        raise ValueError("payload must be an object")
    return obj


def parse_time(value: object) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("missing timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return parsed.astimezone(UTC)


def validate(brief: dict, latest: dict, now: dt.datetime | None = None) -> dict:
    now = (now or dt.datetime.now(UTC)).astimezone(UTC)
    errors = []
    warnings = []
    try:
        bt, lt = parse_time(brief.get("generatedAt")), parse_time(latest.get("generatedAt"))
        age = (now - bt).total_seconds()
        if not 0 <= age <= 86400:
            errors.append("DATA HEALTH WARNING: brief older than 24h or future-dated")
        if not 0 <= (now - lt).total_seconds() <= 86400:
            errors.append("DATA HEALTH WARNING: latest older than 24h or future-dated")
        if bt != lt:
            errors.append("CONSISTENCY WARNING: generatedAt mismatch")
    except (ValueError, TypeError) as exc:
        age = None
        errors.append(f"DATA HEALTH WARNING: {exc}")
    for field in ("score", "state"):
        if brief.get(field) is None or latest.get(field) is None:
            errors.append(f"DATA HEALTH WARNING: missing {field}")
        elif brief[field] != latest[field]:
            errors.append(f"CONSISTENCY WARNING: {field} mismatch")
    if brief.get("schemaVersion") != latest.get("schemaVersion"):
        errors.append("CONSISTENCY WARNING: schemaVersion mismatch")
    if brief.get("runId") is not None or latest.get("runId") is not None:
        if not brief.get("runId") or brief.get("runId") != latest.get("runId"):
            errors.append("CONSISTENCY WARNING: runId mismatch")
    signals = latest.get("signals")
    if not isinstance(signals, list) or not signals:
        errors.append("DATA HEALTH WARNING: signals unavailable")
        signals = []
    counts = Counter(str(s.get("freshness", "unknown")).lower() for s in signals if isinstance(s, dict))
    unknown = sum(1 for s in signals if not isinstance(s, dict))
    counts["unknown"] += unknown
    if counts["unknown"] or any(k not in KNOWN for k in counts):
        warnings.append("unknown freshness statuses; do not treat as zero risk")
    total = len(signals) if signals else None
    usable = counts["fresh"] + counts["delayed"]
    coverage = round(100 * usable / total, 2) if total else None
    delayed = counts["delayed"]
    if delayed:
        warnings.append(f"{delayed} delayed observations; generatedAt freshness != observation freshness")
    problems = [
        {"id": s.get("id"), "category": s.get("category"), "asOf": s.get("asOf"),
         "ageSeconds": s.get("ageSeconds"), "reason": s.get("reason"),
         "freshness": s.get("freshness")}
        for s in signals if isinstance(s, dict)
        and str(s.get("freshness", "unknown")).lower() not in {"fresh", "delayed"}
    ]
    # A top-level confidence of normal does not override signal freshness.
    confidence = brief.get("confidence", "unknown")
    if confidence == "degraded":
        warnings.append("engine reports degraded confidence")
    health = brief.get("dataHealth")
    if isinstance(health, dict):
        for field, calculated in (("totalSignals", total), ("usableCoveragePct", coverage)):
            if field in health and health[field] != calculated:
                errors.append(f"CONSISTENCY WARNING: brief.dataHealth.{field} mismatch")
    return {
        "decisionAllowed": not errors,
        "confidence": confidence,
        "score": brief.get("score") if not errors else None,
        "state": brief.get("state") if not errors else None,
        "generatedAt": brief.get("generatedAt"),
        "payloadAgeSeconds": round(age) if age is not None else None,
        "totalSignals": total,
        "usableCoveragePct": coverage,
        "fresh": counts["fresh"],
        "delayed": counts["delayed"],
        "stale": counts["stale"],
        "missingUnavailable": counts["missing"] + counts["unavailable"],
        "error": counts["error"],
        "unknown": counts["unknown"],
        "problemSignals": problems,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--brief", type=Path)
    parser.add_argument("--latest", type=Path)
    args = parser.parse_args()
    if bool(args.brief) != bool(args.latest):
        parser.error("--brief and --latest must be supplied together")
    try:
        if args.brief:
            brief, latest = json.loads(args.brief.read_text()), json.loads(args.latest.read_text())
            source = "local"
        else:
            try:
                brief, latest = read_json(BASE + "brief-th.json"), read_json(BASE + "latest.json")
                source = "production"
            except (OSError, ValueError, json.JSONDecodeError):
                brief, latest = read_json(FALLBACK + "brief-th.json"), read_json(FALLBACK + "latest.json")
                source = "github-fallback"
        result = validate(brief, latest)
        result["source"] = source
    except Exception as exc:
        result = {"decisionAllowed": False, "source": "unavailable",
                  "errors": [f"DATA HEALTH WARNING: {type(exc).__name__}: {exc}"]}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["decisionAllowed"] else 2


if __name__ == "__main__":
    sys.exit(main())
