# Risk29 Engine — Phase 1

This service is the calculation layer behind the Risk29 zframes plugin. It fetches public market data, normalizes the first 10 Risk29 signals, applies **provisional/versioned** scoring rules, aggregates categories, derives the overall score/regime, and publishes the exact JSON contract consumed by `@zframes/provider-risk29`.

## Phase 1A scope

Real public data sources:

- FRED chart CSV: VIX, S&P 500, Nasdaq Composite, HY OAS, IG OAS, 10Y TIPS real yield, broad dollar index
- U.S. Treasury daily yield curve: 2Y/10Y spread
- OFR Financial Stress Index CSV
- LBMA gold PM fix history

Endpoints:

```text
GET /healthz
GET /risk29/latest.json
GET /risk29/history.json?days=30
```

The initial thresholds are intentionally labelled `risk29-p1-provisional-v1`. They are engineering defaults for proving the live data pipeline and **must be backtested before production investment use**.

## Run locally

```bash
cd services/risk29-engine
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e '.[test]'
uvicorn risk29_engine.main:app --reload --port 8000
```

Then inspect:

```text
http://127.0.0.1:8000/risk29/latest.json
http://127.0.0.1:8000/risk29/history.json?days=30
```

## Reliability rules

- A failed source becomes `freshness=error`, `state=unavailable`, `value=null`, `riskScore=null`.
- Stale values remain visibly stale and are excluded from category/overall scoring.
- Missing categories remain `unavailable`; they never contribute zero risk.
- Every scoring configuration is versioned.
- Snapshot history is appended only when a new engine refresh succeeds. Local history is stored in `.data/` by default and can be redirected with `RISK29_DATA_DIR`.

## Environment

```text
RISK29_DATA_DIR=/persistent/path
RISK29_REFRESH_SECONDS=300
RISK29_HTTP_TIMEOUT_SECONDS=20
```

No API keys are required for the Phase 1A source set.
