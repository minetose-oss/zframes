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

export const Risk29SignalSchema = z.object({
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
});
export type Risk29Signal = z.infer<typeof Risk29SignalSchema>;

export const Risk29CategorySchema = z.object({
  id: Risk29CategoryIdSchema,
  label: z.string().min(1),
  weight: z.number().nonnegative(),
  score: ScoreSchema.nullable(),
  state: Risk29StateSchema,
  availableSignals: z.number().int().nonnegative(),
  totalSignals: z.number().int().nonnegative(),
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

export const Risk29SnapshotSchema = z.object({
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

export const Risk29HistorySchema = z.object({
  schemaVersion: z.literal("1"),
  generatedAt: TimestampSchema,
  points: z.array(Risk29HistoryPointSchema),
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
