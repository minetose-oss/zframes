import { describe, expect, it } from "vitest";
import type { Risk29HistoryPoint, Risk29Snapshot } from "@zframes/spec/risk29";
import {
  formatRisk29Value,
  risk29DirectionLabel,
  risk29DecisionBrief,
  risk29MaterialStatus,
  risk29PortfolioActionMap,
  risk29StateLabel,
  risk29TopDrivers,
} from "./risk29-shared";

describe("Risk29 presentation helpers", () => {
  it("prints unavailable state explicitly instead of implying low risk", () => {
    expect(risk29StateLabel("unavailable")).toBe("NO DATA");
  });

  it("keeps direction meaning explicit", () => {
    expect(risk29DirectionLabel("improving")).toBe("↓ improving");
    expect(risk29DirectionLabel("worsening")).toBe("↑ worsening");
    expect(risk29DirectionLabel("flat")).toBe("→ flat");
    expect(risk29DirectionLabel(null)).toBe("—");
  });

  it("does not turn a missing numeric value into zero", () => {
    expect(formatRisk29Value(null, "percent")).toBe("—");
  });

  it("formats the POC units without changing their meaning", () => {
    expect(formatRisk29Value(3.42, "percent")).toBe("3.42%");
    expect(formatRisk29Value(0.41, "pct-points")).toBe("0.41 pp");
    expect(formatRisk29Value(3680, "usd/oz")).toBe("$3,680/oz");
  });
});

const baseSnapshot = {
  schemaVersion: "1",
  modelVersion: "test",
  thresholdVersion: "test",
  generatedAt: "2026-10-13T03:00:00+00:00",
  score: 40,
  state: "watch",
  regime: "watch",
  categories: [
    {
      id: "macro",
      label: "Macro",
      weight: 60,
      score: 50,
      state: "watch",
      availableSignals: 2,
      totalSignals: 2,
    },
    {
      id: "credit",
      label: "Credit",
      weight: 40,
      score: 25,
      state: "normal",
      availableSignals: 1,
      totalSignals: 1,
    },
  ],
  signals: [
    {
      id: "macro-a",
      label: "Macro A",
      category: "macro",
      source: "test",
      value: 1,
      unit: "index",
      riskScore: 80,
      state: "warning",
      asOf: "2026-10-13",
      fetchedAt: "2026-10-13T03:00:00+00:00",
      ageSeconds: 0,
      freshness: "fresh",
      thresholdVersion: "test",
    },
    {
      id: "macro-b",
      label: "Macro B",
      category: "macro",
      source: "test",
      value: 1,
      unit: "index",
      riskScore: 20,
      state: "normal",
      asOf: "2026-10-13",
      fetchedAt: "2026-10-13T03:00:00+00:00",
      ageSeconds: 0,
      freshness: "fresh",
      thresholdVersion: "test",
    },
    {
      id: "credit-a",
      label: "Credit A",
      category: "credit",
      source: "test",
      value: 1,
      unit: "index",
      riskScore: 25,
      state: "normal",
      asOf: "2026-10-13",
      fetchedAt: "2026-10-13T03:00:00+00:00",
      ageSeconds: 0,
      freshness: "fresh",
      thresholdVersion: "test",
    },
  ],
  changes: [],
  health: { available: 3, stale: 0, errored: 0, total: 3 },
} as unknown as Risk29Snapshot;

describe("Risk29 productivity helpers", () => {
  it("ranks drivers by weighted contribution, not raw score alone", () => {
    const drivers = risk29TopDrivers(baseSnapshot, 3);
    expect(drivers.map((driver) => driver.signal.id)).toEqual([
      "macro-a",
      "credit-a",
      "macro-b",
    ]);
    expect(drivers[0].contribution).toBeCloseTo(24);
    expect(drivers[1].contribution).toBeCloseTo(10);
  });

  it("flags aggregate or category movement of five points as material", () => {
    const previous = {
      time: Date.parse("2026-10-12T03:00:00+00:00"),
      score: 34,
      state: "watch",
      categoryScores: {
        macro: 43,
        credit: 25,
      },
    } as Risk29HistoryPoint;

    const material = risk29MaterialStatus(baseSnapshot, previous);
    expect(material.isMaterial).toBe(true);
    expect(material.overallDelta).toBe(6);
    expect(material.categoryMoves[0]).toMatchObject({
      id: "macro",
      delta: 7,
    });
  });

  it("treats stale or errored data as material even without score movement", () => {
    const snapshot = {
      ...baseSnapshot,
      health: { ...baseSnapshot.health, stale: 1 },
    } as Risk29Snapshot;
    const previous = {
      time: Date.parse("2026-10-12T03:00:00+00:00"),
      score: 40,
      state: "watch",
      categoryScores: { macro: 50, credit: 25 },
    } as Risk29HistoryPoint;

    expect(risk29MaterialStatus(snapshot, previous)).toMatchObject({
      isMaterial: true,
      dataIssues: 1,
    });
  });
});

describe("Risk29 fail-closed productivity", () => {
  it("marks an unavailable overall score as review required", () => {
    const snapshot = {
      ...baseSnapshot,
      score: null,
      state: "unavailable",
    } as Risk29Snapshot;
    expect(risk29MaterialStatus(snapshot).isMaterial).toBe(true);
  });

  it("counts an unavailable signal even without an error flag", () => {
    const snapshot = {
      ...baseSnapshot,
      signals: [
        ...baseSnapshot.signals.slice(0, 2),
        {
          ...baseSnapshot.signals[2],
          state: "unavailable",
          value: null,
          riskScore: null,
          freshness: "stale",
        },
      ],
      health: { available: 2, stale: 1, errored: 0, total: 3 },
    } as Risk29Snapshot;
    const status = risk29MaterialStatus(snapshot);
    expect(status.isMaterial).toBe(true);
    expect(status.dataIssues).toBeGreaterThan(0);
  });
});


describe("Risk29 Phase 3.2 productivity", () => {
  it("maps WATCH to a selective daily decision posture", () => {
    const brief = risk29DecisionBrief(baseSnapshot);
    expect(brief.posture).toBe("SELECTIVE");
    expect(brief.headline).toContain("WATCH");
    expect(brief.today).toContain("selective");
  });

  it("fails the daily brief closed when the aggregate is unavailable", () => {
    const snapshot = {
      ...baseSnapshot,
      score: null,
      state: "unavailable",
    } as Risk29Snapshot;
    const brief = risk29DecisionBrief(snapshot);
    expect(brief.posture).toBe("REVIEW DATA");
    expect(brief.confidence).toBe("degraded");
  });

  it("maps WATCH to a five-bucket portfolio action overlay", () => {
    const items = risk29PortfolioActionMap(baseSnapshot);
    expect(items).toHaveLength(5);
    expect(items.find((item) => item.bucket === "High beta / thematic")?.bias).toBe(
      "SELECTIVE",
    );
    expect(items.find((item) => item.bucket === "Cash / short duration")?.bias).toBe(
      "RAISE",
    );
  });
});
