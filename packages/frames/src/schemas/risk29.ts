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

/**
 * Phase 0C's first visible card. The frame is intentionally a renderer only:
 * score, state, regime, health and freshness all arrive from the Risk29 engine.
 */
export const risk29ScoreMeta = defineFrameMeta({
  name: "risk29-score",
  label: "Global Risk29",
  category: "markets",
  layout: { w: 4, h: 3, minW: 3, minH: 3, maxH: 4 },
  description:
    "Risk29 headline risk monitor: the current 0-100 aggregate risk score, explicit NORMAL/WATCH/WARNING/ALERT state, engine-supplied market regime, change versus the prior run, data-health count and Bangkok update time. The frame never recalculates investment thresholds or substitutes missing inputs with zero-risk values.",
  interpretation: `Risk29 condenses the monitored macro, credit, valuation, sentiment, liquidity, global, qualitative and technical signals into one risk score from 0 to 100. Higher means the engine sees more risk signals active; the printed state (NORMAL, WATCH, WARNING or ALERT) is the engine's own classification, not a rule calculated by this card.

The regime line is also supplied by the Risk29 engine. The change figure compares the current engine score with the most recent earlier history point, so it shows direction without changing the current classification.

The data-health line matters as much as the score: missing or stale inputs are not treated as safe. If the engine cannot produce a valid current snapshot, this frame shows the failure instead of presenting an older snapshot as live.`,
  // The upstream Capability union is still closed in the POC. Phase 0D will
  // promote these two strings after the end-to-end card contract is proven.
  capabilities: [
    "risk29-snapshot",
    "risk29-history",
  ] as unknown as readonly Capability[],
  source: RISK29_SOURCE,
  schema: z.object({
    refreshMs: z
      .number()
      .int()
      .min(15_000)
      .max(60 * 60_000)
      .default(60_000)
      .describe(
        "How often to ask the Risk29 snapshot service for an updated intelligence result, in milliseconds. Provider caching and the engine's per-signal freshness policy still apply.",
      ),
  }),
});
