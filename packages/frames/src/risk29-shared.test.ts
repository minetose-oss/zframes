import { describe, expect, it } from "vitest";
import {
  formatRisk29Value,
  risk29DirectionLabel,
  risk29StateLabel,
} from "./risk29-shared";

describe("Risk29 presentation helpers", () => {
  it("prints unavailable state explicitly instead of implying low risk", () => {
    expect(risk29StateLabel("unavailable")).toBe("NO DATA");
  });

  it("keeps direction meaning explicit", () => {
    expect(risk29DirectionLabel("improving")).toBe("↓ improving");
    expect(risk29DirectionLabel("worsening")).toBe("↑ worsening");
    expect(risk29DirectionLabel("flat")).toBe("→ flat");
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
