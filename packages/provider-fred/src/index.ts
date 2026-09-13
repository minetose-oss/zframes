import type {
  Capability,
  MarketDataProvider,
  OfficialSeries,
  SeriesPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { parseCsvRows } from "@zframes/data-primitives/csv";
import { fetchText } from "@zframes/data-primitives/fetch";

/**
 * Keyless provider for FRED — the St. Louis Fed's public data warehouse.
 *
 * FRED's *API* needs a registered key, but the endpoint its own charts download
 * from does not: `fredgraph.csv?id=<SERIES_ID>` answers a plain two-column CSV
 * with no key, no token and no signup. That's the surface this provider reads,
 * which is what keeps it inside the keyless fleet.
 *
 * One provider, parameterised by series id (the same shape as provider-metals'
 * multi-metal design) rather than one package per series. It covers five
 * capabilities that differ in meaning but not in shape:
 *
 *  - `index-level` — S&P 500, VIX, Nasdaq Composite levels
 *  - `credit-spread` — the ICE BofA high-yield and investment-grade OAS pair
 *  - `housing-price` — the Case-Shiller US national home-price index
 *  - `mortgage-rate` — the Freddie Mac 30-year fixed benchmark, which FRED
 *    mirrors (so no separate PMMS provider is needed for the same numbers)
 *  - `macro-reference-series` — the macro backdrop a commodity is read against:
 *    CPI (to deflate a nominal price into a real one), the 10-year TIPS real
 *    yield, the broad dollar index, the 10-year inflation breakeven. A metal has
 *    no earnings, so "is gold expensive" is answered by the real price and this
 *    backdrop rather than by a multiple.
 *
 * **CPI comes from here, not from provider-bls, and that is deliberate.** BLS's
 * keyless tier caps one request at 10 years and keeps the *first* ten, so
 * `startyear=1968&endyear=2026` answers 1968–1977 with a `REQUEST_SUCCEEDED`
 * status — a silent truncation that looks like success. Deflating the LBMA gold
 * fix (daily back to 1968) needs the whole CPI history in one piece, so FRED is
 * the only viable deflator source in the fleet.
 *
 * That is also why the capability is spelled `macro-reference-series` rather than
 * the shorter `macro-series`: the short name is already BLS's, for a differently
 * shaped (period-labelled) series, and BLS sits earlier in the keyless routing
 * order — sharing the name would let it swallow every id below.
 *
 * **CORS:** `fred.stlouisfed.org` sends no `Access-Control-Allow-Origin`, so the
 * browser path goes through the runtime's same-origin proxy (the host is on the
 * serve allowlist) and Node fetches direct. On a static host with no runtime
 * these frames degrade to empty, like every other proxied provider.
 *
 * **Rolling licence windows — not a bug, and only the licensed series.** Several
 * FRED series are redistributed under licence and only publish a trailing
 * window, so the history is much shorter than the underlying index: `SP500`
 * carries ~10 years and the two BAML spread series ~3. A frame asking for 20
 * years of the S&P 500 gets the 10 that exist rather than an error.
 *
 * **The sixth family served through `macro-reference-series` is agricultural.**
 * IMF Primary Commodity Prices — rice, palm oil, rubber, sugar, grains, softs,
 * meat, fish and the three IMF agricultural indices — are mirrored on FRED as
 * monthly series with roughly two months' publication lag, alongside two BLS
 * producer-price series (farm products, fertilizer materials). Their units are
 * mixed: dollars per metric ton, per kilogram or per pound, US cents per pound
 * or per kilogram, or an index. A series quoted in DOLLARS per quantity is
 * `unit: "usd"` with a `unitLabel` of "/t" | "/kg" | "/lb", so it follows the
 * board's display currency like any other money. A series quoted in CENTS stays
 * in the market's own quote as `unit: "index"` with "¢/lb" | "¢/kg", because
 * sugar No. 11, arabica and cotton are quoted in cents per pound on every
 * screen and a two-decimal dollar figure would round 14.81¢ to $0.15. The IMF
 * series are "Copyrighted: Citation Required" on FRED, which is why their
 * `source` reads "IMF via FRED" rather than the bare "FRED".
 *
 * The rest are Fed- or agency-published and unwalled, reaching as far back as
 * the statistic itself: `CPIAUCSL` to 1947, `REAINTRATREARAT10Y` to 1982,
 * `CSUSHPINSA` to 1987, `NASDAQCOM`/`MORTGAGE30US` to 1971. Do not "fix" a short
 * window on one of those by adding a date range — there is nothing to widen.
 */

const FREDGRAPH_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";

/** Static metadata per series — everything the CSV itself doesn't tell us. */
interface SeriesDef {
  /** Display label for a card title / chart legend. */
  label: string;
  /** How to read the values (see {@link OfficialSeries.unit}). */
  unit: OfficialSeries["unit"];
  /** Quantity a price is quoted per (see {@link OfficialSeries.unitLabel}). */
  unitLabel?: string;
  /** Publisher cadence, so a frame can label the latest print honestly. */
  frequency: OfficialSeries["frequency"];
  /** Publisher credit when it is not FRED itself, e.g. "IMF via FRED". */
  source?: string;
}

/**
 * The series this provider serves. Every id here was confirmed live against
 * `fredgraph.csv` (HTTP 200, real CSV body); an id outside this map is refused
 * rather than passed through, so a typo fails with a clear message instead of
 * a 404 buried in the transport layer.
 */
const SERIES: Record<string, SeriesDef> = {
  SP500: { label: "S&P 500", unit: "index", frequency: "daily" },
  VIXCLS: { label: "VIX", unit: "index", frequency: "daily" },
  NASDAQCOM: {
    label: "Nasdaq Composite",
    unit: "index",
    frequency: "daily",
  },
  BAMLH0A0HYM2: {
    label: "US High Yield OAS",
    unit: "percent",
    frequency: "daily",
  },
  BAMLC0A0CM: {
    label: "US Investment Grade OAS",
    unit: "percent",
    frequency: "daily",
  },
  CSUSHPINSA: {
    label: "Case-Shiller US National",
    unit: "index",
    frequency: "monthly",
  },
  MORTGAGE30US: {
    label: "30Y Fixed Mortgage",
    unit: "percent",
    frequency: "weekly",
  },
  CPIAUCSL: {
    label: "CPI (All Urban Consumers, SA)",
    unit: "index",
    frequency: "monthly",
  },
  DFII10: {
    label: "10Y TIPS Real Yield",
    unit: "percent",
    frequency: "daily",
  },
  DTWEXBGS: {
    label: "Broad Dollar Index",
    unit: "index",
    frequency: "daily",
  },
  T10YIE: {
    label: "10Y Inflation Breakeven",
    unit: "percent",
    frequency: "daily",
  },
  REAINTRATREARAT10Y: {
    label: "10Y Real Interest Rate",
    unit: "percent",
    frequency: "monthly",
  },
  PRICENPQUSDM: {
    label: "Rice, Thai 5% broken",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PWHEAMTUSDM: {
    label: "Wheat",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PMAIZMTUSDM: {
    label: "Corn",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSOYBUSDM: {
    label: "Soybeans",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSOILUSDM: {
    label: "Soybean Oil",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSMEAUSDM: {
    label: "Soybean Meal",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PPOILUSDM: {
    label: "Palm Oil",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSUNOUSDM: {
    label: "Sunflower Oil",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PROILUSDM: {
    label: "Rapeseed Oil",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  POLVOILUSDM: {
    label: "Olive Oil",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PCOCOUSDM: {
    label: "Cocoa",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PBARLUSDM: {
    label: "Barley",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PBANSOPUSDM: {
    label: "Bananas",
    unit: "usd",
    unitLabel: "/t",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSHRIUSDM: {
    label: "Shrimp",
    unit: "usd",
    unitLabel: "/kg",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSALMUSDM: {
    label: "Fish (Salmon)",
    unit: "usd",
    unitLabel: "/kg",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PORANGUSDM: {
    label: "Orange",
    unit: "usd",
    unitLabel: "/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PSUGAISAUSDM: {
    label: "Sugar No. 11",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PRUBBUSDM: {
    label: "Rubber RSS3",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PCOFFOTMUSDM: {
    label: "Coffee, Other Mild Arabica",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PCOTTINDUSDM: {
    label: "Cotton",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PBEEFUSDM: {
    label: "Beef",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PPOULTUSDM: {
    label: "Poultry",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PLAMBUSDM: {
    label: "Lamb",
    unit: "index",
    unitLabel: "¢/lb",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PTEAUSDM: {
    label: "Tea, Kenyan",
    unit: "index",
    unitLabel: "¢/kg",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PFOODINDEXM: {
    label: "IMF Food Price Index",
    unit: "index",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PRAWMINDEXM: {
    label: "IMF Agricultural Raw Materials Index",
    unit: "index",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  PFANDBINDEXM: {
    label: "IMF Food & Beverage Price Index",
    unit: "index",
    frequency: "monthly",
    source: "IMF via FRED",
  },
  WPU0652: {
    label: "PPI: Fertilizer Materials",
    unit: "index",
    frequency: "monthly",
  },
  WPU01: {
    label: "PPI: Farm Products",
    unit: "index",
    frequency: "monthly",
  },
};

/** Ids the `index-level` capability accepts — the market-index subset. */
export const FRED_INDEX_SERIES = ["SP500", "VIXCLS", "NASDAQCOM"] as const;

/**
 * Ids the `macro-reference-series` capability accepts — the macro *backdrop*
 * subset, kept separate from {@link FRED_INDEX_SERIES} so the two capabilities
 * cannot answer for each other's meaning. Routing is first-match per capability:
 * without the split, a card asking for "the index" and a card asking for "the
 * macro series" would reach the same door and each could be handed the other's
 * series.
 *
 * **Do not rename this to `macro-series`, and do not fold these ids into
 * `index-level`.** Both look like tidy-ups and both break at runtime:
 *  - `macro-series` is provider-bls's capability, for its period-labelled
 *    `MacroSeries` shape, and BLS is constructed EARLIER than FRED in
 *    `packages/providers-keyless` — first-match would hand every id below to
 *    BLS, which doesn't publish them, so each card would render an error. Nor
 *    can it be fixed by reordering the two: six live frames (`inflation-pulse`,
 *    `labor-force-flow`, `labor-market`, `misery-index`, `payrolls-bars`,
 *    `real-wages`) depend on BLS winning `macro-series`, so putting FRED first
 *    just moves the breakage onto them. There is no order that serves both —
 *    which is the whole reason for the longer name.
 *  - `index-level` is this same provider's market-index door (S&P, VIX,
 *    Nasdaq), so sharing it would compile and then let a request for "the
 *    index" be answered with CPI.
 *
 * `REAINTRATREARAT10Y` is here alongside `DFII10` because it reaches 21 years
 * deeper (1982 vs 2003) — a real-yield-vs-gold overlay has nothing to plot
 * before 2003 on the TIPS series, which only begins when TIPS started trading.
 */
export const FRED_MACRO_REFERENCE_SERIES = [
  "CPIAUCSL",
  "DFII10",
  "DTWEXBGS",
  "T10YIE",
  "REAINTRATREARAT10Y",
] as const;

/**
 * The commodity-price ids the `macro-reference-series` capability also accepts:
 * the IMF Primary Commodity Prices FRED mirrors, plus the two BLS producer-price
 * series that belong beside them. Kept apart from
 * {@link FRED_MACRO_REFERENCE_SERIES} because these are prices, not the macro
 * backdrop a price is read against — they go through the same door, but a
 * reader of either list should see what it is for.
 */
export const FRED_COMMODITY_PRICE_SERIES = [
  "PRICENPQUSDM",
  "PWHEAMTUSDM",
  "PMAIZMTUSDM",
  "PSOYBUSDM",
  "PSOILUSDM",
  "PSMEAUSDM",
  "PPOILUSDM",
  "PSUNOUSDM",
  "PROILUSDM",
  "POLVOILUSDM",
  "PCOCOUSDM",
  "PBARLUSDM",
  "PBANSOPUSDM",
  "PSHRIUSDM",
  "PSALMUSDM",
  "PORANGUSDM",
  "PSUGAISAUSDM",
  "PRUBBUSDM",
  "PCOFFOTMUSDM",
  "PCOTTINDUSDM",
  "PBEEFUSDM",
  "PPOULTUSDM",
  "PLAMBUSDM",
  "PTEAUSDM",
  "PFOODINDEXM",
  "PRAWMINDEXM",
  "PFANDBINDEXM",
  "WPU0652",
  "WPU01",
] as const;

/** The credit-spread pair, high-yield first (the order frames chart them in). */
const CREDIT_SPREAD_SERIES = ["BAMLH0A0HYM2", "BAMLC0A0CM"] as const;

const HOUSING_SERIES = "CSUSHPINSA";
const MORTGAGE_SERIES = "MORTGAGE30US";

const SOURCE = "FRED";

/**
 * Reuse a parsed series for 3h, just under the 6h poll the capability hooks
 * use — background polls still refresh while reloads and sibling frames on the
 * same series reuse one download. Every series here prints daily at best.
 *
 * NOT persisted: the deep series are large as text (Nasdaq's history is ~280 KB,
 * VIX ~160 KB) and several frames may hold different ones, which would crowd
 * localStorage for every other provider's small payloads. Same call the LBMA
 * fix history makes.
 */
const seriesCache = new TtlCache<OfficialSeries[]>({
  namespace: "zframes:fred:series",
  ttlMs: 3 * 60 * 60_000,
  persist: false,
});

/** Coerce a CSV cell to a finite number; empty/"." cells (holidays) yield null. */
function finiteNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  // FRED leaves non-print days blank in the CSV download (and "." in some
  // legacy exports) — both mean "no observation", not zero.
  if (trimmed === "" || trimmed === ".") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a fredgraph CSV into one point list per value column.
 *
 * The header is `observation_date,<ID>[,<ID>…]` — fredgraph accepts several ids
 * in one `id=A,B` call and answers with one column each on a shared date grid,
 * which is how the credit-spread pair is fetched (one request, dates guaranteed
 * to line up rather than two downloads aligned after the fact).
 *
 * Returns the ids in header order alongside their columns, so the caller matches
 * columns by the id FRED echoed back rather than by request position.
 */
export function parseFredCsv(csv: string): {
  ids: string[];
  columns: SeriesPoint[][];
} {
  const rows = parseCsvRows(csv);
  const header = (rows[0] ?? []).map((cell) => cell.trim());
  if (header.length < 2 || !/^observation_date$/i.test(header[0]))
    throw new Error("fred: unexpected CSV header");
  const ids = header.slice(1);
  const columns: SeriesPoint[][] = ids.map(() => []);

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 2) continue;
    // Dates are bare `YYYY-MM-DD`; parse as UTC midnight so the epoch is stable
    // regardless of the viewer's zone (these are daily prints, not intraday).
    const time = Date.parse(`${cells[0].trim()}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    for (let c = 0; c < ids.length; c++) {
      const value = finiteNumber(cells[c + 1]);
      if (value !== null) columns[c].push({ time, value });
    }
  }
  return { ids, columns };
}

/** ISO date (`YYYY-MM-DD`) of an epoch, in UTC — matching how the CSV prints it. */
function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The latest move in the unit a reader expects: a percent change for a level
 * (an index or a dollar amount), but a change in percentage POINTS for a rate
 * or spread — a high-yield OAS going 2.84 → 2.87 is "+3bps", and calling that
 * "+1.06%" would be actively misleading.
 */
function latestChange(points: SeriesPoint[], unit: SeriesDef["unit"]): number {
  if (points.length < 2) return 0;
  const previous = points[points.length - 2].value;
  const latest = points[points.length - 1].value;
  if (unit === "percent") return latest - previous;
  return previous > 0 ? ((latest - previous) / previous) * 100 : 0;
}

/** Assemble the public shape for one parsed column. */
function toOfficialSeries(
  seriesId: string,
  points: SeriesPoint[],
): OfficialSeries {
  const def = SERIES[seriesId];
  if (points.length === 0)
    throw new Error(`fred: series ${seriesId} returned no observations`);
  const latest = points[points.length - 1];
  return {
    seriesId,
    label: def.label,
    unit: def.unit,
    ...(def.unitLabel !== undefined ? { unitLabel: def.unitLabel } : {}),
    frequency: def.frequency,
    latest: latest.value,
    date: isoDate(latest.time),
    change: latestChange(points, def.unit),
    points,
    source: def.source ?? SOURCE,
  };
}

/** Reject an id this provider doesn't publish, before it reaches the network. */
function knownSeries(seriesId: string): string {
  const id = seriesId.trim().toUpperCase();
  if (!SERIES[id])
    throw new Error(
      `fred: unknown series "${seriesId}" (known: ${Object.keys(SERIES).join(", ")})`,
    );
  return id;
}

/**
 * Narrow a known id to the macro-reference subset. A *known but wrong* id —
 * asking for `SP500` through the macro door — is refused with the accepted ids
 * named, because the alternative is a chart quietly plotting an equity index on
 * an inflation axis, which reads as plausible data rather than as a mistake.
 */
function knownMacroReferenceSeries(seriesId: string): string {
  const id = knownSeries(seriesId);
  const accepted = [
    ...FRED_MACRO_REFERENCE_SERIES,
    ...FRED_COMMODITY_PRICE_SERIES,
  ] as readonly string[];
  if (!accepted.includes(id))
    throw new Error(
      `fred: series "${seriesId}" is not a macro reference series (accepted: ${accepted.join(", ")})`,
    );
  return id;
}

export class FredProvider implements MarketDataProvider {
  readonly name = "fred";
  readonly capabilities: readonly Capability[] = [
    "index-level",
    "credit-spread",
    "housing-price",
    "mortgage-rate",
    "macro-reference-series",
  ];

  /**
   * Fetch + parse one or more series in a single request, cached under the
   * joined id list. Column order follows the ids FRED echoes in the header.
   */
  private load(ids: readonly string[]): Promise<OfficialSeries[]> {
    const key = ids.join(",");
    return seriesCache.get(key, async () => {
      const csv = await fetchText(
        `${FREDGRAPH_URL}?id=${encodeURIComponent(key)}`,
        { proxied: true },
      );
      const { ids: returned, columns } = parseFredCsv(csv);
      return returned.map((id, i) =>
        toOfficialSeries(knownSeries(id), columns[i]),
      );
    });
  }

  private async loadOne(seriesId: string): Promise<OfficialSeries> {
    const [series] = await this.load([knownSeries(seriesId)]);
    return series;
  }

  async getIndexSeries(seriesId: string): Promise<OfficialSeries> {
    return this.loadOne(seriesId);
  }

  /**
   * One macro reference series, restricted to
   * {@link FRED_MACRO_REFERENCE_SERIES}.
   *
   * Same `loadOne` path (and so the same cache slot) as every other series here:
   * a board carrying both a real-gold-price card and a CPI card downloads
   * `CPIAUCSL` once, not twice.
   */
  async getMacroReferenceSeries(seriesId: string): Promise<OfficialSeries> {
    return this.loadOne(knownMacroReferenceSeries(seriesId));
  }

  /** Both OAS series in ONE call, so their date grids are identical by construction. */
  async getCreditSpreads(): Promise<OfficialSeries[]> {
    return this.load(CREDIT_SPREAD_SERIES);
  }

  async getHousingPriceIndex(): Promise<OfficialSeries> {
    return this.loadOne(HOUSING_SERIES);
  }

  async getMortgageRates(): Promise<OfficialSeries> {
    return this.loadOne(MORTGAGE_SERIES);
  }
}
