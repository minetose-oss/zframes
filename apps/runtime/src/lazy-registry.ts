// The lazy registry was promoted into @zframes/frames so other hosts (the
// explorer) can share it. The Risk29 POC overlays its product-specific frames
// here so the experiment stays isolated from the upstream built-in registry
// until the contract is promoted after Phase 0.
import {
  createLazyRegistry as createBaseLazyRegistry,
  prefetchFrames,
} from "@zframes/frames/lazy-registry";
import {
  risk29CategoriesFrame,
  risk29ChangesFrame,
  risk29HeatmapFrame,
  risk29HistoryFrame,
  risk29ScoreFrame,
} from "@zframes/frames/risk29-poc";
import type { FrameRegistry } from "@zframes/core";

const RISK29_POC_FRAMES = [
  risk29ScoreFrame,
  risk29CategoriesFrame,
  risk29ChangesFrame,
  risk29HeatmapFrame,
  risk29HistoryFrame,
];

export function createLazyRegistry(): FrameRegistry {
  const registry = createBaseLazyRegistry();
  for (const frame of RISK29_POC_FRAMES) registry.set(frame.name, frame);
  return registry;
}

export { prefetchFrames };
