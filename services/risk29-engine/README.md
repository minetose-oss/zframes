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

## Phase 1B — Vercel preview deployment

The service includes `app.py`, `requirements.txt`, and `vercel.json` so the directory can be imported as a standalone Vercel project.

Recommended Vercel project settings:

```text
Root Directory: services/risk29-engine
Framework Preset: Other / FastAPI auto-detect
Build Command: leave empty
Output Directory: leave empty
```

`app.py` points Vercel's writable state at `/tmp/risk29-engine`. This is sufficient for Phase 1B preview/runtime validation but **not durable history storage**: serverless instances can be recycled at any time. A persistent store is a later phase requirement before Risk29 history is considered production-grade.

The zframes plugin can still use same-origin `/risk29/*` by default. For split deployments, the host page may set this before the runtime bundle loads:

```html
<script>
  globalThis.__RISK29_BASE_URL__ = "https://your-risk29-engine.vercel.app";
</script>
```

The plugin then sends snapshot/history requests to that engine origin; the engine enables GET CORS for preview use.

For the Phase 1B visual end-to-end preview we can also place a thin same-origin Vercel rewrite in front of the Phase 0 actual runtime: `/risk29/*` rewrites to the live engine while all other paths rewrite to the already-QA'd zframes runtime bundle. This proves live data wiring without rebuilding or duplicating presentation code.

This preview topology is intentionally temporary. Production should use a durable engine deployment plus persistent history storage and explicit origins rather than relying on ephemeral preview rewrites.

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
RISK29_CORS_ORIGINS=*
```

No API keys are required for the Phase 1A/1B source set.
