import { describe, expect, it } from "vitest";
import {
  RISK29_CATEGORY_IDS,
  Risk29HistorySchema,
  Risk29SnapshotSchema,
  type Risk29Category,
  type Risk29Snapshot,
} from "./risk29";

const NOW = "2026-09-16T02:00:00.000Z";

function category(
  id: (typeof RISK29_CATEGORY_IDS)[number],
): Risk29Category {
  const available = id === "sentiment";
  return {
    id,
    label: id,
    weight: 1,
    score: available ? 50 : null,
    state: available ? "watch" : "unavailable",
    availableSignals: available ? 1 : 0,
    totalSignals: available ? 1 : 0,
  };
}

function validSnapshot(): Risk29Snapshot {
  return {
    schemaVersion: "1",
    modelVersion: "test-model",
    thresholdVersion: "test-threshold-v1",
    generatedAt: NOW,
    score: 50,
    state: "watch",
    regime: "neutral",
    categories: RISK29_CATEGORY_IDS.map(category),
    signals: [
      {
        id: "vix",
        label: "VIX",
        category: "sentiment",
        source: "FRED",
        sourceSeries: "VIXCLS",
        value: 20,
        unit: "index",
        riskScore: 50,
        state: "watch",
        direction: "flat",
        change: 0,
        changeWindow: "1d",
        asOf: "2026-09-15",
        fetchedAt: NOW,
        ageSeconds: 300,
        freshness: "fresh",
        thresholdVersion: "test-threshold-v1",
      },
    ],
    changes: [],
    health: { available: 1, stale: 0, errored: 0, total: 1 },
  };
}

describe("Risk29SnapshotSchema hardening", () => {
  it("accepts a coherent snapshot", () => {
    expect(Risk29SnapshotSchema.parse(validSnapshot()).score).toBe(50);
  });

  it("rejects duplicate/missing category ids", () => {
    const snapshot = validSnapshot();
    snapshot.categories[7] = { ...snapshot.categories[0] };
    expect(() => Risk29SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("rejects health counters that disagree with signal data", () => {
    const snapshot = validSnapshot();
    snapshot.health.available = 0;
    expect(() => Risk29SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("rejects a signal threshold version that differs from the snapshot", () => {
    const snapshot = validSnapshot();
    snapshot.signals[0].thresholdVersion = "different-threshold";
    expect(() => Risk29SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("rejects changes that reference a signal not present in the snapshot", () => {
    const snapshot = validSnapshot();
    snapshot.changes.push({
      signalId: "missing",
      label: "Missing signal",
      fromState: "normal",
      toState: "watch",
      scoreDelta: 5,
      summary: "test",
    });
    expect(() => Risk29SnapshotSchema.parse(snapshot)).toThrow();
  });

  it("requires unavailable signals to carry null value and score", () => {
    const snapshot = validSnapshot();
    snapshot.signals[0] = {
      ...snapshot.signals[0],
      state: "unavailable",
      value: 20,
      riskScore: 50,
    };
    snapshot.health.available = 0;
    expect(() => Risk29SnapshotSchema.parse(snapshot)).toThrow();
  });
});

describe("Risk29HistorySchema hardening", () => {
  it("rejects non-monotonic history", () => {
    const history = {
      schemaVersion: "1",
      generatedAt: NOW,
      points: [
        { time: 2, score: 50, state: "watch", categoryScores: {} },
        { time: 1, score: 49, state: "watch", categoryScores: {} },
      ],
    };
    expect(() => Risk29HistorySchema.parse(history)).toThrow();
  });
});
