import { z } from "zod";

/**
 * Risk29 is a proprietary intelligence product layered on top of market-data
 * providers. It deliberately lives behind its own subpath while the POC is
 * proving the contract, so the broad `@zframes/spec` barrel does not grow a
 * product-specific surface before the shape is stable.
 */
export const RISK29_CAPABILITIES = [
  "risk29-snapshot",
  "risk29-history",
] as const;

export type Risk29Capability = (typeof RISK29_CAPABILITIES)[number];

export const Risk29CategoryIdSchema = z.enum([
  "macro",
  "credit",
  "valuation",
  "sentiment",
  "qualitative",
  "liquidity",
  "global",
  "technical",
]);
export type Risk29CategoryId = z.infer<typeof Risk29CategoryIdSchema>;

export const RISK29_CATEGORY_IDS = Risk29CategoryIdSchema.options;

export const Risk29StateSchema = z.enum([
  "normal",
  "watch",
  "warning",
  "alert",
  "unavailable",
]);
export type Risk29State = z.infer<typeof Risk29StateSchema>;

export const Risk29DirectionSchema = z.enum([
  "improving",
  "worsening",
  "flat",
]);
export type Risk29Direction = z.infer<typeof Risk29DirectionSchema>;

export const Risk29FreshnessSchema = z.enum([
  "fresh",
  "delayed",
  "stale",
  "error",
]);
export type Risk29Freshness = z.infer<typeof Risk29FreshnessSchema>;

const ScoreSchema = z.number().min(0).max(100);
const TimestampSchema = z.string().datetime({ offset: true });

export const Risk29SignalSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    category: Risk29CategoryIdSchema,

    source: z.string().min(1),
    sourceSeries: z.string().min(1).optional(),
    sourceUrl: z.string().url().optional(),

    value: z.number().finite().nullable(),
    unit: z.string(),
    riskScore: ScoreSchema.nullable(),
    state: Risk29StateSchema,

    direction: Risk29DirectionSchema.optional(),
    change: z.number().finite().nullable().optional(),
    changeWindow: z.string().min(1).optional(),

    // Some publishers stamp a date, others a full timestamp. Keep the publisher
    // stamp opaque here; fetchedAt/generatedAt carry strict machine timestamps.
    asOf: z.string().min(1).nullable(),
    fetchedAt: TimestampSchema,
    ageSeconds: z.number().nonnegative().nullable(),
    freshness: Risk29FreshnessSchema,

    reason: z.string().min(1).optional(),
    thresholdVersion: z.string().min(1),
  })
  .superRefine((signal, ctx) => {
    if (signal.state === "unavailable") {
      if (signal.value !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "unavailable Risk29 signals must have value=null",
        });
      }
      if (signal.riskScore !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["riskScore"],
          message: "unavailable Risk29 signals must have riskScore=null",
        });
      }
    }

    if (signal.freshness === "error" && !signal.reason) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "errored Risk29 signals must explain the data failure",
      });
    }
  });
export type Risk29Signal = z.infer<typeof Risk29SignalSchema>;

export const Risk29CategorySchema = z
  .object({
    id: Risk29CategoryIdSchema,
    label: z.string().min(1),
    weight: z.number().nonnegative(),
    score: ScoreSchema.nullable(),
    state: Risk29StateSchema,
    availableSignals: z.number().int().nonnegative(),
    totalSignals: z.number().int().nonnegative(),
  })
  .superRefine((category, ctx) => {
    if (category.availableSignals > category.totalSignals) {
      ctx.addIssue({
        code: "custom",
        path: ["availableSignals"],
        message: "availableSignals cannot exceed totalSignals",
      });
    }
    if (category.state === "unavailable" && category.score !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "unavailable Risk29 categories must have score=null",
      });
    }
    if (category.availableSignals === 0 && category.state !== "unavailable") {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "categories with zero available signals must be unavailable",
      });
    }
  });
export type Risk29Category = z.infer<typeof Risk29CategorySchema>;

export const Risk29ChangeSchema = z.object({
  signalId: z.string().min(1),
  label: z.string().min(1),
  fromState: Risk29StateSchema,
  toState: Risk29StateSchema,
  scoreDelta: z.number().finite().nullable(),
  summary: z.string().min(1),
});
export type Risk29Change = z.infer<typeof Risk29ChangeSchema>;

export const Risk29HealthSchema = z.object({
  available: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type Risk29Health = z.infer<typeof Risk29HealthSchema>;

export const Risk29SnapshotSchema = z
  .object({
    schemaVersion: z.literal("1"),
    modelVersion: z.string().min(1),
    thresholdVersion: z.string().min(1),
    generatedAt: TimestampSchema,

    score: ScoreSchema.nullable(),
    state: Risk29StateSchema,
    regime: z.string().min(1),

    categories: z.array(Risk29CategorySchema).length(8),
    signals: z.array(Risk29SignalSchema).min(1).max(29),
    changes: z.array(Risk29ChangeSchema),
    health: Risk29HealthSchema,
  })
  .superRefine((snapshot, ctx) => {
    const categoryIds = snapshot.categories.map((category) => category.id);
    const uniqueCategoryIds = new Set(categoryIds);
    if (uniqueCategoryIds.size !== RISK29_CATEGORY_IDS.length) {
      ctx.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Risk29 snapshot must contain each of the eight categories exactly once",
      });
    } else {
      for (const id of RISK29_CATEGORY_IDS) {
        if (!uniqueCategoryIds.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["categories"],
            message: `Risk29 snapshot is missing category ${id}`,
          });
        }
      }
    }

    const signalIds = snapshot.signals.map((signal) => signal.id);
    if (new Set(signalIds).size !== signalIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["signals"],
        message: "Risk29 signal ids must be unique",
      });
    }

    for (const signal of snapshot.signals) {
      if (signal.thresholdVersion !== snapshot.thresholdVersion) {
        ctx.addIssue({
          code: "custom",
          path: ["signals"],
          message: `signal ${signal.id} thresholdVersion does not match snapshot thresholdVersion`,
        });
      }
    }

    const knownSignals = new Set(signalIds);
    for (const change of snapshot.changes) {
      if (!knownSignals.has(change.signalId)) {
        ctx.addIssue({
          code: "custom",
          path: ["changes"],
          message: `change references unknown signal ${change.signalId}`,
        });
      }
    }

    const available = snapshot.signals.filter(
      (signal) =>
        signal.state !== "unavailable" &&
        signal.freshness !== "error" &&
        signal.value !== null &&
        signal.riskScore !== null,
    ).length;
    const stale = snapshot.signals.filter(
      (signal) => signal.freshness === "stale",
    ).length;
    const errored = snapshot.signals.filter(
      (signal) => signal.freshness === "error",
    ).length;

    if (snapshot.health.total !== snapshot.signals.length) {
      ctx.addIssue({
        code: "custom",
        path: ["health", "total"],
        message: "health.total must equal the number of Risk29 signals",
      });
    }
    if (snapshot.health.available !== available) {
      ctx.addIssue({
        code: "custom",
        path: ["health", "available"],
        message: "health.available does not match usable Risk29 signals",
      });
    }
    if (snapshot.health.stale !== stale) {
      ctx.addIssue({
        code: "custom",
        path: ["health", "stale"],
        message: "health.stale does not match stale Risk29 signals",
      });
    }
    if (snapshot.health.errored !== errored) {
      ctx.addIssue({
        code: "custom",
        path: ["health", "errored"],
        message: "health.errored does not match errored Risk29 signals",
      });
    }

    if (snapshot.state === "unavailable" && snapshot.score !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "unavailable Risk29 snapshots must have score=null",
      });
    }
  });
export type Risk29Snapshot = z.infer<typeof Risk29SnapshotSchema>;

const CategoryScoresSchema = z
  .object({
    macro: ScoreSchema.optional(),
    credit: ScoreSchema.optional(),
    valuation: ScoreSchema.optional(),
    sentiment: ScoreSchema.optional(),
    qualitative: ScoreSchema.optional(),
    liquidity: ScoreSchema.optional(),
    global: ScoreSchema.optional(),
    technical: ScoreSchema.optional(),
  })
  .strict();

export const Risk29HistoryPointSchema = z.object({
  time: z.number().int().nonnegative(),
  score: ScoreSchema.nullable(),
  state: Risk29StateSchema,
  categoryScores: CategoryScoresSchema,
});
export type Risk29HistoryPoint = z.infer<typeof Risk29HistoryPointSchema>;

export const Risk29HistorySchema = z
  .object({
    schemaVersion: z.literal("1"),
    generatedAt: TimestampSchema,
    points: z.array(Risk29HistoryPointSchema),
  })
  .superRefine((history, ctx) => {
    for (let i = 1; i < history.points.length; i += 1) {
      if (history.points[i].time <= history.points[i - 1].time) {
        ctx.addIssue({
          code: "custom",
          path: ["points", i, "time"],
          message: "Risk29 history points must be strictly increasing by time",
        });
      }
    }
  });
export type Risk29History = z.infer<typeof Risk29HistorySchema>;

/**
 * Product-specific provider methods are merged into the shared provider
 * interface when this subpath is imported. The POC capability strings are kept
 * out of the global Capability union until the product contract is proven; the
 * Risk29 provider and frames pin them explicitly during the experiment.
 */
declare module "./types" {
  interface MarketDataProvider {
    getRisk29Snapshot?(): Promise<Risk29Snapshot>;
    getRisk29History?(): Promise<Risk29History>;
  }
}
