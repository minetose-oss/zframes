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

from risk29_health_validator import validate

LIVE = "https://risk29-engine-phase1b-live.vercel.app/risk29"
FALLBACK = "https://raw.githubusercontent.com/minetose-oss/zframes/risk29-live-data/risk29"


def get_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "risk29-health-probe/1.0", "Accept": "application/json"})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def probe() -> dict:
    failures = []
    for label, base in (("live", LIVE), ("github-fallback", FALLBACK)):
        try:
            brief = get_json(f"{base}/brief-th.json")
            latest = get_json(f"{base}/latest.json")
            result = validate(brief, latest, source=label)
            result["probeFailures"] = failures
            # Invalid live snapshots must not be silently accepted as healthy.
            if result["decisionGate"] != "FAIL":
                return result
            failures.append({"source": label, "reason": "; ".join(result["errors"])})
        except (HTTPError, URLError, TimeoutError, ValueError, OSError, RuntimeError, json.JSONDecodeError) as exc:
            failures.append({"source": label, "reason": str(exc)[:500]})
    return {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUsed": "none", "freshnessPass": False, "decisionGate": "FAIL",
        "currentScore": None, "currentState": None,
        "comparison": {"status": "COMPARISON UNAVAILABLE"},
        "probeFailures": failures,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="risk29-data-health.json")
    args = parser.parse_args()
    result = probe()
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"source": result["sourceUsed"], "gate": result["decisionGate"],
                      "failures": result.get("probeFailures", [])}))
    if result["decisionGate"] == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main()
