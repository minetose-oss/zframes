import { defineFrameMeta } from "@zframes/spec/frame";
import type { Capability } from "@zframes/spec/types";
import { z } from "zod";

/**
 * Risk29 is a private intelligence layer, not part of the public keyless source
 * catalogue. Keep its credit local to the Risk29 frames until the POC contract
 * is promoted into the canonical plugin-derived catalogue.
 */
const RISK29_SOURCE = {
  id: "risk29",
  name: "Risk29 Intelligence Engine",
  url: "https://github.com/minetose-oss/zframes",
};

const snapshotCapability = ["risk29-snapshot"] as unknown as readonly Capability[];
const historyCapability = ["risk29-history"] as unknown as readonly Capability[];
const snapshotAndHistoryCapabilities = [
  "risk29-snapshot",
  "risk29-history",
] as unknown as readonly Capability[];

const refreshMsField = z
  .number()
  .int()
  .min(15_000)
  .max(60 * 60_000)
  .default(60_000)
  .describe(
    "How often to ask the Risk29 service for an updated intelligence result, in milliseconds. Provider caching and the engine's per-signal freshness policy still apply.",
  );

export const risk29ScoreMeta = defineFrameMeta({
  name: "risk29-score",
  label: "Global Risk29",
  category: "markets",
  layout: { w: 4, h: 3, minW: 3, minH: 3, maxH: 4 },
  description:
    "Risk29 headline risk monitor: the current 0-100 aggregate risk score, explicit NORMAL/WATCH/WARNING/ALERT state, engine-supplied market regime, change versus the prior run, data-health count and Bangkok update time. The frame never recalculates investment thresholds or substitutes missing inputs with zero-risk values.",
  interpretation: `Risk29 condenses the monitored macro, credit, valuation, sentiment, liquidity, global, qualitative and technical signals into one risk score from 0 to 100. Higher means the engine sees more risk signals active; the printed state is the engine's own classification, not a rule calculated by this card.

The regime line is also supplied by the Risk29 engine. The change figure compares the current engine score with the most recent earlier history point, so it shows direction without changing the current classification.

The data-health line matters as much as the score: missing or stale inputs are not treated as safe. If the engine cannot produce a valid current snapshot, this frame shows the failure instead of presenting an older snapshot as live.`,
  capabilities: snapshotAndHistoryCapabilities,
  source: RISK29_SOURCE,
  schema: z.object({ refreshMs: refreshMsField }),
});

export const risk29CategoriesMeta = defineFrameMeta({
  name: "risk29-categories",
  label: "Risk29 Categories",
  category: "markets",
  layout: { w: 8, h: 3, minW: 4, minH: 3, maxH: 5 },
  description:
    "Eight Risk29 category tiles showing the engine-supplied score, state, portfolio weight and signal availability for macro, credit, valuation, sentiment, qualitative, liquidity, global and technical risk. A category with no usable signal is shown as NO DATA, never zero.",
  interpretation: `Each tile is one Risk29 category. The score and state are calculated upstream by the Risk29 intelligence engine; this card only presents them.

Weight is the category's configured contribution to the overall Risk29 model. Available/total shows whether the category score rests on its expected signal set. A category with no valid data remains unavailable instead of being interpreted as low risk.`,
  capabilities: snapshotCapability,
  source: RISK29_SOURCE,
  schema: z.object({ refreshMs: refreshMsField }),
});

export const risk29ChangesMeta = defineFrameMeta({
  name: "risk29-changes",
  label: "What Changed",
  category: "markets",
  layout: { w: 4, h: 4, minW: 3, minH: 3, maxH: 6 },
  description:
    "Material Risk29 signal changes supplied by the engine, ranked by absolute score delta and state transition so the dashboard answers what changed since the previous run without inventing its own thresholds.",
  interpretation: `This card is the shortest path from a Risk29 alert to its cause. Each row is a material signal change already identified by the Risk29 engine.

A state transition is printed explicitly (for example WATCH → WARNING), while score delta shows the magnitude of the move. The summary is engine-supplied context; zframes does not decide whether a move is material.`,
  capabilities: snapshotCapability,
  source: RISK29_SOURCE,
  schema: z.object({
    refreshMs: refreshMsField,
    maxItems: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(6)
      .describe("Maximum number of material Risk29 changes to show."),
  }),
});

export const risk29HeatmapMeta = defineFrameMeta({
  name: "risk29-heatmap",
  label: "Risk29 Signals",
  category: "markets",
  layout: { w: 12, h: 5, minW: 5, minH: 4, maxH: 9 },
  description:
    "Compact Risk29 signal monitor showing each engine signal's category, latest published value, 0-100 risk score, explicit state, direction and freshness. Designed for the 10-signal POC and scalable to the full 29-signal production set.",
  interpretation: `Every row is one Risk29 signal. Value is the latest normalized observation carried by the engine, while Risk is the engine's 0-100 signal score. State and direction are also upstream decisions, not thresholds calculated by this table.

Freshness is explicit. STALE or ERROR means the row needs attention even if the last numeric value looks calm. A missing value is shown as a dash and never converted to zero risk.`,
  capabilities: snapshotCapability,
  source: RISK29_SOURCE,
  schema: z.object({
    refreshMs: refreshMsField,
    maxSignals: z
      .number()
      .int()
      .min(1)
      .max(29)
      .default(29)
      .describe("Maximum number of Risk29 signal rows to render."),
  }),
});

export const risk29HistoryMeta = defineFrameMeta({
  name: "risk29-history",
  label: "Risk29 History",
  category: "markets",
  annotatable: true,
  layout: { w: 8, h: 4, minW: 4, minH: 3, maxH: 7 },
  description:
    "Risk29 aggregate score history, defaulting to a 30-day view, rendered with the shared zframes time-series chart. Optional category overlays use only scores carried in the history payload; no scoring math lives in the frame.",
  interpretation: `The main line is the historical aggregate Risk29 score. Rising means more monitored risk was active according to the engine at that time; falling means the aggregate risk score eased.

Optional category lines help identify which family drove the move. Missing category history simply omits that category point rather than drawing a false zero.`,
  capabilities: historyCapability,
  source: RISK29_SOURCE,
  schema: z.object({
    refreshMs: refreshMsField,
    days: z
      .number()
      .int()
      .min(7)
      .max(365)
      .default(30)
      .describe("Trailing number of calendar days of Risk29 history to plot."),
    showCategories: z
      .boolean()
      .default(false)
      .describe("Overlay category score histories when present in the payload."),
  }),
});
