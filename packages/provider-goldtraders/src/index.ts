import type {
  Capability,
  MarketDataProvider,
  RetailGoldPrice,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchText } from "@zframes/data-primitives/fetch";
import { usdRate } from "@zframes/data-primitives/fx-rate";

const GTA_URL = "https://classic.goldtraders.or.th/";

/** The association revises the announcement several times on a busy day. */
const CACHE_TTL_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** One Thai gold baht-weight of 96.5% gold — the unit the announcement quotes. */
const UNIT_GRAMS = 15.244;
const PURITY = 0.965;
/** The announcement is stamped in Asia/Bangkok, which has no DST. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;
const BE_OFFSET = 543;

/**
 * The four ASP.NET label ids the announcement's figures render into, plus the
 * one carrying its timestamp and revision. This is a scrape, so the ids are the
 * whole contract: if the page is restructured the reads below throw rather than
 * quietly publishing a stale or partial quote.
 *
 * `lblOMBuy` is the ornament row the page labels ฐานภาษี (tax base) — the
 * reference the trade buys ornaments back at, which is the buy side of that
 * pair.
 */
const IDS = {
  barSell: "DetailPlace_uc_goldprices1_lblBLSell",
  barBuy: "DetailPlace_uc_goldprices1_lblBLBuy",
  ornamentSell: "DetailPlace_uc_goldprices1_lblOMSell",
  ornamentBuy: "DetailPlace_uc_goldprices1_lblOMBuy",
  announced: "DetailPlace_uc_goldprices1_lblAsTime",
} as const;

/**
 * The text inside one labelled span. The figures are nested (`<span id=…><b>
 * <font>68,050.00</font></b></span>`), so the span's inner HTML is taken up to
 * its closing tag and the markup stripped — a `>([^<]*)<` read would capture the
 * empty string between the span and the `<b>` and report every price as missing.
 */
function spanText(html: string, id: string): string | null {
  const open = new RegExp(`<span[^>]*\\bid="${escapeForRegex(id)}"[^>]*>`);
  const match = open.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = html.indexOf("</span>", start);
  if (end === -1) return null;
  return html
    .slice(start, end)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A published figure with thousands separators, or null when unreadable. */
function priceOf(html: string, id: string): number | null {
  const text = spanText(html, id);
  if (!text) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The announcement stamp, e.g. `13/09/2569 เวลา 09:03 น. (ครั้งที่ 1)` — a
 * Buddhist-era date, an Asia/Bangkok time, and which announcement of the day it
 * is. Either half may be absent without invalidating the prices, so this
 * degrades rather than throwing.
 */
function parseAnnouncement(html: string): {
  updatedAt: number;
  revision?: number;
} {
  const text = spanText(html, IDS.announced) ?? "";
  const stamp =
    /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]+(\d{1,2}):(\d{2}))?/.exec(text);
  const revisionMatch = /ครั้งที่\s*(\d+)/.exec(text);
  const revision = revisionMatch ? Number(revisionMatch[1]) : undefined;
  if (!stamp)
    return { updatedAt: Date.now(), ...(revision ? { revision } : {}) };
  const [, day, month, beYear, hour, minute] = stamp;
  const year = Number(beYear) - BE_OFFSET;
  const updatedAt =
    Date.UTC(
      year,
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
    ) - BANGKOK_OFFSET_MS;
  return {
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    ...(revision ? { revision } : {}),
  };
}

function parseRetailGold(html: string, thbPerUsd: number): RetailGoldPrice {
  const local = {
    bar: { buy: priceOf(html, IDS.barBuy), sell: priceOf(html, IDS.barSell) },
    ornament: {
      buy: priceOf(html, IDS.ornamentBuy),
      sell: priceOf(html, IDS.ornamentSell),
    },
  };
  const missing = Object.entries(local).flatMap(([kind, quote]) =>
    Object.entries(quote)
      .filter(([, value]) => value === null)
      .map(([side]) => `${kind}.${side}`),
  );
  if (missing.length > 0)
    throw new Error(
      `goldtraders: announcement labels missing or unreadable (${missing.join(", ")}) — the page structure changed`,
    );

  const toUsd = (thb: number) => thb / thbPerUsd;
  const bar = { buy: local.bar.buy!, sell: local.bar.sell! };
  const ornament = { buy: local.ornament.buy!, sell: local.ornament.sell! };

  return {
    source: "Gold Traders Association",
    quoteCurrency: "THB",
    unit: "baht-weight (15.244 g, 96.5%)",
    unitGrams: UNIT_GRAMS,
    purity: PURITY,
    bar: { buy: toUsd(bar.buy), sell: toUsd(bar.sell) },
    ornament: { buy: toUsd(ornament.buy), sell: toUsd(ornament.sell) },
    local: { bar, ornament },
    fxRate: 1 / thbPerUsd,
    ...parseAnnouncement(html),
  };
}

const goldCache = new TtlCache<RetailGoldPrice>({
  namespace: "zframes:goldtraders:retail",
  ttlMs: CACHE_TTL_MS,
});

/**
 * Free, no-API-key provider for the retail gold price the Gold Traders
 * Association of Thailand announces — the physical, THB-denominated quote a Thai
 * household actually transacts at, which is not the LBMA spot fix: it carries
 * the domestic premium, the baht, and the trade's own bid/ask.
 *
 * The association publishes no API, so this reads the announcement off its
 * classic page (proxied: the host sends no CORS header). It is therefore a
 * scrape and fails loudly — a missing label throws rather than publishing a
 * partial quote — and the cache's stale-on-error serves the last good
 * announcement while the page is unreachable.
 *
 * Provides `retail-gold-price`.
 */
export class GoldTradersProvider implements MarketDataProvider {
  readonly name = "goldtraders";
  readonly capabilities: readonly Capability[] = ["retail-gold-price"];

  async getRetailGoldPrice(): Promise<RetailGoldPrice> {
    return goldCache.get("latest", async () => {
      const [html, thbPerUsd] = await Promise.all([
        fetchText(GTA_URL, { proxied: true, timeoutMs: FETCH_TIMEOUT_MS }),
        usdRate("THB"),
      ]);
      return parseRetailGold(html, thbPerUsd);
    });
  }
}
