import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviders } from "./plugin";

const NOW = "2026-09-16T10:00:00.000Z";

const snapshot = {
  schemaVersion: "1",
  modelVersion: "risk29-p1-engine-0.1.0",
  thresholdVersion: "risk29-p1-provisional-v1",
  generatedAt: NOW,
  score: 30,
  state: "normal",
  regime: "neutral",
  categories: [
    { id: "macro", label: "Macro", weight: 18, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "credit", label: "Credit", weight: 14, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "valuation", label: "Valuation", weight: 12, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "sentiment", label: "Sentiment", weight: 16, score: 30, state: "normal", availableSignals: 1, totalSignals: 1 },
    { id: "qualitative", label: "Qualitative", weight: 6, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "liquidity", label: "Liquidity", weight: 14, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "global", label: "Global", weight: 10, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
    { id: "technical", label: "Technical", weight: 10, score: null, state: "unavailable", availableSignals: 0, totalSignals: 0 },
  ],
  signals: [
    {
      id: "vix",
      label: "VIX",
      category: "sentiment",
      source: "FRED",
      sourceSeries: "VIXCLS",
      value: 16,
      unit: "index",
      riskScore: 30,
      state: "normal",
      direction: "flat",
      change: 0,
      changeWindow: "1d",
      asOf: "2026-09-16",
      fetchedAt: NOW,
      ageSeconds: 0,
      freshness: "fresh",
      thresholdVersion: "risk29-p1-provisional-v1",
    },
  ],
  changes: [],
  health: { available: 1, stale: 0, errored: 0, total: 1 },
};

afterEach(() => {
  delete (globalThis as typeof globalThis & { __RISK29_BASE_URL__?: string })
    .__RISK29_BASE_URL__;
  vi.unstubAllGlobals();
});

describe("Risk29 plugin", () => {
  it("uses __RISK29_BASE_URL__ for split live-engine deployments", async () => {
    (globalThis as typeof globalThis & { __RISK29_BASE_URL__?: string })
      .__RISK29_BASE_URL__ = "https://risk29.example/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [provider] = createProviders();
    const result = await provider.getRisk29Snapshot?.();

    expect(result?.score).toBe(30);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://risk29.example/risk29/latest.json",
    );
  });
});
