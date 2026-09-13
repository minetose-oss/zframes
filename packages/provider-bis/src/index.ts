import type {
  Capability,
  MarketDataProvider,
  OfficialSeries,
  PolicyRate,
  SeriesPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { parseCsvRows } from "@zframes/data-primitives/csv";
import { fetchText } from "@zframes/data-primitives/fetch";

/**
 * Keyless provider for the Bank for International Settlements' SDMX v2 REST
 * service — the one publisher in the fleet that carries every major central
 * bank's policy rate on a single comparable basis, plus the BIS statistical
 * series a Thai (or any non-US) board is read against.
 *
 * Two capabilities off one host:
 *
 *  - `policy-rates` — the current policy rate per country, with the previous
 *    distinct rate and when it last moved. Several countries come back from ONE
 *    request (`M.TH+US+XM+JP`), so a twelve-country board costs one fetch.
 *  - `macro-reference-series` — effective exchange rates, residential property
 *    prices, USD exchange rates, and any single country's policy-rate history,
 *    addressed by the `BIS:…` id grammar in {@link resolveSeries}.
 *
 * **Keyless and CORS-open**, so no proxy: `stats.bis.org` echoes the requesting
 * Origin, which is why these frames keep working on a static host where the
 * proxied US sources degrade to empty.
 *
 * The responses are CSV with a header row, parsed BY COLUMN NAME. The dataflows
 * do NOT share a column order — `WS_CBPOL` carries `SOURCE_REF`/`TITLE` in the
 * middle, `WS_EER` a `TITLE_TS` and no source, `WS_XRU` a different tail — so a
 * positional read is right for at most one of them.
 */

const BIS_BASE = "https://stats.bis.org/api/v2/data/dataflow/BIS/";

const SOURCE = "BIS";

/**
 * Default policy-rate basket, Thailand first. Every code is live-verified
 * against `WS_CBPOL`; Singapore and Vietnam are deliberately absent because BIS
 * publishes no policy rate for either (the request 404s with "No results"), and
 * Singapore genuinely has none — the MAS steers the exchange rate, not a rate.
 */
export const DEFAULT_POLICY_COUNTRIES = [
  "TH",
  "US",
  "XM",
  "JP",
  "GB",
  "CN",
  "IN",
  "KR",
  "ID",
  "MY",
  "PH",
  "AU",
] as const;

/** Fallback bank names for the reference areas whose rows carry no `SOURCE_REF`. */
const BANK_NAMES: Record<string, string> = {
  XM: "European Central Bank",
};

const CACHE_TTL_MS = 6 * 60 * 60_000;

const policyCache = new TtlCache<Record<string, PolicyRate>>({
  namespace: "zframes:bis:policy-rates",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

const seriesCache = new TtlCache<OfficialSeries>({
  namespace: "zframes:bis:series",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

type Row = Record<string, string>;

function seriesUrl(key: string, lastN: number): string {
  return `${BIS_BASE}${key}?format=csv&lastNObservations=${lastN}`;
}

/** Parse the CSV into header-keyed rows; a body with no data rows throws. */
function toRows(csv: string, label: string): Row[] {
  const parsed = parseCsvRows(csv);
  const header = (parsed[0] ?? []).map((cell) => cell.trim());
  if (!header.includes("TIME_PERIOD") || !header.includes("OBS_VALUE"))
    throw new Error(`bis: ${label} returned an unexpected CSV header`);
  const rows: Row[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const cells = parsed[i];
    const row: Row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? "";
    rows.push(row);
  }
  if (rows.length === 0) throw new Error(`bis: ${label} returned no rows`);
  return rows;
}

function finiteNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Epoch ms of an SDMX period. Daily periods are the observation day; a QUARTER
 * resolves to its last day, so a quarterly point plots where the quarter ended
 * rather than three months before the data it describes.
 */
export function periodTime(period: string): number | null {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  // Day 0 of the month AFTER the quarter's last month is that month's last day.
  if (quarter) return Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 0);
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return null;
}

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Percent change for a level, a change in percentage POINTS for a rate. */
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

// ── policy rates ─────────────────────────────────────────────────────────────

interface Observation {
  period: string;
  value: number;
}

/**
 * One country's current standing from its window of monthly observations:
 * the latest rate, the most recent DIFFERENT rate before it, and the first
 * period of the current rate's unbroken run.
 */
function toPolicyRate(country: string, rows: Row[]): PolicyRate | null {
  const observations: Observation[] = [];
  let bank = "";
  for (const row of rows) {
    const period = (row.TIME_PERIOD ?? "").trim();
    const value = finiteNumber(row.OBS_VALUE);
    if (period === "" || value === null) continue;
    observations.push({ period, value });
    if (bank === "") bank = (row.SOURCE_REF ?? "").trim();
  }
  if (observations.length === 0) return null;
  observations.sort((a, b) => a.period.localeCompare(b.period));

  const latest = observations[observations.length - 1];
  let prev: number | undefined;
  let changedOn = latest.period;
  for (let i = observations.length - 2; i >= 0; i--) {
    if (observations[i].value !== latest.value) {
      prev = observations[i].value;
      break;
    }
    changedOn = observations[i].period;
  }

  return {
    country,
    bank: bank || BANK_NAMES[country] || country,
    rate: latest.value,
    date: `${latest.period}-01`,
    ...(prev === undefined ? {} : { prev }),
    changedOn: `${changedOn}-01`,
    source: SOURCE,
  };
}

/** How many monthly observations back the previous rate is looked for. */
const POLICY_WINDOW_MONTHS = 36;

async function loadPolicyRates(
  codes: readonly string[],
): Promise<Record<string, PolicyRate>> {
  const csv = await fetchText(
    seriesUrl(`WS_CBPOL/1.0/M.${codes.join("+")}`, POLICY_WINDOW_MONTHS),
    { timeoutMs: 20_000 },
  );
  const byCountry = new Map<string, Row[]>();
  for (const row of toRows(csv, "policy rates")) {
    const area = (row.REF_AREA ?? "").trim().toUpperCase();
    if (area === "") continue;
    const bucket = byCountry.get(area);
    if (bucket) bucket.push(row);
    else byCountry.set(area, [row]);
  }
  const out: Record<string, PolicyRate> = {};
  for (const [country, rows] of byCountry) {
    const rate = toPolicyRate(country, rows);
    if (rate) out[country] = rate;
  }
  return out;
}

// ── statistical series ───────────────────────────────────────────────────────

interface BisSeriesDef {
  /** Dataflow + series key, e.g. `WS_EER/1.0/D.N.B.TH`. */
  key: string;
  unit: OfficialSeries["unit"];
  frequency: OfficialSeries["frequency"];
  lastN: number;
  /** A fixed label, or one derived from the response's own metadata. */
  label: string | ((rows: Row[]) => string);
}

const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * The `BIS:…` id grammar. Each key below is live-verified; the FREQ letter is
 * part of the series key, not a request option, so it differs per family and
 * even per variant — the REAL effective exchange rate exists only monthly
 * (`D.R.B.TH` answers "No results"), while the nominal one is daily.
 */
export function resolveSeries(seriesId: string): BisSeriesDef {
  const parts = seriesId.trim().toUpperCase().split(":");
  const [prefix, family, a, b] = parts;
  if (prefix === "BIS") {
    if (family === "CBPOL" && parts.length === 3 && COUNTRY.test(a))
      return {
        key: `WS_CBPOL/1.0/M.${a}`,
        unit: "percent",
        frequency: "monthly",
        lastN: 240,
        label: (rows) =>
          `${(rows[0]?.SOURCE_REF ?? "").trim() || BANK_NAMES[a] || a} policy rate`,
      };
    if (
      family === "EER" &&
      parts.length === 4 &&
      (a === "N" || a === "R") &&
      COUNTRY.test(b)
    ) {
      const nominal = a === "N";
      return {
        key: nominal ? `WS_EER/1.0/D.N.B.${b}` : `WS_EER/1.0/M.R.B.${b}`,
        unit: "index",
        frequency: nominal ? "daily" : "monthly",
        lastN: nominal ? 1500 : 240,
        label: `${b} ${nominal ? "nominal" : "real"} effective exchange rate (broad)`,
      };
    }
    if (
      family === "SPP" &&
      parts.length === 4 &&
      (a === "N" || a === "R") &&
      COUNTRY.test(b)
    )
      return {
        key: `WS_SPP/1.0/Q.${b}.${a}.628`,
        unit: "index",
        frequency: "quarterly",
        lastN: 120,
        label: `${b} residential property prices (${a === "N" ? "nominal" : "real"})`,
      };
    if (
      family === "XRU" &&
      parts.length === 4 &&
      COUNTRY.test(a) &&
      CURRENCY.test(b)
    )
      return {
        key: `WS_XRU/1.0/D.${a}.${b}.A`,
        // An FX level is unitless in OfficialSeries' vocabulary: `usd` would
        // make the frame render "$32.91" for 32.91 baht per dollar.
        unit: "index",
        frequency: "daily",
        lastN: 1500,
        label: `USD/${b}`,
      };
  }
  throw new Error(`bis: unknown series id "${seriesId}"`);
}

function toOfficialSeries(
  seriesId: string,
  def: BisSeriesDef,
  rows: Row[],
): OfficialSeries {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const time = periodTime((row.TIME_PERIOD ?? "").trim());
    const value = finiteNumber(row.OBS_VALUE);
    if (time === null || value === null) continue;
    points.push({ time, value });
  }
  points.sort((a, b) => a.time - b.time);
  if (points.length === 0)
    throw new Error(`bis: series ${seriesId} returned no observations`);
  const latest = points[points.length - 1];
  return {
    seriesId,
    label: typeof def.label === "string" ? def.label : def.label(rows),
    unit: def.unit,
    frequency: def.frequency,
    latest: latest.value,
    date: isoDate(latest.time),
    change: latestChange(points, def.unit),
    points,
    source: SOURCE,
  };
}

export class BisProvider implements MarketDataProvider {
  readonly name = "bis";
  readonly capabilities: readonly Capability[] = [
    "policy-rates",
    "macro-reference-series",
  ];

  /**
   * Policy rates for the requested countries, returned in the order asked for
   * (Thailand first by default). The cache is keyed on the SORTED codes and
   * holds a per-country map, so two cards asking for the same basket in
   * different orders share one download.
   */
  async getPolicyRates(countries?: string[]): Promise<PolicyRate[]> {
    const wanted = (
      countries?.length ? countries : DEFAULT_POLICY_COUNTRIES
    ).map((code) => code.trim().toUpperCase());
    const codes = [...new Set(wanted)].filter(Boolean);
    if (codes.length === 0) return [];
    const sorted = [...codes].sort();
    const byCountry = await policyCache.get(sorted.join(","), () =>
      loadPolicyRates(sorted),
    );
    return codes
      .map((code) => byCountry[code])
      .filter((rate): rate is PolicyRate => rate !== undefined);
  }

  async getMacroReferenceSeries(seriesId: string): Promise<OfficialSeries> {
    const def = resolveSeries(seriesId);
    return seriesCache.get(def.key, async () => {
      const csv = await fetchText(seriesUrl(def.key, def.lastN), {
        timeoutMs: 20_000,
      });
      return toOfficialSeries(seriesId, def, toRows(csv, seriesId));
    });
  }
}
