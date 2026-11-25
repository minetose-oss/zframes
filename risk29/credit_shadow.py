"""Observe issuer credit evidence without changing the live Gate 3 decision."""

import argparse
import json
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ISSUERS = {"ORCL": 1341439, "MSFT": 789019, "AMZN": 1018724, "META": 1326801}
SEC = "https://data.sec.gov"
OCF = "NetCashProvidedByUsedInOperatingActivities"
CAPEX = "PaymentsToAcquirePropertyPlantAndEquipment"
FINRA = "https://www.finra.org/finra-data/fixed-income"


def sec_json(url):
    agent = os.environ.get(
        "SEC_USER_AGENT", "Risk29 Credit Shadow (https://github.com/minetose-oss/zframes)"
    )
    with urlopen(Request(url, headers={"User-Agent": agent}), timeout=15) as response:
        return json.load(response)


def period_facts(gaap, tag, as_of, nonnegative=False):
    result = {}
    for row in gaap.get(tag, {}).get("units", {}).get("USD", []):
        try:
            start, end, filed = (date.fromisoformat(row[k]) for k in ("start", "end", "filed"))
            accn, value = row["accn"], row["val"]
            if (
                row["form"] not in {"10-K", "10-Q", "10-K/A", "10-Q/A"}
                or not start < end <= filed <= as_of
                or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accn)
                or type(value) is not int
                or (nonnegative and value < 0)
            ):
                continue
        except (KeyError, TypeError, ValueError):
            continue
        result.setdefault((end, start, filed, accn), set()).add(value)
    return result


def filing_url(cik, accession):
    return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{accession}-index.htm"


def fundamentals(payload, cik, as_of):
    gaap = payload["facts"]["us-gaap"]
    ocf = period_facts(gaap, OCF, as_of)
    capex = period_facts(gaap, CAPEX, as_of, nonnegative=True)
    if not ocf:
        return {"status": "DATA GAP", "reason": "No usable USD operating cash flow facts"}
    # Do not silently fall back to an older period if the newest filing is incomplete.
    latest_end = max(key[0] for key in ocf)
    candidates = [key for key in ocf.keys() & capex.keys() if key[0] == latest_end]
    if not candidates:
        return {"status": "DATA GAP", "periodEnd": latest_end.isoformat(),
                "reason": "No same-filing, same-period cash flow and capex pair"}
    newest_filed = max(key[2] for key in ocf if key[0] == latest_end)
    candidates = [key for key in candidates if key[2] == newest_filed]
    if not candidates:
        return {"status": "DATA GAP", "periodEnd": latest_end.isoformat(),
                "reason": "Newest cash flow filing lacks a matching capex fact"}
    # Prefer the longest explicitly reported duration in the newest filing (usually YTD).
    key = max(candidates, key=lambda k: ((k[0] - k[1]).days, k[3]))
    end, start, filed, accession = key
    if len(ocf[key]) != 1 or len(capex[key]) != 1:
        return {"status": "DATA GAP", "reason": "Conflicting facts for the same filing and duration"}
    operating_cash, capital_spend = next(iter(ocf[key])), next(iter(capex[key]))
    fcf = operating_cash - capital_spend
    return {
        "status": "OBSERVED" if (as_of - end).days <= 150 else "STALE",
        "asOf": end.isoformat(), "periodStart": start.isoformat(), "filedAt": filed.isoformat(),
        "periodBasis": "reported duration; not annualized or TTM",
        "operatingCashFlowUsd": operating_cash, "cashCapexUsd": capital_spend,
        "freeCashFlowUsd": fcf, "capexToFcfRatio": capital_spend / fcf if fcf > 0 else None,
        "capexToFcfStatus": "OBSERVED" if fcf > 0 else "NOT MEANINGFUL: FCF <= 0",
        "sourceUrl": filing_url(cik, accession),
    }


def financing_filings(payload, cik, as_of):
    recent = payload["filings"]["recent"]
    rows = []
    for form, items, filed, accession in zip(
        *(recent[k] for k in ("form", "items", "filingDate", "accessionNumber")), strict=True
    ):
        if form not in {"8-K", "8-K/A"} or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
            continue
        filing_date = date.fromisoformat(filed)
        if 0 <= (as_of - filing_date).days <= 120 and "2.03" in items.split(","):
            rows.append({"filedAt": filed, "item": "2.03", "sourceUrl": filing_url(cik, accession)})
    return {"status": "REQUIRES REVIEW", "lookbackCalendarDays": 120,
            "filings": rows, "note": "Filing leads only; absence is not evidence of no refinancing or stress."}


def observe(fetch=sec_json, now=None):
    now = now or datetime.now(timezone.utc)
    issuers = {}
    for ticker, cik in ISSUERS.items():
        companyfacts = f"{SEC}/api/xbrl/companyfacts/CIK{cik:010}.json"
        submissions = f"{SEC}/submissions/CIK{cik:010}.json"
        entry = {"cik": cik, "fundamentalsSource": companyfacts, "filingsSource": submissions,
                 "cds": {"status": "UNAVAILABLE", "reason": "No verified issuer CDS source configured"},
                 "bondMarket": {"status": "UNVERIFIED", "referenceUrl": FINRA,
                                "reason": "No verified, authorized issue-level print and benchmark history"}}
        for field, url, parse in (("fundamentals", companyfacts, fundamentals),
                                  ("refinancing", submissions, financing_filings)):
            try:
                entry[field] = parse(fetch(url), cik, now.date())
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, TypeError, AttributeError) as err:
                entry[field] = {"status": "UNAVAILABLE", "reason": type(err).__name__}
                if isinstance(err, HTTPError):
                    entry[field]["httpStatus"] = err.code
        issuers[ticker] = entry
    return {
        "generatedAt": now.isoformat(), "mode": "SHADOW", "status": "CREDIT DATA GAP",
        "buySignalEligible": False, "stabilization": "NOT VERIFIED", "issuers": issuers,
        "coverage": {
            "issuerCount": len(issuers),
            "fundamentalsObserved": sum(v["fundamentals"]["status"] == "OBSERVED" for v in issuers.values()),
            "bondMarketVerified": 0, "cdsVerified": 0,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = observe()
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "coverage": result["coverage"]}))


if __name__ == "__main__":
    main()
