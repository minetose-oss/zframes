"""Build a fail-closed semiconductor recovery snapshot from non-Yahoo daily data.

Primary source is Nasdaq's public historical endpoint. A full series never mixes
providers. Twelve Data (when configured) or Stooq is used only as an independent
latest-close cross-check.
"""
import csv
import io
import json
import math
import os
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

from decision_validation import technical

ROOT = Path(__file__).resolve().parent
OUTPUT = Path(os.getenv("SEMICONDUCTOR_OUTPUT_PATH", ROOT / "semiconductor-latest.json"))
ETFS = ("SMH", "SOXX")
LEADERS = ("NVDA", "AVGO", "TSM", "ASML", "AMD", "MU")
MIN_SESSIONS = 220
MISMATCH_TOLERANCE_PCT = float(os.getenv("PROVIDER_MISMATCH_TOLERANCE_PCT", "0.75"))


def request_json(url):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 Risk29-DataMonitor/2.0",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def number(value):
    if value is None:
        raise ValueError("missing numeric value")
    cleaned = str(value).replace("$", "").replace(",", "").strip()
    return float(cleaned)


def fetch_nasdaq(symbol, assetclass="stocks"):
    query = urllib.parse.urlencode({"assetclass": assetclass, "limit": 5000})
    url = f"https://api.nasdaq.com/api/quote/{symbol}/historical?{query}"
    payload = request_json(url)
    rows = (((payload or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
    records = []
    for row in rows:
        try:
            raw_date = row.get("date")
            parsed = datetime.strptime(raw_date, "%m/%d/%Y").date().isoformat()
            records.append({"date": parsed, "close": number(row.get("close")), "volume": number(row.get("volume"))})
        except (TypeError, ValueError):
            continue
    if len(records) < MIN_SESSIONS:
        raise ValueError(f"Nasdaq returned {len(records)} valid sessions; {MIN_SESSIONS} required")
    records.sort(key=lambda item: item["date"])
    return records, url


def fetch_twelve_latest(symbol):
    key = os.getenv("TWELVE_DATA_API_KEY")
    if not key:
        return None
    query = urllib.parse.urlencode(
        {"symbol": symbol, "interval": "1day", "outputsize": 5, "apikey": key, "format": "JSON"}
    )
    payload = request_json("https://api.twelvedata.com/time_series?" + query)
    values = payload.get("values") or []
    if not values:
        raise ValueError(payload.get("message", "Twelve Data returned no values"))
    latest = max(values, key=lambda item: item["datetime"])
    return {"provider": "Twelve Data", "date": latest["datetime"][:10], "close": number(latest["close"])}


def fetch_stooq_latest(symbol):
    url = "https://stooq.com/q/d/l/?" + urllib.parse.urlencode({"s": symbol.lower() + ".us", "i": "d"})
    request = urllib.request.Request(url, headers={"User-Agent": "Risk29-DataMonitor/2.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        body = response.read(3_000_000).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(body)))
    valid = []
    for row in rows:
        try:
            valid.append({"date": date.fromisoformat(row["Date"]).isoformat(), "close": number(row["Close"])})
        except (KeyError, TypeError, ValueError):
            continue
    if not valid:
        return None
    latest = max(valid, key=lambda item: item["date"])
    return {"provider": "Stooq", **latest}


def independent_close(symbol):
    try:
        result = fetch_twelve_latest(symbol)
        if result:
            return result
    except Exception as exc:
        return {"provider": "Twelve Data", "status": "ERROR", "reason": str(exc)[:160]}
    try:
        return fetch_stooq_latest(symbol)
    except Exception as exc:
        return {"provider": "Stooq", "status": "UNAVAILABLE", "reason": str(exc)[:160]}


def corporate_action_check(records):
    exceptions = []
    for previous, current in zip(records[-260:-1], records[-259:]):
        move = abs(current["close"] / previous["close"] - 1)
        if move > 0.45:
            exceptions.append({"date": current["date"], "closeMovePct": round(move * 100, 2)})
    return exceptions


def calculate(symbol, records):
    path = ROOT / ("_" + symbol.lower() + "_prices.csv")
    try:
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["date", "close", "volume"])
            writer.writeheader()
            writer.writerows(records)
        return technical(path, symbol)
    finally:
        path.unlink(missing_ok=True)


def run():
    now = datetime.now(timezone.utc)
    result = {
        "schemaVersion": "2.0",
        "generatedAt": now.isoformat(),
        "provider": "Nasdaq",
        "providerType": "daily historical close/volume",
        "seriesPolicy": "one provider per complete series; no provider splicing",
        "minimumSessions": MIN_SESSIONS,
        "symbols": {},
        "leaders": {},
        "crossChecks": {},
        "corporateActionExceptions": {},
        "breadth": {},
        "etfFlows": {
            "status": "UNVERIFIED",
            "reason": "No verified net creation/redemption feed configured; price, volume and AUM are not treated as flows.",
        },
        "overall": "TECHNICAL DATA GAP",
        "buySignalEligible": False,
        "vetoes": [],
    }

    for symbol in ETFS + LEADERS:
        assetclass = "etf" if symbol in ETFS else "stocks"
        try:
            records, source_url = fetch_nasdaq(symbol, assetclass)
            exceptions = corporate_action_check(records)
            value = calculate(symbol, records)
            value["sourceUrl"] = source_url
            value["corporateActionContinuity"] = "PASS" if not exceptions else "REVIEW"
            target = result["symbols"] if symbol in ETFS else result["leaders"]
            target[symbol] = value
            if exceptions:
                result["corporateActionExceptions"][symbol] = exceptions
                result["vetoes"].append(f"{symbol}: unverified large price discontinuity")
            if symbol in ETFS:
                check = independent_close(symbol)
                result["crossChecks"][symbol] = check or {"status": "VERIFICATION UNAVAILABLE"}
                if check and check.get("close") and check.get("date") == value.get("cutoff"):
                    mismatch = abs(value["close"] / check["close"] - 1) * 100
                    result["crossChecks"][symbol]["mismatchPct"] = round(mismatch, 4)
                    if mismatch > MISMATCH_TOLERANCE_PCT:
                        result["vetoes"].append(
                            f"{symbol}: PROVIDER_MISMATCH {mismatch:.3f}% exceeds {MISMATCH_TOLERANCE_PCT}%"
                        )
        except Exception as exc:
            target = result["symbols"] if symbol in ETFS else result["leaders"]
            target[symbol] = {"symbol": symbol, "status": "TECHNICAL DATA GAP", "reason": str(exc)[:180]}

    usable_leaders = [
        value for value in result["leaders"].values()
        if value.get("sessions", 0) >= MIN_SESSIONS
    ]
    above_50 = [value for value in usable_leaders if value.get("closeVsEmaPct", {}).get("50", -math.inf) > 0]
    above_200 = [value for value in usable_leaders if value.get("closeVsEmaPct", {}).get("200", -math.inf) > 0]
    result["breadth"] = {
        "universe": list(LEADERS),
        "usable": len(usable_leaders),
        "aboveEma50": len(above_50),
        "aboveEma200": len(above_200),
        "aboveEma50Pct": round(100 * len(above_50) / len(usable_leaders), 2) if usable_leaders else 0,
        "status": "PASS" if len(usable_leaders) >= 5 and len(above_50) >= 4 and len(above_200) >= 4 else "NOT CONFIRMED",
    }

    etfs_ready = all(
        value.get("sessions", 0) >= MIN_SESSIONS
        and value.get("closeVsEmaPct", {}).get("20", -math.inf) > 0
        and value.get("closeVsEmaPct", {}).get("50", -math.inf) > 0
        and value.get("closeVsEmaPct", {}).get("200", -math.inf) > 0
        and value.get("state") != "BREAKDOWN"
        for value in result["symbols"].values()
    )
    if not all(value.get("sessions", 0) >= MIN_SESSIONS for value in result["symbols"].values()):
        result["vetoes"].append("TECHNICAL DATA GAP: SMH/SOXX require at least 220 valid sessions")
    if result["breadth"]["status"] != "PASS":
        result["vetoes"].append("Breadth/leader recovery not confirmed")

    if etfs_ready and result["breadth"]["status"] == "PASS" and not result["vetoes"]:
        result["overall"] = "RECOVERY CONFIRMED"
        result["buySignalEligible"] = True
    elif all(value.get("sessions", 0) >= MIN_SESSIONS for value in result["symbols"].values()):
        result["overall"] = "CALCULATED — RECOVERY NOT CONFIRMED"

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    run()
