import { afterEach, describe, expect, it, vi } from "vitest";
import type { usdRate as usdRateType } from "./fx-rate";

// The cache is a module-level singleton, so each test gets a genuinely fresh
// module via vi.resetModules() + a dynamic import — the same isolation the
// provider suites use, so a primed rate can't leak into a later error path.
async function loadUsdRate(): Promise<typeof usdRateType> {
  vi.resetModules();
  return (await import("./fx-rate")).usdRate;
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
 * Real captured bodies (2026-08-03), trimmed only of irrelevant keys, so the
 * parsers are tested against the shapes the wire actually produces — including
 * currency-api's lower-case keys and SDMX's index-keyed observation tuples.
 */
const BODIES = {
  frankfurter: {
    amount: 1.0,
    base: "USD",
    date: "2026-07-31",
    rates: { THB: 33.465 },
  },
  fxratesapi: {
    success: true,
    timestamp: 1_785_740_400,
    base: "USD",
    rates: { THB: 33.3330042997 },
  },
  currencyApi: {
    date: "2026-08-03",
    usd: { aed: 3.6725, eur: 0.8709, thb: 33.3446932 },
  },
  /** THB per EUR; observation "1" is the newest of the two requested. */
  ecbThb: {
    dataSets: [
      {
        series: {
          "0:0:0:0:0": {
            observations: {
              "0": [38.496, 0, 0, null, null],
              "1": [38.435, 0, 0, null, null],
            },
          },
        },
      },
    ],
  },
  /** USD per EUR — the other half of the cross. 38.435 / 1.1485 = 33.464… */
  ecbUsd: {
    dataSets: [
      {
        series: {
          "0:0:0:0:0": {
            observations: {
              "0": [1.1476, 0, 0, null, null],
              "1": [1.1485, 0, 0, null, null],
            },
          },
        },
      },
    ],
  },
} as const;

const ECB_CROSS = 38.435 / 1.1485;

/**
 * Stub the chain host-by-host. `overrides` maps a URL fragment to either a body
 * (served 200) or `{ body, status }`; an unlisted fragment resolves to its real
 * captured body. A URL matching nothing throws, so a source added to the chain
 * without a stub fails loudly rather than silently reading someone else's body.
 */
function stubChain(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    frankfurter: BODIES.frankfurter,
    fxratesapi: BODIES.fxratesapi,
    "currency-api": BODIES.currencyApi,
    "D.THB.EUR": BODIES.ecbThb,
    "D.USD.EUR": BODIES.ecbUsd,
    ...overrides,
  };
  const fetchMock = vi.fn((url: string) => {
    const text = String(url);
    const hit = Object.keys(table).find((fragment) => text.includes(fragment));
    if (!hit) throw new Error(`unstubbed fx url: ${text}`);
    const entry = table[hit];
    const isEnvelope =
      !!entry &&
      typeof entry === "object" &&
      "status" in (entry as Record<string, unknown>);
    return Promise.resolve(
      isEnvelope
        ? jsonResponse(
            (entry as { body?: unknown }).body ?? null,
            (entry as { status: number }).status,
          )
        : jsonResponse(entry),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("usdRate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers Frankfurter and asks nothing else when it answers", async () => {
    const fetchMock = stubChain();
    const usdRate = await loadUsdRate();

    expect(await usdRate("THB")).toBeCloseTo(33.465, 10);
    expect(urls(fetchMock)).toEqual([
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB",
    ]);
  });

  it("falls through to the next source when one throws", async () => {
    const fetchMock = stubChain({ frankfurter: { status: 503 } });
    const usdRate = await loadUsdRate();

    expect(await usdRate("THB")).toBeCloseTo(33.3330042997, 10);
    expect(urls(fetchMock)[1]).toContain("api.fxratesapi.com");
  });

  it("treats an implausible rate exactly like an outage", async () => {
    // A wrong-but-finite rate misprices the entire board silently, so an
    // inverted quote must fall through rather than be trusted.
    const fetchMock = stubChain({
      frankfurter: { ...BODIES.frankfurter, rates: { THB: 0.03 } },
    });
    const usdRate = await loadUsdRate();

    expect(await usdRate("THB")).toBeCloseTo(33.3330042997, 10);
    expect(urls(fetchMock).length).toBeGreaterThan(1);
  });

  it("reads currency-api's lower-case, base-keyed shape", async () => {
    stubChain({
      frankfurter: { status: 500 },
      fxratesapi: { status: 500 },
    });
    const usdRate = await loadUsdRate();

    // {usd:{thb:…}} — not {rates:{THB:…}}; the upper-case key would yield 0 and
    // fall through to the ECB cross instead.
    expect(await usdRate("THB")).toBeCloseTo(33.3446932, 10);
  });

  it("crosses the ECB's two EUR-based series as a last resort", async () => {
    const fetchMock = stubChain({
      frankfurter: { status: 500 },
      fxratesapi: { status: 500 },
      "currency-api": { status: 500 },
    });
    const usdRate = await loadUsdRate();

    // THB/EUR ÷ USD/EUR = 38.435 / 1.1485 — and it must read the NEWEST
    // observation ("1"), not whichever key enumerates first.
    expect(await usdRate("THB")).toBeCloseTo(ECB_CROSS, 10);
    const hit = urls(fetchMock);
    expect(hit.filter((u) => u.includes("D.THB.EUR"))).toHaveLength(1);
    expect(hit.filter((u) => u.includes("D.USD.EUR"))).toHaveLength(1);
  });

  it("names every failed source when the whole chain is down", async () => {
    stubChain({
      frankfurter: { status: 500 },
      fxratesapi: { status: 429 },
      "currency-api": { usd: {} },
      "D.THB.EUR": { dataSets: [] },
    });
    const usdRate = await loadUsdRate();

    const error = await usdRate("THB").then(
      () => new Error("expected the chain to throw"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain("fx-rate: no USD/THB rate");
    expect(error.message).toContain("frankfurter");
    expect(error.message).toContain("fxratesapi");
    expect(error.message).toContain("currency-api");
    expect(error.message).toContain("ecb-cross");
  });

  it("serves a cached rate within the TTL rather than refetching", async () => {
    const fetchMock = stubChain();
    const usdRate = await loadUsdRate();

    expect(await usdRate("THB")).toBeCloseTo(33.465, 10);
    expect(await usdRate("thb")).toBeCloseTo(33.465, 10);
    expect(urls(fetchMock)).toHaveLength(1);
  });
});
