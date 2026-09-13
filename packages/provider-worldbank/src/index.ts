import type {
  Capability,
  MarketDataProvider,
  OfficialSeries,
  SeriesPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchJson } from "@zframes/data-primitives/fetch";
import { z } from "zod";

/**
 * Keyless provider for the World Bank's open data API — the annual,
 * cross-country development indicators (GDP, inflation, population, trade …)
 * that none of the fleet's other official publishers carry outside the US.
 *
 * One provider parameterised by indicator, the provider-fred pattern: the id
 * `WB:<INDICATOR>:<ISO3>` names both halves, so a board can chart any of the
 * ~1,400 published indicators for any country without a code change.
 *
 * Keyless and CORS-open (`access-control-allow-origin: *`), so no proxy — these
 * cards keep working on a static host.
 */

const WORLDBANK_BASE = "https://api.worldbank.org/v2/country";

/** `WB:<INDICATOR>:<ISO3>` — indicator codes carry dots, country codes do not. */
const SERIES_ID = /^WB:([A-Z0-9][A-Z0-9.]*):([A-Z]{3})$/;

/** How many annual observations to request; the indicators start in 1960. */
const MAX_OBSERVATIONS = 60;

/** Annual data revised once or twice a year — a day of reuse costs nothing. */
const CACHE_TTL_MS = 24 * 60 * 60_000;

const seriesCache = new TtlCache<OfficialSeries>({
  namespace: "zframes:worldbank:series",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

/**
 * The published body: `[metadata, rows]`, newest row first. `value` is null for
 * a year the country did not report, and the whole rows element is null when
 * the indicator/country pair has nothing at all.
 */
const IndicatorRowSchema = z.object({
  indicator: z.object({ id: z.string(), value: z.string() }),
  country: z.object({ id: z.string(), value: z.string() }),
  countryiso3code: z.string(),
  date: z.string(),
  value: z.number().nullable(),
});

const IndicatorResponseSchema = z.tuple([
  z.unknown(),
  z.array(IndicatorRowSchema).nullable(),
]);

type IndicatorRow = z.infer<typeof IndicatorRowSchema>;

/**
 * What the values mean, read off the indicator code's own suffix convention:
 * `.ZG` is a growth rate and `.ZS` a share, both already in percent; `.CD` is
 * current US dollars. `.CN` is current LOCAL currency, so it is deliberately
 * NOT `usd` — rendering baht with a dollar sign is worse than rendering it as
 * a bare level.
 */
export function unitOf(indicatorId: string): OfficialSeries["unit"] {
  if (/\.(ZG|ZS)$/.test(indicatorId)) return "percent";
  // Interest-rate indicators (FR.INR.LEND, FR.INR.DPST, FR.INR.RINR) carry no
  // unit suffix at all; they are percent, so a move reads in basis points.
  if (/^FR\.INR\./.test(indicatorId)) return "percent";
  // Balance-of-payments dollar series carry a trailing `.WD` (BX.KLT.DINV.CD.WD),
  // so the dollar marker is not always the last segment.
  if (/\.CD(\.WD)?$/.test(indicatorId)) return "usd";
  return "index";
}

function latestChange(
  points: SeriesPoint[],
  unit: OfficialSeries["unit"],
): number {
  if (points.length < 2) return 0;
  const previous = points[points.length - 2].value;
  const latest = points[points.length - 1].value;
  if (unit === "percent") return latest - previous;
  return previous > 0 ? ((latest - previous) / previous) * 100 : 0;
}

export function toOfficialSeries(
  seriesId: string,
  rows: IndicatorRow[] | null,
): OfficialSeries {
  const points: SeriesPoint[] = [];
  let meta: IndicatorRow | undefined;
  for (const row of rows ?? []) {
    const year = Number(row.date);
    if (row.value === null || !Number.isInteger(year)) continue;
    // An annual figure describes the whole year, so it is stamped at the year's
    // END — plotting it at 1 January would put 2025's GDP before 2025 happened.
    points.push({ time: Date.UTC(year, 11, 31), value: row.value });
    if (meta === undefined) meta = row;
  }
  points.sort((a, b) => a.time - b.time);
  if (points.length === 0 || meta === undefined)
    throw new Error(`worldbank: series ${seriesId} returned no observations`);
  const unit = unitOf(meta.indicator.id);
  const latest = points[points.length - 1];
  return {
    seriesId,
    label: `${meta.indicator.value} · ${meta.country.value}`,
    unit,
    frequency: "annual",
    latest: latest.value,
    date: new Date(latest.time).toISOString().slice(0, 10),
    change: latestChange(points, unit),
    points,
    source: "World Bank",
  };
}

export class WorldBankProvider implements MarketDataProvider {
  readonly name = "worldbank";
  readonly capabilities: readonly Capability[] = ["macro-reference-series"];

  async getMacroReferenceSeries(seriesId: string): Promise<OfficialSeries> {
    const match = SERIES_ID.exec(seriesId.trim().toUpperCase());
    if (!match) throw new Error(`worldbank: unknown series id "${seriesId}"`);
    const [, indicator, country] = match;
    return seriesCache.get(`${indicator}:${country}`, async () => {
      const [, rows] = await fetchJson(
        `${WORLDBANK_BASE}/${country}/indicator/${indicator}?format=json&mrv=${MAX_OBSERVATIONS}&per_page=100`,
        IndicatorResponseSchema,
        { timeoutMs: 20_000 },
      );
      return toOfficialSeries(seriesId, rows);
    });
  }
}
