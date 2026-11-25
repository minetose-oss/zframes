"""Read Risk29 live endpoints first; use same-source GitHub fallback on failure.

No credentials required. Emits a JSON report even if every endpoint fails.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if __package__:
    from .risk29_health_validator import validate
else:
    from risk29_health_validator import validate

LIVE = "https://risk29-engine-phase1b-live.vercel.app/risk29"
FALLBACK = "https://raw.githubusercontent.com/minetose-oss/zframes/risk29-live-data/risk29"


def get_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "risk29-health-probe/1.0", "Accept": "application/json"})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def compare_sync(live: dict, durable: dict) -> dict:
    if not live.get("generatedAt") or not durable.get("generatedAt"):
        return {"status": "UNKNOWN"}
    return {"status": "PASS" if live == durable else "MISMATCH",
            "liveGeneratedAt": live["generatedAt"],
            "githubGeneratedAt": durable["generatedAt"]}


def probe() -> dict:
    failures = []
    endpoints = {}
    for label, base in (("live", LIVE), ("github-fallback", FALLBACK)):
        try:
            payloads = {}
            for name in ("brief-th.json", "latest.json"):
                url = f"{base}/{name}"
                key = f"{label}/{name}"
                try:
                    payloads[name] = get_json(url)
                    endpoints[key] = {"httpStatus": 200, "ok": True}
                except HTTPError as exc:
                    endpoints[key] = {"httpStatus": exc.code, "ok": False, "error": str(exc)[:250]}
                except (URLError, TimeoutError, ValueError, OSError, RuntimeError) as exc:
                    endpoints[key] = {"httpStatus": None, "ok": False, "error": str(exc)[:250]}
            if len(payloads) != 2:
                raise RuntimeError("endpoint failure: " + ", ".join(
                    f"{key}={value['httpStatus']}" for key, value in endpoints.items()
                    if key.startswith(label + "/") and not value["ok"]))
            brief = payloads["brief-th.json"]
            latest = payloads["latest.json"]
            result = validate(brief, latest, source=label)
            result["probeFailures"] = failures
            result["endpoints"] = endpoints
            # Invalid live snapshots must not be silently accepted as healthy.
            if result["decisionGate"] != "FAIL":
                if label == "live":
                    result["liveApiHealth"] = "PASS"
                    result["fallbackHealth"] = "NOT_USED"
                    try:
                        durable = get_json(f"{FALLBACK}/latest.json")
                        result["productionSync"] = compare_sync(latest, durable)
                    except (HTTPError, URLError, TimeoutError, ValueError, OSError, RuntimeError):
                        result["productionSync"] = {"status": "UNKNOWN"}
                    if result["productionSync"]["status"] != "PASS":
                        result["decisionGate"] = "FAIL"
                        result.setdefault("errors", []).append("Production snapshot sync not verified")
                    return result
                # Fallback is diagnostic only; it must not mask a broken live API.
                result["liveApiHealth"] = "FAIL"
                result["fallbackHealth"] = "PASS"
                result["decisionGate"] = "FAIL"
                result["errors"] = ["Production API unavailable; fallback snapshot is not production health"]
                return result
            failures.append({"source": label, "reason": "; ".join(result["errors"])})
        except (HTTPError, URLError, TimeoutError, ValueError, OSError, RuntimeError, json.JSONDecodeError) as exc:
            failures.append({"source": label, "reason": str(exc)[:500]})
    return {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUsed": "none", "freshnessPass": False, "decisionGate": "FAIL",
        "liveApiHealth": "FAIL", "fallbackHealth": "FAIL",
        "currentScore": None, "currentState": None,
        "comparison": {"status": "COMPARISON UNAVAILABLE"},
        "probeFailures": failures,
        "endpoints": endpoints,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="risk29-data-health.json")
    args = parser.parse_args()
    result = probe()
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"source": result["sourceUsed"], "gate": result["decisionGate"],
                      "failures": result.get("probeFailures", []),
                      "endpoints": result.get("endpoints", {})}))
    if result["decisionGate"] == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main()
