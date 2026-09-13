import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettradeProvider as SettradeProviderType } from "./index";

// The snapshot cache and the fx-rate cache behind it are module-level
// singletons, so each test gets a genuinely fresh module (empty caches) via
// vi.resetModules() + a dynamic import — the same isolation the Bitkub and
// CoinGecko provider suites use.
type Ctor = typeof SettradeProviderType;

/** THB per USD used by every stub below, so expected USD values are exact. */
const FX = 31.26;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.SettradeProvider;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * The live body (2026-09-12), trimmed to three of the ten indices. `datetime` is
 * Bangkok local and `total_value` is baht; `unchange_volume` really does equal
 * `gainer_volume` upstream, which is why it is kept verbatim here.
 */
const MARKET_INFO = {
  market_name: "SET",
  market_display_name: "SET",
  market_status: "Closed",
  datetime: "12/09/2026 03:20:09",
  gainer_amount: 148,
  gainer_volume: 1.2111448e9,
  unchange_amount: 221,
  unchange_volume: 1.2111448e9,
  loser_amount: 290,
  loser_volume: 1.7138262e9,
  index: [
    {
      index_name: "SET",
      index_display_name: "SET",
      market: "SET",
      prior: 1615.07,
      last: 1604.52,
      change: -10.55,
      percent_change: -0.65,
      high: 1616.32,
      low: 1601.18,
      total_volume: 4.136e9,
      total_value: 4.1e10,
      flag_url: "https://www.settrade.com/flag/th.png",
    },
    {
      index_name: "SET50",
      index_display_name: "SET50",
      market: "SET",
      prior: 1041.2,
      last: 1035.44,
      change: -5.76,
      percent_change: -0.55,
      high: 1042.9,
      low: 1033.11,
      total_volume: 1.02e9,
      total_value: 2.6e10,
      flag_url: "https://www.settrade.com/flag/th.png",
    },
    {
      index_name: "sSET",
      index_display_name: "sSET",
      market: "SET",
      prior: 802.44,
      last: 806.11,
      change: 3.67,
      percent_change: 0.46,
      high: 807.02,
      low: 800.9,
      total_volume: 3.4e8,
      total_value: 1.4e9,
      flag_url: "https://www.settrade.com/flag/th.png",
    },
  ],
} as const;

/** `api/market/SET/statistics`, live 2026-09-12. Baht. */
const MARKET_STATISTICS = {
  asof_date: "11/09/2026",
  market_cap: 2.024208534e13,
  turnover_ratio: 46.56101690498642,
  pe_ratio: 15.98,
  pbv_ratio: 1.5,
  dividend_yield: 3.97,
} as const;

/** `api/market/SET/investortype`, live 2026-09-12. Baht. */
const INVESTOR_TYPE = {
  asof_date: "11/09/2026",
  total_value: 7.121301243683e10,
  investors: [
    {
      type: "institution",
      type_name_th: "สถาบัน",
      type_name_en: "Institution",
      buy_value: 4.05057908663e9,
      sell_value: 3.45638715767e9,
      net_value: 5.9419192896e8,
    },
    {
      type: "foreign",
      type_name_th: "ต่างประเทศ",
      type_name_en: "Foreign",
      buy_value: 3.985800134775e10,
      sell_value: 4.299549220112e10,
      net_value: -3.13749085337e9,
    },
  ],
} as const;

/**
 * `api/stock/PTT/info`, live 2026-09-12. Note `datetime` carries a TWO-digit
 * year here (the venue endpoints use four), and the two book prices are
 * STRINGS while every other price on the row is a JSON number.
 */
const STOCK_INFO = {
  abbr_name: "PTT",
  full_name_th: "บริษัท ปตท. จำกัด (มหาชน)",
  full_name_en: "PTT PUBLIC COMPANY LIMITED",
  market: "SET",
  market_status: "Closed",
  datetime: "12/09/26 03:20:09",
  industry: "RESOURC",
  industry_name_en: "Resources",
  sector: "ENERG",
  sector_name_en: "Energy & Utilities",
  security_type: "S",
  price_info: {
    prior: 42.0,
    last: 42.0,
    change: 0.0,
    percent_change: 0.0,
    open: 42.5,
    high: 42.75,
    low: 41.75,
    volume: 174267709,
    value: 7364957039.25,
    average: 42.26231,
    bid_price: "41.75",
    bid_volume: 18778400,
    offer_price: "42.00",
    offer_volume: 5126600,
    ceiling: 54.5,
    floor: 29.5,
    settlement_price: null,
    open_interest: null,
  },
  currency: "THB",
  par: 1.0,
} as const;

/** `api/stock/PTT/statistics`, live 2026-09-12. */
const STOCK_STATISTICS = {
  asof_date: "11/09/2026",
  par: 1.0,
  par_currency: "THB",
  market_cap: 1.1996458425e12,
  pe_ratio: 9.63,
  pbv_ratio: 1.0,
  dividend_yield: 5.48,
  turnover_ratio: 0.61,
  high_52w: 42.75,
  low_52w: 30.0,
  nvdr_buy_volume: 7.0834898e7,
  nvdr_sell_volume: 8.63079e7,
} as const;

/**
 * `api/stock/PTT/financial`, live 2026-09-12. `divider: "k"` means the value is
 * in THOUSANDS of baht despite the "(M.Baht)" label — the footgun this fixture
 * exists to pin.
 */
const STOCK_FINANCIAL = {
  asof_date: "6M/2026 (30/06/26)",
  remark: "",
  data: [
    { label: "Asset (M.Baht)", value: 3.52248979584e9, divider: "k" },
    { label: "Liabilities (M.Baht)", value: 1.74221847767e9, divider: "k" },
    { label: "Equities (M.Baht)", value: 1.19419443159e9, divider: "k" },
    { label: "Revenue (M.Baht)", value: 1.56859954858e9, divider: "k" },
    { label: "Net Profit (M.Baht)", value: 7.826289073e7, divider: "k" },
    { label: "EPS (Baht)", value: 2.76, divider: "" },
    { label: "DE Ratio (Times)", value: 0.9786252577842371, divider: "" },
    {
      label: "Total Asset Turnover (Times)",
      value: 0.8425744987699365,
      divider: "",
    },
    {
      label: "Net Profit Margin (%)",
      value: 7.623348551786309,
      divider: "",
    },
    { label: "ROE (%)", value: 10.621455828356169, divider: "" },
    { label: "ROA (%)", value: 8.527719609912033, divider: "" },
  ],
} as const;

/** `api/stock/PTT/historical`, trimmed to four of its 121 newest-first rows. */
const STOCK_HISTORICAL = {
  abbr_name: "PTT",
  data: [
    {
      date: "11/09/2026",
      date_long: 1789059600000,
      prior: 42.0,
      close: 42.0,
      change: 0.0,
      percent_change: 0.0,
      volume: 174267709.0,
      value: 7364957039.25,
      open_interest: null,
    },
    {
      date: "10/09/2026",
      date_long: 1788973200000,
      prior: 41.5,
      close: 42.0,
      change: 0.5,
      percent_change: 1.2,
      volume: 1.2e8,
      value: 5.0e9,
      open_interest: null,
    },
    {
      date: "09/09/2026",
      date_long: 1788886800000,
      prior: 41.0,
      close: 41.5,
      change: 0.5,
      percent_change: 1.22,
      volume: 1.1e8,
      value: 4.6e9,
      open_interest: null,
    },
    {
      date: "12/03/2026",
      date_long: 1773248400000,
      prior: 33.5,
      close: 35.0,
      change: 1.5,
      percent_change: 4.48,
      volume: 175483777.0,
      value: 5985724538.0,
      open_interest: null,
    },
  ],
} as const;

/** Every host the shared USD/THB chain can reach; anything else is a venue call. */
const FX_HOSTS = [
  "frankfurter",
  "fxratesapi",
  "currency-api",
  "data-api.ecb.europa.eu",
];

function isFxUrl(url: unknown): boolean {
  return FX_HOSTS.some((host) => String(url).includes(host));
}

/**
 * Route each stubbed request by URL: the provider fetches the venue AND the
 * USD/THB rate in parallel, so a single-response mock would feed the FX body to
 * the snapshot parser. Frankfurter (the chain's primary) answers here, so the
 * fallbacks stay untouched.
 */
function stubFetch(body: unknown = MARKET_INFO, status = 200) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      isFxUrl(url)
        ? jsonResponse({ rates: { THB: FX } })
        : jsonResponse(body, status),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The whole host, routed by path — what the per-stock capabilities need, since
 * several of them call two endpoints at once. A `null` route answers 404, which
 * is how the live host reports an unknown symbol.
 */
function stubHost(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((url: string) => {
    if (isFxUrl(url))
      return Promise.resolve(jsonResponse({ rates: { THB: FX } }));
    for (const [fragment, body] of Object.entries(routes))
      if (url.includes(fragment))
        return Promise.resolve(
          body === null
            ? jsonResponse({ error: "not found" }, 404)
            : jsonResponse(body),
        );
    return Promise.resolve(jsonResponse({ error: "unrouted" }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function venueUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => !isFxUrl(url));
}

describe("SettradeProvider", () => {
  let SettradeProvider: Ctor;

  beforeEach(async () => {
    SettradeProvider = await loadProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises the venue and per-stock capabilities under its pin name", () => {
    const provider = new SettradeProvider();
    expect(provider.name).toBe("settrade");
    expect(provider.capabilities).toEqual([
      "market-snapshot",
      "investor-type-flow",
      "day-stats",
      "order-book",
      "equity-profile",
      "fundamentals",
      "price-history-daily",
    ]);
  });

  describe("market snapshot", () => {
    it("reads the venue's index family and names the exchange in full", async () => {
      stubHost({ "/market/SET/info": MARKET_INFO });
      const snapshot = await new SettradeProvider().getMarketSnapshot();

      expect(snapshot.market).toBe("SET");
      expect(snapshot.name).toBe("Stock Exchange of Thailand");
      expect(snapshot.source).toBe("Settrade");
      expect(snapshot.indices.map((index) => index.symbol)).toEqual([
        "SET",
        "SET50",
        "sSET",
      ]);
      expect(snapshot.indices[0]).toMatchObject({
        last: 1604.52,
        prior: 1615.07,
        change: -10.55,
        changePct: -0.65,
        high: 1616.32,
        low: 1601.18,
        volume: 4.136e9,
      });
    });

    it("stamps the publisher's Bangkok-local timestamp as UTC epoch ms", async () => {
      stubHost({ "/market/SET/info": MARKET_INFO });
      const snapshot = await new SettradeProvider().getMarketSnapshot();
      // 12/09/2026 03:20:09 is day-first and UTC+7 → 2026-09-11T20:20:09Z.
      expect(snapshot.asOf).toBe(Date.UTC(2026, 8, 11, 20, 20, 9));
      expect(new Date(snapshot.asOf).toISOString()).toBe(
        "2026-09-11T20:20:09.000Z",
      );
    });

    it.each([
      ["Closed", "closed"],
      ["Open", "open"],
      ["Open(I)", "open"],
      ["Pre-Open", "pre-open"],
      ["Intermission", "unknown"],
    ])(
      "maps status %s to %s and keeps the raw wording",
      async (raw, mapped) => {
        stubHost({
          "/market/SET/info": { ...MARKET_INFO, market_status: raw },
        });
        const snapshot = await new SettradeProvider().getMarketSnapshot();
        expect(snapshot.status).toBe(mapped);
        expect(snapshot.statusLabel).toBe(raw);
      },
    );

    it("converts each index's traded value from baht to USD", async () => {
      stubHost({ "/market/SET/info": MARKET_INFO });
      const snapshot = await new SettradeProvider().getMarketSnapshot();
      expect(snapshot.indices[0].valueUsd).toBeCloseTo(4.1e10 / FX, 6);
      expect(snapshot.indices[2].valueUsd).toBeCloseTo(1.4e9 / FX, 6);
      // Volume is a share count, so it is NOT divided by the rate.
      expect(snapshot.indices[0].volume).toBe(4.136e9);
    });

    it("passes the publisher's breadth through, duplicated volume and all", async () => {
      stubHost({ "/market/SET/info": MARKET_INFO });
      const { breadth } = await new SettradeProvider().getMarketSnapshot();
      expect(breadth).toEqual({
        gainers: 148,
        losers: 290,
        unchanged: 221,
        gainersVolume: 1.2111448e9,
        losersVolume: 1.7138262e9,
        // The venue publishes this equal to gainersVolume; not ours to "fix".
        unchangedVolume: 1.2111448e9,
      });
    });

    it("carries the venue's valuation, market cap converted and multiples as published", async () => {
      stubHost({
        "/market/SET/info": MARKET_INFO,
        "/market/SET/statistics": MARKET_STATISTICS,
      });
      const { valuation } = await new SettradeProvider().getMarketSnapshot();
      expect(valuation?.asOf).toBe("2026-09-11");
      expect(valuation?.marketCap).toBeCloseTo(2.024208534e13 / FX, 4);
      // Ratios and percentages are unit-less; dividing them by a rate would be
      // the same class of bug as leaving a price in baht.
      expect(valuation?.peRatio).toBe(15.98);
      expect(valuation?.pbvRatio).toBe(1.5);
      expect(valuation?.dividendYieldPct).toBe(3.97);
      expect(valuation?.turnoverRatioPct).toBeCloseTo(46.561, 3);
    });

    it("still serves the snapshot when the valuation endpoint is down", async () => {
      stubHost({
        "/market/SET/info": MARKET_INFO,
        "/market/SET/statistics": null,
      });
      const snapshot = await new SettradeProvider().getMarketSnapshot();
      expect(snapshot.valuation).toBeUndefined();
      expect(snapshot.indices).toHaveLength(3);
    });

    it("accepts either venue case-insensitively and asks for the publisher's spelling", async () => {
      const fetchMock = stubHost({
        "/market/mai/info": { ...MARKET_INFO, market_display_name: "mai" },
      });
      const snapshot = await new SettradeProvider().getMarketSnapshot("MAI");
      expect(snapshot.market).toBe("mai");
      expect(snapshot.name).toBe("Market for Alternative Investment");
      expect(venueUrls(fetchMock)[0]).toContain("/api/market/mai/info");
    });

    it("throws on a market the venue does not publish", async () => {
      stubFetch();
      await expect(
        new SettradeProvider().getMarketSnapshot("SETX"),
      ).rejects.toThrow(/unknown market/);
    });

    it("throws rather than half-parsing a body that lost its index array", async () => {
      stubHost({ "/market/SET/info": { ...MARKET_INFO, index: [] } });
      await expect(
        new SettradeProvider().getMarketSnapshot(),
      ).rejects.toThrow();
    });

    it("throws on a timestamp it cannot read day-first", async () => {
      stubHost({
        "/market/SET/info": { ...MARKET_INFO, datetime: "2026-09-12T03:20:09" },
      });
      await expect(new SettradeProvider().getMarketSnapshot()).rejects.toThrow(
        /unreadable datetime/,
      );
    });

    it("serves a second call for the same venue from cache", async () => {
      const fetchMock = stubHost({ "/market/SET/info": MARKET_INFO });
      const provider = new SettradeProvider();
      await provider.getMarketSnapshot("SET");
      await provider.getMarketSnapshot("set");
      expect(
        venueUrls(fetchMock).filter((url) => url.includes("/info")),
      ).toHaveLength(1);
    });
  });

  describe("investor-type flow", () => {
    it("converts every leg to USD and keeps the publisher's class names", async () => {
      stubHost({ "/market/SET/investortype": INVESTOR_TYPE });
      const flow = await new SettradeProvider().getInvestorTypeFlow("SET");

      expect(flow.market).toBe("SET");
      expect(flow.asOf).toBe("2026-09-11");
      expect(flow.source).toBe("Settrade");
      expect(flow.totalValue).toBeCloseTo(7.121301243683e10 / FX, 4);
      expect(flow.investors.map((row) => row.name)).toEqual([
        "Institution",
        "Foreign",
      ]);
      expect(flow.investors[1]).toMatchObject({ type: "foreign" });
      expect(flow.investors[1].buy).toBeCloseTo(3.985800134775e10 / FX, 4);
      expect(flow.investors[1].sell).toBeCloseTo(4.299549220112e10 / FX, 4);
      // Foreign investors were net sellers; the sign must survive conversion.
      expect(flow.investors[1].net).toBeLessThan(0);
      expect(flow.investors[1].net).toBeCloseTo(-3.13749085337e9 / FX, 4);
    });

    it("throws on a market the venue does not publish", async () => {
      stubFetch();
      await expect(
        new SettradeProvider().getInvestorTypeFlow("NYSE"),
      ).rejects.toThrow(/unknown market/);
    });
  });

  describe("day stats", () => {
    it("answers nothing for an empty request — there is no universe to scan", async () => {
      const fetchMock = stubHost({ "/stock/PTT/info": STOCK_INFO });
      const provider = new SettradeProvider();
      expect(await provider.getDayStats()).toEqual({});
      expect(await provider.getDayStats([])).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("converts the money legs and leaves the percent alone", async () => {
      stubHost({ "/stock/PTT/info": STOCK_INFO });
      const stats = await new SettradeProvider().getDayStats(["ptt"]);
      expect(Object.keys(stats)).toEqual(["PTT"]);
      expect(stats.PTT.markPx).toBeCloseTo(42 / FX, 8);
      expect(stats.PTT.prevDayPx).toBeCloseTo(42 / FX, 8);
      expect(stats.PTT.dayNtlVlm).toBeCloseTo(7364957039.25 / FX, 4);
      expect(stats.PTT.changePct).toBe(0);
    });

    it("skips a listing the venue published with no last price", async () => {
      stubHost({
        "/stock/PTT-F/info": {
          ...STOCK_INFO,
          abbr_name: "PTT-F",
          security_type: "F",
          price_info: { ...STOCK_INFO.price_info, last: null },
        },
      });
      // A zero here would draw a real crash on the card, so the row is dropped.
      expect(await new SettradeProvider().getDayStats(["PTT-F"])).toEqual({});
    });

    it("throws on a symbol the venue does not list", async () => {
      stubHost({ "/stock/NOPE/info": null });
      await expect(
        new SettradeProvider().getDayStats(["NOPE"]),
      ).rejects.toThrow(/404/);
    });
  });

  describe("order book", () => {
    it("reads the best bid and offer, parsing the venue's STRING prices", async () => {
      stubHost({ "/stock/PTT/info": STOCK_INFO });
      const book = await new SettradeProvider().getOrderBook("PTT");

      expect(book.symbol).toBe("PTT");
      expect(book.pair).toBe("PTT/THB");
      expect(book.bids).toHaveLength(1);
      expect(book.asks).toHaveLength(1);
      expect(book.bids[0].price).toBeCloseTo(41.75 / FX, 8);
      expect(book.asks[0].price).toBeCloseTo(42.0 / FX, 8);
      // Size is a share count — it must NOT be divided by the rate — and with
      // one level a side the cumulative depth IS that level.
      expect(book.bids[0].size).toBe(18778400);
      expect(book.bids[0].cumulativeSize).toBe(18778400);
      expect(book.asks[0].size).toBe(5126600);
      expect(book.mid).toBeCloseTo((41.75 + 42.0) / 2 / FX, 8);
      expect(book.spreadPct).toBeCloseTo(
        ((42.0 - 41.75) / ((41.75 + 42.0) / 2)) * 100,
        8,
      );
    });

    it("throws rather than inventing a side the venue did not quote", async () => {
      stubHost({
        "/stock/PTT/info": {
          ...STOCK_INFO,
          price_info: { ...STOCK_INFO.price_info, offer_price: null },
        },
      });
      await expect(new SettradeProvider().getOrderBook("PTT")).rejects.toThrow(
        /no two-sided quote/,
      );
    });
  });

  describe("equity profile", () => {
    it("merges the quote's identity with the statistics' valuation, in USD", async () => {
      stubHost({
        "/stock/PTT/info": STOCK_INFO,
        "/stock/PTT/statistics": STOCK_STATISTICS,
      });
      const profile = await new SettradeProvider().getEquityProfile("ptt");

      expect(profile).toMatchObject({
        symbol: "PTT",
        companyName: "PTT PUBLIC COMPANY LIMITED",
        exchange: "SET",
        sector: "Energy & Utilities",
        industry: "Resources",
        // A yield is already a percent, so it is passed through.
        dividendYield: 5.48,
      });
      expect(profile.price).toBeCloseTo(42 / FX, 8);
      expect(profile.previousClose).toBeCloseTo(42 / FX, 8);
      expect(profile.marketCap).toBeCloseTo(1.1996458425e12 / FX, 4);
      expect(profile.fiftyTwoWeekHigh).toBeCloseTo(42.75 / FX, 8);
      expect(profile.fiftyTwoWeekLow).toBeCloseTo(30.0 / FX, 8);
    });

    it("keeps the identity and the price when statistics fails", async () => {
      stubHost({
        "/stock/PTT/info": STOCK_INFO,
        "/stock/PTT/statistics": null,
      });
      const profile = await new SettradeProvider().getEquityProfile("PTT");
      expect(profile.companyName).toBe("PTT PUBLIC COMPANY LIMITED");
      expect(profile.price).toBeCloseTo(42 / FX, 8);
      expect(profile.marketCap).toBeUndefined();
      expect(profile.fiftyTwoWeekHigh).toBeUndefined();
    });

    it("throws on a symbol the venue does not list", async () => {
      stubHost({ "/stock/NOPE/info": null, "/stock/NOPE/statistics": null });
      await expect(
        new SettradeProvider().getEquityProfile("NOPE"),
      ).rejects.toThrow(/404/);
    });
  });

  describe("company facts", () => {
    it("scales the thousands-of-baht rows before converting them", async () => {
      stubHost({
        "/stock/PTT/financial": STOCK_FINANCIAL,
        "/stock/PTT/info": STOCK_INFO,
      });
      const facts = await new SettradeProvider().getCompanyFacts("PTT");
      const byLabel = new Map(facts.metrics.map((m) => [m.label, m]));

      // The row is labelled "(M.Baht)" and shipped in THOUSANDS: PTT's real
      // balance sheet is ~3.52 TRILLION baht, not 3.52 billion.
      const assets = byLabel.get("Total assets")!;
      expect(assets.unit).toBe("USD");
      expect(assets.value).toBeCloseTo((3.52248979584e9 * 1000) / FX, 2);
      expect(assets.value).toBeGreaterThan(1e11);

      expect(byLabel.get("Net profit")!.value).toBeCloseTo(
        (7.826289073e7 * 1000) / FX,
        2,
      );
      // EPS carries no divider, so it converts as a bare per-share figure.
      const eps = byLabel.get("EPS")!;
      expect(eps.unit).toBe("USD/shares");
      expect(eps.value).toBeCloseTo(2.76 / FX, 8);
    });

    it("keeps ratios and percentages unconverted, under their own units", async () => {
      stubHost({
        "/stock/PTT/financial": STOCK_FINANCIAL,
        "/stock/PTT/info": STOCK_INFO,
      });
      const facts = await new SettradeProvider().getCompanyFacts("PTT");
      const byLabel = new Map(facts.metrics.map((m) => [m.label, m]));

      expect(byLabel.get("Debt to equity")).toMatchObject({
        unit: "ratio",
        value: 0.9786252577842371,
      });
      expect(byLabel.get("Asset turnover")!.unit).toBe("ratio");
      expect(byLabel.get("ROE")).toMatchObject({
        unit: "percent",
        value: 10.621455828356169,
      });
      expect(byLabel.get("Net profit margin")!.unit).toBe("percent");
    });

    it("reads the two-digit-year period end out of the fiscal stamp", async () => {
      stubHost({
        "/stock/PTT/financial": STOCK_FINANCIAL,
        "/stock/PTT/info": STOCK_INFO,
      });
      const facts = await new SettradeProvider().getCompanyFacts("PTT");
      expect(facts.cik).toBe("PTT");
      expect(facts.entityName).toBe("PTT PUBLIC COMPANY LIMITED");
      for (const metric of facts.metrics) {
        // "6M/2026 (30/06/26)" — day-first, two-digit year, 20xx.
        expect(metric.end).toBe("2026-06-30");
        expect(metric.fiscalPeriod).toBe("6M/2026");
        expect(metric.form).toBe("Settrade financial highlights");
      }
    });

    it("falls back to the ticker when the quote endpoint is unavailable", async () => {
      stubHost({
        "/stock/PTT/financial": STOCK_FINANCIAL,
        "/stock/PTT/info": null,
      });
      const facts = await new SettradeProvider().getCompanyFacts("PTT");
      expect(facts.entityName).toBe("PTT");
      expect(facts.metrics.length).toBe(11);
    });
  });

  describe("daily close history", () => {
    it("sorts the publisher's newest-first rows oldest→newest and converts", async () => {
      stubHost({ "/stock/PTT/historical": STOCK_HISTORICAL });
      const history = await new SettradeProvider().getDailyCloseHistory("ptt");

      expect(history.map((point) => point.time)).toEqual([
        1773248400000, 1788886800000, 1788973200000, 1789059600000,
      ]);
      expect(history[0].value).toBeCloseTo(35.0 / FX, 8);
      expect(history[3].value).toBeCloseTo(42.0 / FX, 8);
    });

    it("refuses to default the symbol — BTC here is a mai-listed company", async () => {
      const fetchMock = stubHost({ "/stock/PTT/historical": STOCK_HISTORICAL });
      await expect(
        new SettradeProvider().getDailyCloseHistory(),
      ).rejects.toThrow(/SET ticker is required/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops a session the venue published with no close", async () => {
      stubHost({
        "/stock/PTT/historical": {
          abbr_name: "PTT",
          data: [
            { date: "11/09/2026", date_long: 1789059600000, close: 42.0 },
            { date: "10/09/2026", date_long: 1788973200000, close: null },
          ],
        },
      });
      const history = await new SettradeProvider().getDailyCloseHistory("PTT");
      expect(history).toHaveLength(1);
    });
  });
});
