import { describe, expect, it } from "vitest";
import { allFrames } from "./index";
import { frameLoaders } from "./lazy";
import { frameMetas } from "./schemas";

const RISK29_FRAMES = [
  "risk29-categories",
  "risk29-changes",
  "risk29-heatmap",
  "risk29-history",
  "risk29-score",
] as const;

describe("Risk29 frame registry", () => {
  it("registers all five POC frames in metadata, eager and lazy surfaces", () => {
    const metaNames = new Set(frameMetas.map((frame) => frame.name));
    const eagerNames = new Set(allFrames.map((frame) => frame.name));
    const lazyNames = new Set(Object.keys(frameLoaders));

    for (const name of RISK29_FRAMES) {
      expect(metaNames.has(name), `${name} metadata`).toBe(true);
      expect(eagerNames.has(name), `${name} eager frame`).toBe(true);
      expect(lazyNames.has(name), `${name} lazy loader`).toBe(true);
    }
  });
});
