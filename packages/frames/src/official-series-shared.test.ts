import { describe, expect, it } from "vitest";
import { formatSeriesValue, withUnitLabel } from "./official-series-shared";

// A per-quantity label is punctuation in one case and a word in the other: "/t"
// reads as part of the figure ("$464/t") while "¢/lb" is its own token and needs
// the space ("14.81 ¢/lb"). Getting it backwards produces "$464 /t", which reads
// as a typo, or "14.81¢/lb", which reads as a single mangled unit.
describe("withUnitLabel", () => {
  it("attaches a '/'-leading label directly to the value", () => {
    expect(withUnitLabel("$464.00", "/t")).toBe("$464.00/t");
    expect(withUnitLabel("$18.20", "/kg")).toBe("$18.20/kg");
  });

  it("separates any other label with a space", () => {
    expect(withUnitLabel("14.81", "¢/lb")).toBe("14.81 ¢/lb");
    expect(withUnitLabel("312.40", "¢/kg")).toBe("312.40 ¢/kg");
  });

  it("leaves the value untouched when there is no label", () => {
    expect(withUnitLabel("128.40")).toBe("128.40");
    expect(withUnitLabel("128.40", "")).toBe("128.40");
  });
});

describe("formatSeriesValue", () => {
  it("appends the label to a level", () => {
    expect(formatSeriesValue(14.81, "index", "¢/lb")).toBe("14.81 ¢/lb");
    expect(formatSeriesValue(1106.47, "usd", "/t")).toBe("1,106.47/t");
  });

  it("formats an unlabelled series exactly as before", () => {
    expect(formatSeriesValue(332.568, "index")).toBe("332.57");
    expect(formatSeriesValue(2.43, "percent")).toBe(
      formatSeriesValue(2.43, "percent", "¢/lb"),
    );
  });
});
