# Risk29 Technical POC

Status: design baseline for branch `risk29-poc`

## Goal

Add a Risk29 intelligence layer to zframes without moving scoring/business logic into presentation code and without coupling the fork to upstream provider internals.

The POC must prove five things:

1. A Risk29 engine can publish a stable, versioned snapshot/history contract.
2. zframes can consume that contract through a dedicated provider plugin.
3. Risk29 cards can render overall score, category scores, signal heatmap, history, and latest changes.
4. Every displayed signal carries source + as-of + freshness state; stale data must never look live.
5. The design remains upstream-friendly: existing keyless providers stay untouched and Risk29 is an additive plugin.

## Non-goals for POC

- Do not implement all 29 signals in the first pass.
- Do not move Risk29 scoring rules into React frames.
- Do not modify existing FRED/Treasury/OFR/Metals providers to emit Risk29-specific scores.
- Do not add LINE delivery in the first PR.
- Do not build Thai mutual-fund NAV ingestion in this POC.
- Do not add a new top-level frame category unless later proven necessary; use the existing `markets` category for the POC frames.

## Architecture

```text
public market data
FRED / Treasury / OFR / Metals / other sources
        |
        v
Risk29 calculation service
- fetch inputs
- normalize
- threshold / percentile transforms
- per-signal score 0..100
- category aggregation
- overall score
- state + regime
- freshness checks
- delta vs previous run
        |
        +--> /risk29/latest.json
        +--> /risk29/history.json
        |
        v
@zframes/provider-risk29
        |
        +--> risk29-snapshot
        +--> risk29-history
        |
        v
zframes frames
- risk29-score
- risk29-categories
- risk29-heatmap
- risk29-history
- risk29-changes
```

The Risk29 calculation service is the source of truth. zframes is the data-adapter + visualization layer.

## POC signal set (10)

These signals are selected because the current zframes fleet already exposes the raw data families needed for them.

| # | Signal | Risk29 category | Raw source/capability | Initial POC purpose |
|---|---|---|---|---|
| 1 | VIX | Sentiment | FRED `VIXCLS` / `index-level` | volatility regime |
| 2 | S&P 500 trend | Technical | FRED `SP500` / `index-level` | broad risk trend |
| 3 | Nasdaq trend | Technical | FRED `NASDAQCOM` / `index-level` | growth/tech breadth proxy for POC |
| 4 | 2Y-10Y curve | Macro | Treasury / `yield-curve` | cycle inversion/steepening |
| 5 | US HY OAS | Credit | FRED `BAMLH0A0HYM2` / `credit-spread` | high-yield stress |
| 6 | US IG OAS | Credit | FRED `BAMLC0A0CM` / `credit-spread` | investment-grade stress |
| 7 | 10Y TIPS real yield | Macro | FRED `DFII10` / `macro-reference-series` | real-rate pressure |
| 8 | Broad dollar index | Global | FRED `DTWEXBGS` / `macro-reference-series` | dollar/liquidity pressure |
| 9 | OFR Financial Stress Index | Liquidity | OFR / `financial-stress` | systemic stress |
| 10 | Gold trend | Global | Metals / `metal-history` or `metal-spot` | defensive demand / cross-asset confirmation |

### Important scoring rule for the POC

The POC must NOT hard-code final production thresholds in the frames. Thresholds live in the Risk29 calculation service configuration and are explicitly versioned.

Each signal returns a normalized `riskScore` in `[0, 100]` plus a state:

- `normal`
- `watch`
- `warning`
- `alert`
- `unavailable`

Thresholds in the first implementation are provisional and must be backtested before being treated as production rules.

## Existing category weights

The engine keeps the current Risk29 weights:

| Category | Weight |
|---|---:|
| Macro | 18 |
| Credit | 14 |
| Valuation | 12 |
| Sentiment | 16 |
| Qualitative | 6 |
| Liquidity | 14 |
| Global | 10 |
| Technical | 10 |

The POC has only a subset of the final 29 signals, so the overall score must re-normalize across categories that have at least one available POC signal.

Example:

```text
activeWeight = sum(weight of categories with >=1 available signal)
overall = sum(categoryScore * categoryWeight) / activeWeight
```

A missing category is `unavailable`, not zero-risk.

## Risk29 data contract

### `Risk29Signal`

```ts
interface Risk29Signal {
  id: string;
  label: string;
  category:
    | "macro"
    | "credit"
    | "valuation"
    | "sentiment"
    | "qualitative"
    | "liquidity"
    | "global"
    | "technical";

  source: string;
  sourceSeries?: string;
  sourceUrl?: string;

  value: number | null;
  unit: string;
  riskScore: number | null;
  state: "normal" | "watch" | "warning" | "alert" | "unavailable";

  direction?: "improving" | "worsening" | "flat";
  change?: number | null;
  changeWindow?: string;

  asOf: string | null;
  fetchedAt: string;
  ageSeconds: number | null;
  freshness: "fresh" | "delayed" | "stale" | "error";

  reason?: string;
  thresholdVersion: string;
}
```

### `Risk29Category`

```ts
interface Risk29Category {
  id: Risk29Signal["category"];
  label: string;
  weight: number;
  score: number | null;
  state: Risk29Signal["state"];
  availableSignals: number;
  totalSignals: number;
}
```

### `Risk29Change`

```ts
interface Risk29Change {
  signalId: string;
  label: string;
  fromState: Risk29Signal["state"];
  toState: Risk29Signal["state"];
  scoreDelta: number | null;
  summary: string;
}
```

### `Risk29Snapshot`

```ts
interface Risk29Snapshot {
  schemaVersion: "1";
  modelVersion: string;
  thresholdVersion: string;
  generatedAt: string;

  score: number | null;
  state: "normal" | "watch" | "warning" | "alert" | "unavailable";
  regime: string;

  categories: Risk29Category[];
  signals: Risk29Signal[];
  changes: Risk29Change[];

  health: {
    available: number;
    stale: number;
    errored: number;
    total: number;
  };
}
```

### `Risk29HistoryPoint`

```ts
interface Risk29HistoryPoint {
  time: number;
  score: number | null;
  state: Risk29Snapshot["state"];
  categoryScores: Partial<Record<Risk29Signal["category"], number>>;
}
```

### `Risk29History`

```ts
interface Risk29History {
  schemaVersion: "1";
  generatedAt: string;
  points: Risk29HistoryPoint[];
}
```

## Freshness policy

Freshness belongs to the engine output and must be shown in the UI.

The POC uses per-signal expected cadence rather than one global timeout.

```text
fresh    = within expected publication/update window
delayed  = late but still potentially usable
stale    = old enough that the signal must not be treated as current
error    = the latest fetch/parse failed and no valid current observation exists
```

The UI must never silently substitute an older value and label it current.

Every Risk29 frame that exposes signal-level data must surface at least `source`, `asOf`, and freshness.

## zframes capabilities to add

Add only two capabilities for the POC:

```ts
| "risk29-snapshot"
| "risk29-history"
```

Do not create one capability per Risk29 card. The snapshot is one coherent intelligence product; frames select views from it.

## Provider design

Create a dedicated additive plugin package:

```text
packages/provider-risk29/
  package.json
  tsconfig.json
  src/
    index.ts
    index.test.ts
    manifest.ts
    plugin.ts
```

Provider responsibilities:

- Advertise `risk29-snapshot` and `risk29-history`.
- Fetch only versioned Risk29 output; do not recalculate scores.
- Validate payloads with Zod before returning them.
- Use `TtlCache` from `@zframes/data-primitives`.
- Fail loudly on schema mismatch; never coerce malformed signal data into zeroes.
- Use a configurable/same-origin base path for the POC (`/risk29/latest.json`, `/risk29/history.json`).
- Keep the package React-free.

Suggested TTL:

```text
snapshot: 60 seconds
history: 5 minutes
```

These are transport TTLs only. Actual market-data freshness is carried inside each signal.

## Plugin integration

Risk29 is not part of the public keyless fleet. It is our private intelligence layer and should remain a separate installable plugin.

Update:

```text
packages/plugins/src/registry.ts
packages/plugins/src/load.ts
packages/plugins/package.json
apps/runtime/vite.config.ts   # dev composition only
```

The plugin id should be:

```text
risk29
```

In development, mount Risk29 AFTER the public live providers. It owns unique Risk29 capabilities, so routing precedence should not conflict with keyless data.

## Core hooks

Add capability hooks in:

```text
packages/core/src/hooks.tsx
```

Proposed public hooks:

```ts
useRisk29Snapshot()
useRisk29History()
```

Frames must use these hooks instead of fetching `/risk29/*` directly.

## Frames

Create five POC frames under the existing `markets` category.

### 1. `risk29-score`

Purpose: hero card.

Shows:

- overall score 0-100
- state
- regime
- change vs prior run when available
- health summary, e.g. `9/10 fresh`
- generated timestamp

Preferred layout: `4 x 3`.

### 2. `risk29-categories`

Purpose: eight-category overview.

Shows one tile per category with:

- score
- state
- weight
- available / total signals

Categories with no POC signal render as unavailable, not 0.

Preferred layout: `6 x 4`.

### 3. `risk29-heatmap`

Purpose: compact signal monitor.

Rows show:

- signal label
- category
- latest value
- risk score
- state
- direction
- freshness marker

The POC renders 10 rows; production can expand to 29.

Preferred layout: `8 x 6`.

### 4. `risk29-history`

Purpose: regime/score trend.

Shows:

- overall score history, default 30 days
- optional category overlays
- state bands/markers

Use the shared time-series primitive; no bespoke chart implementation.

Preferred layout: `8 x 4`.

### 5. `risk29-changes`

Purpose: answer "what changed since the previous run?"

Shows only material changes sorted by absolute score delta / state transition.

Examples:

```text
HY OAS: WATCH -> WARNING
VIX: score +12, worsening
2s10s: improving
```

Preferred layout: `4 x 4`.

## Frame files

Expected additions/edits:

```text
packages/frames/src/schemas/markets.ts
packages/frames/src/risk29-score.tsx
packages/frames/src/risk29-categories.tsx
packages/frames/src/risk29-heatmap.tsx
packages/frames/src/risk29-history.tsx
packages/frames/src/risk29-changes.tsx
packages/frames/src/index.ts
packages/frames/src/lazy.ts
```

All new schema fields must have `.describe()` because the AI catalogue reads them.

## Spec/core files

Expected edits:

```text
packages/spec/src/types.ts
packages/spec/src/index.ts       # only if new types are not already exported through the current barrel pattern
packages/core/src/hooks.tsx
```

Do not add Risk29 scoring math to `@zframes/spec`, `@zframes/core`, or `@zframes/frames`.

## Risk29 calculation service

The calculation service can remain separate from zframes and later be implemented in the existing Python/FastAPI investment stack.

Suggested service output:

```text
GET /risk29/latest.json
GET /risk29/history.json?days=30
```

The service owns:

```text
raw data -> normalized feature -> score -> category -> overall -> state -> regime
```

A signal definition should be config/data, not JSX.

Suggested internal config shape:

```yaml
id: hy_oas
category: credit
weight: 1.0
source: fred
series: BAMLH0A0HYM2
frequency: daily
transform: threshold_or_percentile
threshold_version: risk29-poc-v1
```

## POC dashboard layout

Desktop 12-column concept:

```text
+----------------+------------------------+
| Risk29 Score   | Category Scores        |
| 4 x 3          | 8 x 3                  |
+----------------+------------------------+
| Signal Heatmap                          |
| 12 x 5                                  |
+----------------------------+------------+
| 30D Risk History           | Changes    |
| 8 x 4                      | 4 x 4      |
+----------------------------+------------+
```

Mobile order:

```text
Risk29 Score
Category Scores
Changes
Signal Heatmap
Risk29 History
```

The primary mobile answer must be visible before scrolling deeply: current score, state, regime, and what changed.

## State presentation

Do not infer meaning from color alone. Every colored state must also print text/iconography.

Suggested labels:

```text
NORMAL
WATCH
WARNING
ALERT
NO DATA
```

Colors should use the existing zframes semantic design tokens/primitives rather than hard-coded hex values.

## Regime

For the POC, `regime` is supplied by the Risk29 engine as text and displayed by zframes.

Do not derive regime in the frame.

First implementation can return a controlled vocabulary such as:

```text
risk-on
neutral
late-cycle
risk-off-transition
risk-off
```

Production regime taxonomy will be validated separately.

## Reliability rules

The POC is rejected if any of these occur:

- Missing signal becomes zero.
- Failed provider fetch silently shows the last value as live.
- A frame calculates its own Risk29 threshold/state differently from the engine.
- The demo provider silently backfills Risk29 capabilities when real Risk29 is expected.
- A schema version mismatch renders plausible-looking numbers.
- Any Risk29 frame hard-codes source-specific field parsing.

## Test plan

### Provider unit tests

Cover:

- valid snapshot
- valid history
- missing signal value
- stale signal
- upstream HTTP failure
- malformed schema
- one errored signal while the rest remain usable
- cache reuse

### Frame tests

Cover:

- normal / watch / warning / alert
- unavailable category
- stale/error marker
- long signal labels
- mobile/narrow sizes
- 10-signal POC and 29-signal production density

### Repo gates

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm --filter @zframes/storybook build
```

Then run the frame size probe/sheet for each new Risk29 frame before finalizing layout bounds.

## Acceptance criteria for Phase 0

Phase 0 is successful when:

1. `risk29-poc` builds without changing existing provider behavior.
2. `risk29` appears as its own plugin, separate from `keyless`.
3. A valid 10-signal snapshot renders all five Risk29 frames.
4. Overall score/category scores are identical to the calculation-service payload; the UI does no independent scoring.
5. At least one deliberately stale fixture visibly renders as stale.
6. At least one deliberately unavailable signal stays unavailable and does not lower the score as if it were zero-risk.
7. Mobile layout makes score/state/regime/changes readable first.
8. Existing non-Risk29 tests remain green.

## Implementation order

1. Add Risk29 types + two capabilities in `@zframes/spec`.
2. Add `@zframes/provider-risk29` with snapshot/history fixtures and tests.
3. Register/mount the plugin in dev.
4. Add `useRisk29Snapshot` and `useRisk29History` hooks.
5. Build `risk29-score` first and validate end-to-end.
6. Build categories, heatmap, changes, then history.
7. Create the POC `dashboard.json`.
8. Run full repo gates + frame size probes.
9. Only after the UI contract is stable, connect the Python/FastAPI Risk29 engine to real data.

## Decision locked for this POC

**zframes does visualization and provider routing. Risk29 remains the intelligence engine.**

This separation is intentional: it lets the existing FRED/Treasury/OFR/Metals adapters evolve independently while our scoring methodology, thresholds, history and alert policy remain owned by the investment stack.
