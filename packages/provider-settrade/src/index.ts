import type {
  Capability,
  CompanyFacts,
  DayStats,
  EquityProfile,
  FinancialMetric,
  IndexQuote,
  InvestorTypeFlow,
  InvestorTypeRow,
  MarketBreadth,
  MarketDataProvider,
  MarketSnapshot,
  MarketValuation,
  OrderBook,
  SeriesPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchJson } from "@zframes/data-primitives/fetch";
import { usdRate } from "@zframes/data-primitives/fx-rate";
import { z } from "zod";

const BASE_URL = "https://api.settrade.com";

const MARKET_INFO_URL = (market: string) =>
  `${BASE_URL}/api/market/${market}/info`;
const MARKET_STATISTICS_URL = (market: string) =>
  `${BASE_URL}/api/market/${market}/statistics`;
const MARKET_INVESTOR_TYPE_URL = (market: string) =>
  `${BASE_URL}/api/market/${market}/investortype`;
const STOCK_INFO_URL = (symbol: string) =>
  `${BASE_URL}/api/stock/${encodeURIComponent(symbol)}/info`;
const STOCK_STATISTICS_URL = (symbol: string) =>
  `${BASE_URL}/api/stock/${encodeURIComponent(symbol)}/statistics`;
const STOCK_FINANCIAL_URL = (symbol: string) =>
  `${BASE_URL}/api/stock/${encodeURIComponent(symbol)}/financial`;
const STOCK_HISTORICAL_URL = (symbol: string) =>
  `${BASE_URL}/api/stock/${encodeURIComponent(symbol)}/historical`;

/** Intraday restamps, so a minute keeps a board fresh without hammering the venue. */
const CACHE_TTL_MS = 60_000;

const REQUEST_TIMEOUT_MS = 10_000;

/** The publisher's own spelling of each venue id, by lower-cased input. */
const MARKETS: Record<string, string> = { set: "SET", mai: "mai" };

/** What the exchange calls itself in full; the API only sends the short badge. */
const VENUE_NAMES: Record<string, string> = {
  SET: "Stock Exchange of Thailand",
  mai: "Market for Alternative Investment",
};

const SOURCE = "Settrade";

const IndexRowSchema = z.object({
  index_name: z.string(),
  index_display_name: z.string().optional(),
  prior: z.number(),
  last: z.number(),
  change: z.number(),
  percent_change: z.number(),
  high: z.number().optional(),
  low: z.number().optional(),
  total_volume: z.number().optional(),
  total_value: z.number().optional(),
});

const MarketInfoSchema = z.object({
  market_name: z.string(),
  market_display_name: z.string().optional(),
  market_status: z.string().optional(),
  datetime: z.string(),
  gainer_amount: z.number(),
  gainer_volume: z.number().optional(),
  unchange_amount: z.number(),
  unchange_volume: z.number().optional(),
  loser_amount: z.number(),
  loser_volume: z.number().optional(),
  index: z.array(IndexRowSchema).min(1),
});

type MarketInfo = z.infer<typeof MarketInfoSchema>;

const MarketStatisticsSchema = z.object({
  asof_date: z.string(),
  market_cap: z.number(),
  turnover_ratio: z.number(),
  pe_ratio: z.number(),
  pbv_ratio: z.number(),
  dividend_yield: z.number(),
});

const InvestorTypeSchema = z.object({
  asof_date: z.string(),
  total_value: z.number(),
  investors: z
    .array(
      z.object({
        type: z.string(),
        type_name_en: z.string().optional(),
        buy_value: z.number(),
        sell_value: z.number(),
        net_value: z.number(),
      }),
    )
    .min(1),
});

/**
 * Every numeric cell on the quote endpoint can be `null` — a foreign-board
 * listing (`PTT-F`) publishes a full row with no `last` outside the session —
 * so nothing here is required beyond the identity the record is keyed by.
 */
const PriceInfoSchema = z.object({
  prior: z.number().nullable().optional(),
  last: z.number().nullable().optional(),
  change: z.number().nullable().optional(),
  percent_change: z.number().nullable().optional(),
  open: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  low: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
  value: z.number().nullable().optional(),
  // The two sides of the book are published as STRINGS ("41.75"), unlike every
  // other price on this endpoint.
  bid_price: z.union([z.string(), z.number()]).nullable().optional(),
  bid_volume: z.number().nullable().optional(),
  offer_price: z.union([z.string(), z.number()]).nullable().optional(),
  offer_volume: z.number().nullable().optional(),
});

const StockInfoSchema = z.object({
  abbr_name: z.string(),
  full_name_en: z.string().nullable().optional(),
  market: z.string().nullable().optional(),
  market_status: z.string().nullable().optional(),
  datetime: z.string().nullable().optional(),
  industry_name_en: z.string().nullable().optional(),
  sector_name_en: z.string().nullable().optional(),
  security_type: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  price_info: PriceInfoSchema,
});

type StockInfo = z.infer<typeof StockInfoSchema>;

const StockStatisticsSchema = z.object({
  asof_date: z.string().nullable().optional(),
  market_cap: z.number().nullable().optional(),
  pe_ratio: z.number().nullable().optional(),
  pbv_ratio: z.number().nullable().optional(),
  dividend_yield: z.number().nullable().optional(),
  turnover_ratio: z.number().nullable().optional(),
  high_52w: z.number().nullable().optional(),
  low_52w: z.number().nullable().optional(),
});

const StockFinancialSchema = z.object({
  asof_date: z.string(),
  data: z
    .array(
      z.object({
        label: z.string(),
        value: z.number().nullable().optional(),
        divider: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const StockHistoricalSchema = z.object({
  abbr_name: z.string().optional(),
  data: z.array(
    z.object({
      date: z.string().optional(),
      date_long: z.number(),
      close: z.number().nullable().optional(),
    }),
  ),
});

/** Bangkok is UTC+7 year-round — Thailand has never observed DST. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;

/**
 * Day-first Bangkok-local dates, in the two widths the publisher mixes:
 * `12/09/2026` on the venue endpoints and `12/09/26` on the per-stock quote and
 * inside the financial highlights' `(30/06/26)`. A two-digit year is read as
 * 20xx — this exchange publishes no pre-2000 quote.
 */
function splitDayFirst(value: string): [number, number, number] | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [day, month, rawYear] = match.slice(1).map(Number);
  return [rawYear < 100 ? 2000 + rawYear : rawYear, month, day];
}

/**
 * `"12/09/2026 03:20:09"` — day-first, Bangkok local. Parsed by hand because
 * `Date.parse` reads an unqualified `12/09/2026` as MONTH-first and in the
 * runtime's own zone, which is wrong twice over and wrong *plausibly*: the
 * result is a real date up to eleven months off.
 */
function parseBangkokTimestamp(value: string): number {
  const match =
    /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(
      value.trim(),
    );
  if (!match) throw new Error(`settrade: unreadable datetime "${value}"`);
  const [rawYear, month, day, hour, minute, second] = [
    Number(match[3]),
    Number(match[2]),
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ];
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) - BANGKOK_OFFSET_MS
  );
}

/** `"11/09/2026"` → `"2026-09-11"`. */
function parseBangkokDate(value: string): string {
  const parts = splitDayFirst(value);
  if (!parts) throw new Error(`settrade: unreadable date "${value}"`);
  const [year, month, day] = parts;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normaliseStatus(label: string | undefined): MarketSnapshot["status"] {
  if (!label) return "unknown";
  if (/pre/i.test(label)) return "pre-open";
  if (/open/i.test(label)) return "open";
  if (/clos/i.test(label)) return "closed";
  return "unknown";
}

function breadthOf(body: MarketInfo): MarketBreadth {
  const breadth: MarketBreadth = {
    gainers: body.gainer_amount,
    losers: body.loser_amount,
    unchanged: body.unchange_amount,
  };
  // Passed through as published: the live feed reports `unchange_volume` equal
  // to `gainer_volume`, which is the venue's number to correct, not ours.
  if (body.gainer_volume !== undefined)
    breadth.gainersVolume = body.gainer_volume;
  if (body.loser_volume !== undefined) breadth.losersVolume = body.loser_volume;
  if (body.unchange_volume !== undefined)
    breadth.unchangedVolume = body.unchange_volume;
  return breadth;
}

function indicesOf(body: MarketInfo, thbPerUsd: number): IndexQuote[] {
  return body.index.map((row) => {
    const quote: IndexQuote = {
      symbol: row.index_name,
      name: row.index_display_name ?? row.index_name,
      last: row.last,
      prior: row.prior,
      change: row.change,
      changePct: row.percent_change,
    };
    if (row.high !== undefined) quote.high = row.high;
    if (row.low !== undefined) quote.low = row.low;
    // Volume is a share count, so it stays as published; value is money and
    // every capability here is denominated in USD.
    if (row.total_volume !== undefined) quote.volume = row.total_volume;
    if (row.total_value !== undefined)
      quote.valueUsd = row.total_value / thbPerUsd;
    return quote;
  });
}

/** A published cell, or null where the publisher had no reading. */
function cell(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string-or-number price cell, as a number. */
function priceCell(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Bare SET ticker, as the venue spells it. */
function tickerOf(symbol: string): string {
  const upper = (symbol ?? "").trim().toUpperCase();
  if (!upper) throw new Error("settrade: a SET ticker is required");
  return upper;
}

// ── Caches ─────────────────────────────────────────────────────────────────
// One per logical endpoint, keyed by ticker or venue id. The quote endpoint is
// shared by three capabilities (day stats, the book, the profile's identity
// half), so one download serves all three. Only the two slow-moving payloads
// persist: a quote must not survive a reload, and the six-month close series
// and the filed highlights change at most daily.

const snapshotCache = new TtlCache<MarketSnapshot>({
  namespace: "zframes:settrade:snapshot",
  ttlMs: CACHE_TTL_MS,
});
const marketStatsCache = new TtlCache<MarketValuation>({
  namespace: "zframes:settrade:market-stats",
  ttlMs: 5 * 60_000,
});
const investorFlowCache = new TtlCache<InvestorTypeFlow>({
  namespace: "zframes:settrade:investor-flow",
  ttlMs: 5 * 60_000,
});
const quoteCache = new TtlCache<StockInfo>({
  namespace: "zframes:settrade:quote",
  ttlMs: CACHE_TTL_MS,
});
const profileCache = new TtlCache<EquityProfile>({
  namespace: "zframes:settrade:profile",
  ttlMs: 5 * 60_000,
});
const factsCache = new TtlCache<CompanyFacts>({
  namespace: "zframes:settrade:facts",
  ttlMs: 6 * 60 * 60_000,
  persist: true,
});
const historyCache = new TtlCache<SeriesPoint[]>({
  namespace: "zframes:settrade:history",
  ttlMs: 30 * 60_000,
  persist: true,
});

// ── Financial highlights ───────────────────────────────────────────────────

type MetricUnit = "money" | "per-share" | "ratio" | "percent";

/**
 * The published highlight labels, in publisher order, each with the label this
 * codebase uses and how to read its number. The upstream label is the key
 * because it is what identifies the row — the order is stable but not a
 * contract, and a row the publisher drops must simply not appear.
 */
const FINANCIAL_ROWS: [string, string, MetricUnit][] = [
  ["Asset (M.Baht)", "Total assets", "money"],
  ["Liabilities (M.Baht)", "Total liabilities", "money"],
  ["Equities (M.Baht)", "Shareholders' equity", "money"],
  ["Revenue (M.Baht)", "Revenue", "money"],
  ["Net Profit (M.Baht)", "Net profit", "money"],
  ["EPS (Baht)", "EPS", "per-share"],
  ["DE Ratio (Times)", "Debt to equity", "ratio"],
  ["Total Asset Turnover (Times)", "Asset turnover", "ratio"],
  ["Net Profit Margin (%)", "Net profit margin", "percent"],
  ["ROE (%)", "ROE", "percent"],
  ["ROA (%)", "ROA", "percent"],
];

const XBRL_UNITS: Record<MetricUnit, string> = {
  money: "USD",
  "per-share": "USD/shares",
  ratio: "ratio",
  percent: "percent",
};

/**
 * `divider: "k"` means the value is in THOUSANDS of baht — despite the row's
 * own "(M.Baht)" label, which is the units the exchange's factsheet *prints*,
 * not the units it ships. PTT's published 3,522,489,795.84 is 3.52 trillion
 * baht of assets, its real balance sheet, only once this multiplier is applied.
 */
function scaleBaht(value: number, divider: string | null | undefined): number {
  return divider === "k" ? value * 1000 : value;
}

/**
 * `"6M/2026 (30/06/26)"` → the fiscal period (`6M/2026`) and the period end as
 * an ISO date. Either half may be missing from a malformed stamp, and a metric
 * with no period is still a readable figure, so both degrade to "".
 */
function parseFiscalStamp(stamp: string): { period: string; end: string } {
  const period = stamp.split("(")[0]?.trim() ?? "";
  const parenthesised = /\(([^)]+)\)/.exec(stamp)?.[1]?.trim();
  let end = "";
  if (parenthesised) {
    const parts = splitDayFirst(parenthesised);
    if (parts)
      end = `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
  }
  return { period, end };
}

/**
 * Free, no-API-key provider for Settrade — the Stock Exchange of Thailand's own
 * market-data site — and the fleet's only source of Thai equities.
 *
 * Two halves. **Venue-level**: `market-snapshot` (one venue's index family, the
 * session's advancing/declining/unchanged breadth, and the exchange's own
 * valuation multiples) and `investor-type-flow` (how the session's turnover
 * split between institutions, broker proprietary books, foreign investors and
 * local individuals) — aggregation nothing outside the exchange can reproduce.
 * **Per symbol**: `day-stats`, `order-book`, `equity-profile`, `fundamentals`
 * and `price-history-daily` for one SET-listed company at a time.
 *
 * It answers only for symbols a card NAMES: this host publishes no stock list,
 * no ranking and no news, so nothing here can back a card that scans a
 * universe. Symbols are bare SET tickers ("PTT", "KBANK") — and "BTC" is a
 * mai-listed company here, not the coin.
 *
 * Everything is quoted in baht and converted once, on the way out, through the
 * shared `usdRate("THB")` chain; a `currency: "THB"` board then converts back
 * at the same rate, so a baht board shows the exchange's own baht numbers.
 *
 * The host sends no `Access-Control-Allow-Origin`, so the browser path goes
 * through the runtime's same-origin relay and the frames degrade to empty on a
 * static host.
 */
export class SettradeProvider implements MarketDataProvider {
  readonly name = "settrade";
  readonly capabilities: readonly Capability[] = [
    "market-snapshot",
    "investor-type-flow",
    "day-stats",
    "order-book",
    "equity-profile",
    "fundamentals",
    "price-history-daily",
  ];

  // ── Venue level ──────────────────────────────────────────────────────────

  async getMarketSnapshot(market = "SET"): Promise<MarketSnapshot> {
    const id = this.venue(market);
    return snapshotCache.get(id, () => this.fetchSnapshot(id));
  }

  async getInvestorTypeFlow(market = "SET"): Promise<InvestorTypeFlow> {
    const id = this.venue(market);
    return investorFlowCache.get(id, async () => {
      const [body, rate] = await Promise.all([
        fetchJson(MARKET_INVESTOR_TYPE_URL(id), InvestorTypeSchema, {
          proxied: true,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
        usdRate("THB"),
      ]);
      const investors: InvestorTypeRow[] = body.investors.map((row) => ({
        type: row.type,
        name: row.type_name_en ?? row.type,
        buy: row.buy_value / rate,
        sell: row.sell_value / rate,
        net: row.net_value / rate,
      }));
      return {
        market: id,
        asOf: parseBangkokDate(body.asof_date),
        totalValue: body.total_value / rate,
        investors,
        source: SOURCE,
      };
    });
  }

  private venue(market: string): string {
    const id = MARKETS[market.toLowerCase()];
    if (!id)
      throw new Error(
        `settrade: unknown market "${market}" — expected "SET" or "mai"`,
      );
    return id;
  }

  private async fetchSnapshot(id: string): Promise<MarketSnapshot> {
    const [body, thbPerUsd, valuation] = await Promise.all([
      fetchJson(MARKET_INFO_URL(id), MarketInfoSchema, {
        proxied: true,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      usdRate("THB"),
      this.fetchValuation(id),
    ]);
    const display = body.market_display_name ?? body.market_name;
    const snapshot: MarketSnapshot = {
      market: id,
      name: VENUE_NAMES[display] ?? display,
      status: normaliseStatus(body.market_status),
      asOf: parseBangkokTimestamp(body.datetime),
      indices: indicesOf(body, thbPerUsd),
      breadth: breadthOf(body),
      source: SOURCE,
    };
    if (body.market_status) snapshot.statusLabel = body.market_status;
    if (valuation) snapshot.valuation = valuation;
    return snapshot;
  }

  /**
   * The venue's multiples, on its own slower cadence. Fail-soft on purpose: the
   * index family and the breadth are the snapshot, and losing the valuation
   * must cost the board a strip of numbers rather than the whole card.
   */
  private async fetchValuation(id: string): Promise<MarketValuation | null> {
    try {
      return await marketStatsCache.get(id, async () => {
        const [body, rate] = await Promise.all([
          fetchJson(MARKET_STATISTICS_URL(id), MarketStatisticsSchema, {
            proxied: true,
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
          usdRate("THB"),
        ]);
        return {
          asOf: parseBangkokDate(body.asof_date),
          marketCap: body.market_cap / rate,
          peRatio: body.pe_ratio,
          pbvRatio: body.pbv_ratio,
          dividendYieldPct: body.dividend_yield,
          turnoverRatioPct: body.turnover_ratio,
        };
      });
    } catch {
      return null;
    }
  }

  // ── Per symbol ───────────────────────────────────────────────────────────

  /**
   * The quote endpoint, cached per ticker. Three capabilities read it, so a
   * profile card and a book card on the same stock cost one download.
   */
  private async quote(ticker: string): Promise<StockInfo> {
    return quoteCache.get(ticker, () =>
      fetchJson(STOCK_INFO_URL(ticker), StockInfoSchema, {
        proxied: true,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    );
  }

  /**
   * Last-session stats per named ticker. There is NO universe here — the host
   * publishes no stock list — so an empty request is an empty answer rather
   * than "everything".
   */
  async getDayStats(symbols?: string[]): Promise<Record<string, DayStats>> {
    const tickers = [...new Set((symbols ?? []).map(tickerOf))];
    if (tickers.length === 0) return {};
    const [rate, quotes] = await Promise.all([
      usdRate("THB"),
      Promise.all(tickers.map((ticker) => this.quote(ticker))),
    ]);
    const out: Record<string, DayStats> = {};
    tickers.forEach((ticker, i) => {
      const price = quotes[i].price_info;
      const last = cell(price.last);
      // A foreign-board line or a never-traded listing publishes a full row with
      // no last price; a zero there would draw a real crash.
      if (last === null) return;
      const prior = cell(price.prior);
      const value = cell(price.value);
      const stats: DayStats = {
        markPx: last / rate,
        prevDayPx: (prior ?? last) / rate,
        // A percent is not money and must not be divided by the rate.
        changePct: cell(price.percent_change) ?? 0,
      };
      if (value !== null) stats.dayNtlVlm = value / rate;
      out[ticker] = stats;
    });
    return out;
  }

  /**
   * Best bid and best offer. The exchange publishes exactly one level a side on
   * this endpoint, so `depth` has nothing to widen — the card gets the top of
   * book, never a ladder.
   */
  async getOrderBook(symbol: string, _depth?: number): Promise<OrderBook> {
    const ticker = tickerOf(symbol);
    const [info, rate] = await Promise.all([
      this.quote(ticker),
      usdRate("THB"),
    ]);
    const price = info.price_info;
    const bidPrice = priceCell(price.bid_price);
    const askPrice = priceCell(price.offer_price);
    const bidSize = cell(price.bid_volume);
    const askSize = cell(price.offer_volume);
    if (bidPrice === null || askPrice === null)
      throw new Error(`settrade order book ${ticker}: no two-sided quote`);
    const bid = bidPrice / rate;
    const ask = askPrice / rate;
    const mid = (bid + ask) / 2;
    return {
      symbol: ticker,
      pair: `${ticker}/THB`,
      // Size is a share count, which no exchange rate touches; one level means
      // the cumulative depth IS that level's size.
      bids: [{ price: bid, size: bidSize ?? 0, cumulativeSize: bidSize ?? 0 }],
      asks: [{ price: ask, size: askSize ?? 0, cumulativeSize: askSize ?? 0 }],
      mid,
      spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : 0,
    };
  }

  async getEquityProfile(symbol: string): Promise<EquityProfile> {
    const ticker = tickerOf(symbol);
    return profileCache.get(ticker, async () => {
      // The statistics half is valuation garnish; losing it must not blank the
      // identity and the price, which the quote alone already carries.
      const [info, statistics, rate] = await Promise.all([
        this.quote(ticker),
        fetchJson(STOCK_STATISTICS_URL(ticker), StockStatisticsSchema, {
          proxied: true,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }).catch(() => null),
        usdRate("THB"),
      ]);
      const price = info.price_info;
      const profile: EquityProfile = {
        symbol: ticker,
        companyName: info.full_name_en ?? ticker,
      };
      if (info.market) profile.exchange = info.market;
      if (info.sector_name_en) profile.sector = info.sector_name_en;
      if (info.industry_name_en) profile.industry = info.industry_name_en;
      const last = cell(price.last);
      if (last !== null) profile.price = last / rate;
      const prior = cell(price.prior);
      if (prior !== null) profile.previousClose = prior / rate;
      if (statistics) {
        const marketCap = cell(statistics.market_cap);
        if (marketCap !== null) profile.marketCap = marketCap / rate;
        const high = cell(statistics.high_52w);
        if (high !== null) profile.fiftyTwoWeekHigh = high / rate;
        const low = cell(statistics.low_52w);
        if (low !== null) profile.fiftyTwoWeekLow = low / rate;
        const dividendYield = cell(statistics.dividend_yield);
        // A yield is already a percent, so it is not converted.
        if (dividendYield !== null) profile.dividendYield = dividendYield;
      }
      return profile;
    });
  }

  /**
   * The exchange's own financial highlights — a Thai-listed company's answer to
   * the SEC XBRL facts the US half of this capability serves.
   */
  async getCompanyFacts(symbol: string): Promise<CompanyFacts> {
    const ticker = tickerOf(symbol);
    return factsCache.get(ticker, async () => {
      const [financial, info, rate] = await Promise.all([
        fetchJson(STOCK_FINANCIAL_URL(ticker), StockFinancialSchema, {
          proxied: true,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
        this.quote(ticker).catch(() => null),
        usdRate("THB"),
      ]);
      const { period, end } = parseFiscalStamp(financial.asof_date);
      const published = new Map(financial.data.map((row) => [row.label, row]));
      const metrics: FinancialMetric[] = [];
      for (const [upstream, label, unit] of FINANCIAL_ROWS) {
        const row = published.get(upstream);
        const raw = cell(row?.value);
        if (!row || raw === null) continue;
        const value =
          unit === "money"
            ? scaleBaht(raw, row.divider) / rate
            : unit === "per-share"
              ? raw / rate
              : raw;
        metrics.push({
          label,
          value,
          unit: XBRL_UNITS[unit],
          end,
          fiscalPeriod: period,
          form: "Settrade financial highlights",
        });
      }
      return {
        // The SEC half keys this by CIK; a Thai listing has none, so its ticker
        // is the identifier — the frame only prints the name beside it.
        cik: ticker,
        entityName: info?.full_name_en ?? ticker,
        metrics,
      };
    });
  }

  /**
   * About six months of daily closes — the endpoint answers 121 rows and
   * ignores any `period` query, so there is no longer history to ask for.
   *
   * `asset` is required: a SET ticker has no sensible default, and the crypto
   * source this capability usually routes to defaults to BTC — which is a
   * mai-listed company on this venue.
   */
  async getDailyCloseHistory(asset?: string): Promise<SeriesPoint[]> {
    if (!asset)
      throw new Error(
        "settrade close history: a SET ticker is required (there is no default symbol)",
      );
    const ticker = tickerOf(asset);
    return historyCache.get(ticker, async () => {
      const [body, rate] = await Promise.all([
        fetchJson(STOCK_HISTORICAL_URL(ticker), StockHistoricalSchema, {
          proxied: true,
          timeoutMs: 15_000,
        }),
        usdRate("THB"),
      ]);
      // Published newest-first; every consumer of this capability reads
      // oldest→newest.
      return body.data
        .map((row) => ({ time: row.date_long, close: cell(row.close) }))
        .filter((row): row is { time: number; close: number } =>
          Boolean(row.close !== null && Number.isFinite(row.time)),
        )
        .sort((a, b) => a.time - b.time)
        .map((row) => ({ time: row.time, value: row.close / rate }));
    });
  }
}
