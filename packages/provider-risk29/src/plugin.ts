import type { MarketDataProvider } from "@zframes/spec";
import { Risk29Provider } from "./index";
import { RISK29_MANIFEST } from "./manifest";

export const manifest = RISK29_MANIFEST;

export function createProviders(): MarketDataProvider[] {
  return [new Risk29Provider()];
}
