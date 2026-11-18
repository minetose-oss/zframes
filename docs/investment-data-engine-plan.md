# Investment Data Engine — Phase 1 (Risk29 + Data Quality)

This is the implementation contract for extending the existing Risk29 pipeline into a shared, mobile-first investment data engine. The live `risk29-live-data` branch remains unchanged until a reviewed PR is merged.

## Non-negotiable rules
- No Yahoo Finance. Never forward-fill a missing observation as current.
- Preserve `observed_at`, `period_end`, `published_at`, `ingested_at`, `source`, `frequency`, and `units` separately.
- Missing, stale, invalid, and errored values are NULL/unknown, never numeric zero.
- `brief-th.json` and `latest.json` must have identical `generatedAt`, score and state for a published cycle.
- Fail closed: stale/unavailable Risk29 blocks risk-increasing decisions, but does not imply a specific market risk score.
- Compare only like-for-like periods; do not infer ETF creations/redemptions from price, volume or AUM changes.

## Phase 1 deliverables / acceptance tests
1. Probe production `/risk29/brief-th.json` and `/risk29/latest.json`, then GitHub `risk29-live-data` fallback. Record selected source and HTTP/parse errors.
2. Reject missing/invalid timestamps and snapshots older than 24 hours in Asia/Bangkok.
3. Validate all 29 distinct signal IDs; separately report `fresh`, `delayed`, `stale`, `missing`, `error`, and `unknown` counts, with a coverage denominator of 29.
4. Preserve signal `category`, `asOf`, `ageSeconds`, `reason` when supplied; missing metadata stays unknown.
5. Distinguish available coverage from fresh coverage: `available / 29` does not mean `fresh / 29`.
6. Compare scores/states only against a persisted previous *valid* snapshot with its timestamp and source. Otherwise output `COMPARISON UNAVAILABLE`.
7. If the brief and latest payload disagree, emit `CONSISTENCY WARNING` and withhold a current score.
8. Output a machine-readable health artifact, e.g. `risk29/data-health.json`, with `checkedAt`, `sourceUsed`, `generatedAt`, `payloadAgeSeconds`, `freshnessPass`, `confidence`, `counts`, `availableCoveragePct`, `freshCoveragePct`, `exceptions`, `consistency`, and `comparison`.
9. Do not publish a PASS if the probe fails; include an actionable error reason.
10. Test valid, stale, missing, malformed, mismatched, and degraded cases in CI before deployment.

## Phase 2: semiconductor + cross-asset
- Collect >=220 actual trading sessions of daily close and volume for SMH and SOXX, and daily SOX close; label ETF volume as proxy for SOX.
- Compute EMA20/50/200 with alpha=2/(N+1) and Volume20 from the actual 20 daily volumes; insufficient history => TECHNICAL DATA GAP.
- Store dated US 2Y/10Y, real yield, HY/IG OAS, DXY, USDJPY, EURUSD, gold, oil and VIX with publication lags.

## Phase 3: primary-market ETF flow
- Separate verified issuer/provider creations/redemptions from secondary volume, AUM changes and price returns.
- Track SMH/SOXX/SOXL/SOXS; GLD/IAU/GLDM/SGOL; USO/BNO/DBO/USL; SGOV/SHY/IEF/TLT/LQD/HYG/JNK/TIP.
- Report verified 1D, rolling 5D, rolling 20D, %AUM, as-of, publication date and overlapping windows; missing provider entitlements => DATA GAP.
- Keep leveraged/inverse flows separate; never infer institutional intent.

## Phase 4: decision layer
- Integrate fundamentals, positioning, catalysts, vehicle quality and portfolio-fit permissions.
- Veto risk-increasing actions on failed data health, verified credit alert, technical breakdown or thesis-invalidating event risk.
- Never treat an illustrative HNW portfolio as the user's actual holdings.

## Deployment gate
Merge only after CI tests, production endpoint parity, and a full 29-signal health snapshot are reviewed. This document does not itself implement the ingestion jobs or deploy any service.
