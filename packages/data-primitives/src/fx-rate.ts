/**
 * USD conversion for providers that publish in a local currency.
 *
 * Every capability in this codebase is denominated in USD, so a provider on a
 * non-USD source divides by a reference rate on the way out — which makes that
 * one number a single point of failure for everything it emits. This walks an
 * ordered chain of four keyless, CORS-open sources and sanity-checks the result
 * before trusting it, so one upstream outage degrades to the next source rather
 * than to a board of error cards.
 *
 * React-free on purpose (deep export `@zframes/data-primitives/fx-rate`), like
 * its `fetch` and `cache` neighbours.
 */
import { TtlCache } from "./cache";
import { fetchJson } from "./fetch";

/** ECB reference rates, keyless — the same source @zframes/provider-fx uses. */
const frankfurterUrl = (code: string) =>
  `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${code}`;
/** Intraday commercial rates, keyless but rate-limited (~61 requests/window). */
const fxRatesApiUrl = (code: string) =>
  `https://api.fxratesapi.com/latest?base=USD&currencies=${code}`;
/**
 * CC0, no rate limits, USD-based. The pages.dev origin, NOT the jsDelivr mirror
 * of the same dataset — the CDN copy was observed a full day behind.
 */
const CURRENCY_API_URL =
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json";
/**
 * The ECB's own data portal, which publishes everything against EUR — so a
 * USD/x rate needs two series and a cross. Last resort for that reason.
 */
const ecbUrl = (code: string) =>
  `https://data-api.ecb.europa.eu/service/data/EXR/D.${code}.EUR.SP00.A?format=jsondata&lastNObservations=2`;

/**
 * Plausibility bands, units of the code per 1 USD. Every price a caller emits
 * is divided by this number, so a wrong-but-finite rate silently corrupts the
 * whole board — worse than no data at all. A band is deliberately far wider
 * than the currency ever trades but tight enough to catch every way a source
 * can hand back the wrong number: an inverted quote (USD per unit), a
 * EUR/USD-shaped cross that skipped the currency's leg (~1.15), or a decimal
 * slip. Anything outside falls through to the next source.
 *
 * The baht spent the 1990s near 25 and spiked to ~56 in the 1997 crisis; it has
 * been 30–38 for years. A code with no band here is only checked for being
 * finite and positive.
 */
const PLAUSIBLE_BANDS: Record<string, [number, number]> = {
  THB: [10, 100],
};

/**
 * Frankfurter and FXRatesAPI happen to agree on shape: `{rates:{THB:number}}`
 * with an upper-case currency key. (FXRatesAPI adds `success`/`timestamp`, which
 * we ignore — a bad rate is caught by the plausibility band, not a flag.)
 */
interface RatesMapResponse {
  rates?: Record<string, number>;
}

/** currency-api keys by *lower-case* code, base first: `{usd:{thb:number}}`. */
interface CurrencyApiResponse {
  usd?: Record<string, number>;
}

/**
 * SDMX-JSON, as served by the ECB data portal. Observations live under a
 * positional series key (one series per request here, so always "0:0:0:0:0") and
 * are keyed by *observation index* as a string, value-first in a tuple.
 */
interface SdmxResponse {
  dataSets?: {
    series?: Record<string, { observations?: Record<string, unknown[]> }>;
  }[];
}

/** Units of a currency per 1 USD, or 0 when the source can't supply a usable number. */
interface FxSource {
  /** Names the source in the all-sources-failed error, so a dead link is findable. */
  name: string;
  load(code: string): Promise<number>;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Latest observation of a single-series SDMX response. The observation keys are
 * stringified indices ("0", "1", …) in publication order, so the newest print is
 * the highest key — not the first one the object happens to enumerate.
 */
function latestSdmxObservation(body: SdmxResponse | undefined): number {
  const series = body?.dataSets?.[0]?.series ?? {};
  const observations = Object.values(series)[0]?.observations ?? {};
  let bestIndex = -1;
  let bestValue = 0;
  for (const [index, tuple] of Object.entries(observations)) {
    const i = Number(index);
    const value = num(Array.isArray(tuple) ? tuple[0] : undefined);
    if (!Number.isFinite(i) || value <= 0 || i <= bestIndex) continue;
    bestIndex = i;
    bestValue = value;
  }
  return bestValue;
}

/**
 * Sources in preference order. Frankfurter stays first (it is what the Bitkub
 * provider always used, so the healthy path is unchanged); the rest exist
 * because a single upstream outage otherwise killed every card on that venue.
 *
 * A source that throws — including a 429, which `fetchJson` surfaces as a
 * non-2xx error — simply hands over to the next one; nothing retries, so a
 * rate-limited source is asked once per TTL and never hammered.
 */
const FX_SOURCES: readonly FxSource[] = [
  {
    name: "frankfurter",
    load: async (code) =>
      num(
        (await fetchJson<RatesMapResponse>(frankfurterUrl(code)))?.rates?.[
          code
        ],
      ),
  },
  {
    name: "fxratesapi",
    load: async (code) =>
      num(
        (await fetchJson<RatesMapResponse>(fxRatesApiUrl(code)))?.rates?.[code],
      ),
  },
  {
    name: "currency-api",
    load: async (code) =>
      num(
        (await fetchJson<CurrencyApiResponse>(CURRENCY_API_URL))?.usd?.[
          code.toLowerCase()
        ],
      ),
  },
  {
    name: "ecb-cross",
    load: async (code) => {
      // EUR-based series, so USD/x = (x per EUR) ÷ (USD per EUR).
      const [perEur, usdPerEur] = await Promise.all([
        fetchJson<SdmxResponse>(ecbUrl(code)).then(latestSdmxObservation),
        fetchJson<SdmxResponse>(ecbUrl("USD")).then(latestSdmxObservation),
      ]);
      if (usdPerEur <= 0) return 0;
      return perEur / usdPerEur;
    },
  },
];

/** Reject anything that would silently misprice a board (see {@link PLAUSIBLE_BANDS}). */
function plausibleRate(code: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const band = PLAUSIBLE_BANDS[code];
  return !band || (rate >= band[0] && rate <= band[1]);
}

/**
 * The one cache behind {@link usdRate}. Reference rates are published daily
 * (only the FXRatesAPI fallback is intraday), so an hour-long TTL is already
 * finer than the sources' resolution. Persisted for two reasons: it survives a
 * reload, which keeps the very first paint after startup denominated correctly,
 * and it gives stale-on-error something to fall back on if the whole chain is
 * down.
 */
export const usdRateCache = new TtlCache<number>({
  namespace: "zframes:fx-rate",
  ttlMs: 60 * 60_000,
  persist: true,
});

/**
 * Units of `code` per 1 USD, from the first source in {@link FX_SOURCES} that
 * answers a plausible number.
 *
 * Only when every source has failed (or answered something implausible) does
 * this throw — and even then the cache's stale-on-error serves the last good
 * rate if there is one, so a board that has ever resolved a rate degrades to a
 * slightly stale one rather than to error cards. That mirrors how the core
 * currency layer degrades: a marginally old rate beats a dead card.
 */
export async function usdRate(code: string): Promise<number> {
  const upper = code.toUpperCase();
  return usdRateCache.get(`USD:${upper}`, async () => {
    const failures: string[] = [];
    for (const source of FX_SOURCES) {
      try {
        const rate = await source.load(upper);
        if (plausibleRate(upper, rate)) return rate;
        failures.push(`${source.name} implausible (${rate})`);
      } catch (error) {
        failures.push(
          `${source.name} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(`fx-rate: no USD/${upper} rate — ${failures.join("; ")}`);
  });
}
