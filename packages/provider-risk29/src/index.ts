import type { Capability, MarketDataProvider } from "@zframes/spec";
import {
  RISK29_CAPABILITIES,
  Risk29HistorySchema,
  Risk29SnapshotSchema,
  type Risk29History,
  type Risk29Snapshot,
} from "@zframes/spec/risk29";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchJson } from "@zframes/data-primitives/fetch";

const SNAPSHOT_TTL_MS = 60_000;
const HISTORY_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Risk29 consumes an intelligence service; it does not calculate investment
 * signals itself. The default endpoint is same-origin so the zframes runtime
 * can be fronted by the same deployment as the Risk29 API. Tests / standalone
 * callers can pass an absolute `baseUrl`.
 */
export class Risk29Provider {
  readonly name = "risk29";

  // Capability is still a closed union in upstream zframes. The POC contract
  // lives behind @zframes/spec/risk29 until we prove it; this one cast is the
  // temporary bridge. Phase 0B promotes the two strings into the shared union.
  readonly capabilities = RISK29_CAPABILITIES as unknown as readonly Capability[];

  private readonly baseUrl: string;
  private readonly snapshotCache = new TtlCache<Risk29Snapshot>({
    namespace: "zframes:risk29:snapshot",
    ttlMs: SNAPSHOT_TTL_MS,
    // A prior snapshot can claim `fresh`; serving it after a failed refresh
    // would freeze that claim. Fail instead and let the frame show an error.
    staleOnError: false,
  });
  private readonly historyCache = new TtlCache<Risk29History>({
    namespace: "zframes:risk29:history",
    ttlMs: HISTORY_TTL_MS,
    staleOnError: false,
  });

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getRisk29Snapshot(): Promise<Risk29Snapshot> {
    return this.snapshotCache.get("latest", () =>
      fetchJson(this.url("/risk29/latest.json"), Risk29SnapshotSchema, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    );
  }

  async getRisk29History(): Promise<Risk29History> {
    return this.historyCache.get("history", () =>
      fetchJson(this.url("/risk29/history.json"), Risk29HistorySchema, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    );
  }

  private url(path: string): string {
    if (this.baseUrl) return `${this.baseUrl}${path}`;
    if (typeof document !== "undefined") return path;
    throw new Error(
      "risk29: a baseUrl is required outside the browser (e.g. http://127.0.0.1:8000)",
    );
  }
}

// Compile-time shape check for the provider methods while the POC capability
// strings remain isolated from the global Capability union.
const _providerShape: Pick<
  MarketDataProvider,
  "name" | "capabilities" | "getRisk29Snapshot" | "getRisk29History"
> = new Risk29Provider("https://risk29.invalid");
void _providerShape;
