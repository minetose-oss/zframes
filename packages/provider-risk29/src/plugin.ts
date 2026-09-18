import type { MarketDataProvider } from "@zframes/spec";
import { Risk29Provider } from "./index";
import { RISK29_MANIFEST } from "./manifest";

export const manifest = RISK29_MANIFEST;

function configuredBaseUrl(): string {
  if (typeof globalThis === "undefined") return "";
  const value = (
    globalThis as typeof globalThis & { __RISK29_BASE_URL__?: unknown }
  ).__RISK29_BASE_URL__;
  return typeof value === "string" ? value.trim() : "";
}

export function createProviders(): MarketDataProvider[] {
  return [new Risk29Provider(configuredBaseUrl())];
}
