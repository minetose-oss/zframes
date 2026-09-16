import { useEffect, useState } from "react";
import type { Capability } from "@zframes/spec/types";
import type { Risk29History, Risk29Snapshot } from "@zframes/spec/risk29";
import { useProviderFor } from "./hooks";

interface Risk29HookState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Small POC poller kept separate from the generic hook engine until Risk29's
 * two capabilities are promoted into the shared Capability union. The provider
 * itself owns request de-duplication and TTL caching; this hook owns React
 * lifecycle, retry cadence and a visible error state.
 */
function useRisk29Polled<T>(
  load: (() => Promise<T>) | null,
  refreshMs: number,
  deps: readonly unknown[],
): Risk29HookState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!load) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loadFn = load;

    const tick = async () => {
      try {
        const next = await loadFn();
        if (cancelled) return;
        setData(next);
        setError(null);
        setIsLoading(false);
        timer = setTimeout(tick, refreshMs);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setIsLoading(false);
        // Retry faster than the normal cadence but never hammer the service.
        timer = setTimeout(tick, Math.min(refreshMs, 60_000));
      }
    };

    setIsLoading(true);
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Callers pass the stable dependencies the loader closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, isLoading, error };
}

/** Latest Risk29 score/state/regime snapshot. Default refresh matches its 60s provider TTL. */
export function useRisk29Snapshot(refreshMs = 60_000): {
  snapshot: Risk29Snapshot | null;
  isLoading: boolean;
  error: Error | null;
} {
  // POC bridge: keep the product-specific literals isolated until the visible
  // Phase 0C card has been validated end-to-end. Promotion into Capability is
  // the cleanup step after the POC contract is proven, not a prerequisite for
  // rendering it.
  const provider = useProviderFor("risk29-snapshot" as Capability, "risk29");
  const {
    data: snapshot,
    isLoading,
    error,
  } = useRisk29Polled<Risk29Snapshot>(
    provider?.getRisk29Snapshot ? () => provider.getRisk29Snapshot!() : null,
    refreshMs,
    [provider, refreshMs],
  );
  return { snapshot, isLoading, error };
}

/** Risk29 score/category history. Default refresh matches its 5-minute provider TTL. */
export function useRisk29History(refreshMs = 5 * 60_000): {
  history: Risk29History | null;
  isLoading: boolean;
  error: Error | null;
} {
  const provider = useProviderFor("risk29-history" as Capability, "risk29");
  const {
    data: history,
    isLoading,
    error,
  } = useRisk29Polled<Risk29History>(
    provider?.getRisk29History ? () => provider.getRisk29History!() : null,
    refreshMs,
    [provider, refreshMs],
  );
  return { history, isLoading, error };
}
