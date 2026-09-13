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

  it("advertises the market-snapshot capability under its pin name", () => {
    const provider = new SettradeProvider();
    expect(provider.name).toBe("settrade");
    expect(provider.capabilities).toEqual(["market-snapshot"]);
  });

  it("reads the venue's index family and names the exchange in full", async () => {
    stubFetch();
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
    stubFetch();
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
  ])("maps status %s to %s and keeps the raw wording", async (raw, mapped) => {
    stubFetch({ ...MARKET_INFO, market_status: raw });
    const snapshot = await new SettradeProvider().getMarketSnapshot();
    expect(snapshot.status).toBe(mapped);
    expect(snapshot.statusLabel).toBe(raw);
  });

  it("converts each index's traded value from baht to USD", async () => {
    stubFetch();
    const snapshot = await new SettradeProvider().getMarketSnapshot();
    expect(snapshot.indices[0].valueUsd).toBeCloseTo(4.1e10 / FX, 6);
    expect(snapshot.indices[2].valueUsd).toBeCloseTo(1.4e9 / FX, 6);
    // Volume is a share count, so it is NOT divided by the rate.
    expect(snapshot.indices[0].volume).toBe(4.136e9);
  });

  it("passes the publisher's breadth through, duplicated volume and all", async () => {
    stubFetch();
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

  it("accepts either venue case-insensitively and asks for the publisher's spelling", async () => {
    const fetchMock = stubFetch({ ...MARKET_INFO, market_display_name: "mai" });
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
    stubFetch({ ...MARKET_INFO, index: [] });
    await expect(new SettradeProvider().getMarketSnapshot()).rejects.toThrow();
  });

  it("throws on a timestamp it cannot read day-first", async () => {
    stubFetch({ ...MARKET_INFO, datetime: "2026-09-12T03:20:09" });
    await expect(new SettradeProvider().getMarketSnapshot()).rejects.toThrow(
      /unreadable datetime/,
    );
  });

  it("serves a second call for the same venue from cache", async () => {
    const fetchMock = stubFetch();
    const provider = new SettradeProvider();
    await provider.getMarketSnapshot("SET");
    await provider.getMarketSnapshot("set");
    expect(venueUrls(fetchMock)).toHaveLength(1);
  });
});
