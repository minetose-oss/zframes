import { afterEach, describe, expect, it, vi } from "vitest";
import { Risk29Provider } from "./index";

const NOW = "2026-09-16T02:00:00.000Z";

const categories = [
  ["macro", "Macro", 18, 54, 2, 2],
  ["credit", "Credit", 14, 67, 2, 2],
  ["valuation", "Valuation", 12, null, 0, 0],
  ["sentiment", "Sentiment", 16, 62, 1, 1],
  ["qualitative", "Qualitative", 6, null, 0, 0],
  ["liquidity", "Liquidity", 14, 58, 1, 1],
  ["global", "Global", 10, 46, 2, 2],
  ["technical", "Technical", 10, 61, 2, 2],
].map(([id, label, weight, score, availableSignals, totalSignals]) => ({
  id,
  label,
  weight,
  score,
  state: score === null ? "unavailable" : Number(score) >= 65 ? "warning" : "watch",
  availableSignals,
  totalSignals,
}));

const rawSignals = [
  ["vix", "VIX", "sentiment", "FRED", "VIXCLS", 21.4, "index", 62],
  ["sp500_trend", "S&P 500 Trend", "technical", "FRED", "SP500", 6612, "index", 55],
  ["nasdaq_trend", "Nasdaq Trend", "technical", "FRED", "NASDAQCOM", 23120, "index", 67],
  ["curve_2s10s", "2Y-10Y Curve", "macro", "U.S. Treasury", "2s10s", 0.41, "pct-points", 48],
  ["hy_oas", "US HY OAS", "credit", "FRED", "BAMLH0A0HYM2", 3.42, "percent", 72],
  ["ig_oas", "US IG OAS", "credit", "FRED", "BAMLC0A0CM", 0.91, "percent", 62],
  ["real_yield_10y", "10Y TIPS Real Yield", "macro", "FRED", "DFII10", 1.71, "percent", 60],
  ["broad_dollar", "Broad Dollar Index", "global", "FRED", "DTWEXBGS", 120.2, "index", 44],
  ["ofr_fsi", "OFR Financial Stress", "liquidity", "OFR", "OFR FSI", 0.18, "index", 58],
  ["gold_trend", "Gold Trend", "global", "Metals", "XAU", 3680, "usd/oz", 48],
];

const signals = rawSignals.map(
  ([id, label, category, source, sourceSeries, value, unit, riskScore], i) => ({
    id,
    label,
    category,
    source,
    sourceSeries,
    value,
    unit,
    riskScore,
    state: Number(riskScore) >= 70 ? "warning" : Number(riskScore) >= 50 ? "watch" : "normal",
    direction: i % 3 === 0 ? "worsening" : i % 3 === 1 ? "flat" : "improving",
    change: i % 2 === 0 ? 1.2 : -0.4,
    changeWindow: "1d",
    asOf: "2026-09-15",
    fetchedAt: NOW,
    ageSeconds: 3600,
    freshness: "fresh",
    thresholdVersion: "risk29-poc-v1",
  }),
);

const SNAPSHOT = {
  schemaVersion: "1",
  modelVersion: "risk29-poc-0.1.0",
  thresholdVersion: "risk29-poc-v1",
  generatedAt: NOW,
  score: 58.7,
  state: "watch",
  regime: "risk-off-transition",
  categories,
  signals,
  changes: [
    {
      signalId: "hy_oas",
      label: "US HY OAS",
      fromState: "watch",
      toState: "warning",
      scoreDelta: 12,
      summary: "HY OAS widened and crossed the POC warning threshold.",
    },
  ],
  health: { available: 10, stale: 0, errored: 0, total: 10 },
};

const HISTORY = {
  schemaVersion: "1",
  generatedAt: NOW,
  points: [
    {
      time: Date.parse("2026-09-14T00:00:00Z"),
      score: 52,
      state: "watch",
      categoryScores: { macro: 50, credit: 59, sentiment: 55 },
    },
    {
      time: Date.parse("2026-09-15T00:00:00Z"),
      score: 58.7,
      state: "watch",
      categoryScores: { macro: 54, credit: 67, sentiment: 62 },
    },
  ],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Risk29Provider", () => {
  it("validates and returns the POC snapshot contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Risk29Provider("https://risk29.example");
    const result = await provider.getRisk29Snapshot();

    expect(result.schemaVersion).toBe("1");
    expect(result.signals).toHaveLength(10);
    expect(result.categories).toHaveLength(8);
    expect(result.signals[4]?.id).toBe("hy_oas");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a fresh snapshot cache entry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Risk29Provider("https://risk29.example");
    await provider.getRisk29Snapshot();
    await provider.getRisk29Snapshot();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns validated history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(HISTORY));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Risk29Provider("https://risk29.example");
    const result = await provider.getRisk29History();

    expect(result.points).toHaveLength(2);
    expect(result.points[1]?.score).toBe(58.7);
  });

  it("rejects malformed scores instead of coercing them", async () => {
    const malformed = structuredClone(SNAPSHOT);
    malformed.signals[0].riskScore = 140;
    const fetchMock = vi.fn().mockResolvedValue(response(malformed));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Risk29Provider("https://risk29.example");
    await expect(provider.getRisk29Snapshot()).rejects.toThrow();
  });

  it("does not serve an expired snapshot after a refresh failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T02:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(SNAPSHOT))
      .mockResolvedValueOnce(response({ message: "down" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Risk29Provider("https://risk29.example");
    await provider.getRisk29Snapshot();
    vi.setSystemTime(new Date("2026-09-16T02:01:01Z"));

    await expect(provider.getRisk29Snapshot()).rejects.toThrow("503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit base URL in non-browser runtimes", async () => {
    const provider = new Risk29Provider();
    await expect(provider.getRisk29Snapshot()).rejects.toThrow(
      "a baseUrl is required outside the browser",
    );
  });
});
