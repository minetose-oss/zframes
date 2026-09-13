import type {
  Capability,
  IndexQuote,
  MarketBreadth,
  MarketDataProvider,
  MarketSnapshot,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchJson } from "@zframes/data-primitives/fetch";
import { usdRate } from "@zframes/data-primitives/fx-rate";
import { z } from "zod";

const MARKET_INFO_URL = (market: string) =>
  `https://api.settrade.com/api/market/${market}/info`;

/** Intraday restamps, so a minute keeps a board fresh without hammering the venue. */
const CACHE_TTL_MS = 60_000;

/** The publisher's own spelling of each venue id, by lower-cased input. */
const MARKETS: Record<string, string> = { set: "SET", mai: "mai" };

/** What the exchange calls itself in full; the API only sends the short badge. */
const VENUE_NAMES: Record<string, string> = {
  SET: "Stock Exchange of Thailand",
  mai: "Market for Alternative Investment",
};

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

/** Bangkok is UTC+7 year-round — Thailand has never observed DST. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;

/**
 * `"12/09/2026 03:20:09"` — day-first, Bangkok local. Parsed by hand because
 * `Date.parse` reads an unqualified `12/09/2026` as MONTH-first and in the
 * runtime's own zone, which is wrong twice over and wrong *plausibly*: the
 * result is a real date up to eleven months off.
 */
function parseBangkokTimestamp(value: string): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (!match) throw new Error(`settrade: unreadable datetime "${value}"`);
  const [day, month, year, hour, minute, second] = match.slice(1).map(Number);
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) - BANGKOK_OFFSET_MS
  );
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

const snapshotCache = new TtlCache<MarketSnapshot>({
  namespace: "zframes:settrade:snapshot",
  ttlMs: CACHE_TTL_MS,
});

/**
 * Free, no-API-key provider for Settrade — the Stock Exchange of Thailand's own
 * market-data site — serving the `market-snapshot` capability: one venue's index
 * family (SET, SET50, SET100, the ESG and high-dividend cuts) plus the session's
 * advancing/declining/unchanged breadth, which is aggregation nothing outside
 * the exchange can reproduce.
 *
 * Venue-level only: there is no per-stock data here. The host sends no
 * `Access-Control-Allow-Origin`, so the browser path goes through the runtime's
 * same-origin relay and the frames degrade to empty on a static host.
 */
export class SettradeProvider implements MarketDataProvider {
  readonly name = "settrade";
  readonly capabilities: readonly Capability[] = ["market-snapshot"];

  async getMarketSnapshot(market = "SET"): Promise<MarketSnapshot> {
    const id = MARKETS[market.toLowerCase()];
    if (!id)
      throw new Error(
        `settrade: unknown market "${market}" — expected "SET" or "mai"`,
      );
    return snapshotCache.get(id, () => this.fetchSnapshot(id));
  }

  private async fetchSnapshot(id: string): Promise<MarketSnapshot> {
    const [body, thbPerUsd] = await Promise.all([
      fetchJson(MARKET_INFO_URL(id), MarketInfoSchema, {
        proxied: true,
        timeoutMs: 10_000,
      }),
      usdRate("THB"),
    ]);
    const display = body.market_display_name ?? body.market_name;
    const snapshot: MarketSnapshot = {
      market: id,
      name: VENUE_NAMES[display] ?? display,
      status: normaliseStatus(body.market_status),
      asOf: parseBangkokTimestamp(body.datetime),
      indices: indicesOf(body, thbPerUsd),
      breadth: breadthOf(body),
      source: "Settrade",
    };
    if (body.market_status) snapshot.statusLabel = body.market_status;
    return snapshot;
  }
}
