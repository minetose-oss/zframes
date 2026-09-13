import type {
  Capability,
  MarketDataProvider,
  YieldCurve,
  YieldPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { fetchJson } from "@zframes/data-primitives/fetch";
import { z } from "zod";

/**
 * Keyless provider for the Thai Bond Market Association's government bond yield
 * curve — the Thai counterpart to provider-treasury's US par curve, and the
 * reason `yield-curve` now takes a `source` pin: routing is first-match, so a
 * card asking for the Thai curve has to name this provider.
 *
 * `www.thaibma.or.th` sends no `Access-Control-Allow-Origin`, so the browser
 * path goes through the runtime's same-origin proxy (the host is on the fleet
 * manifest's allowlist) and Node fetches direct; on a static host with no
 * runtime the card degrades to empty like every other proxied provider.
 */

const GOV_CURVE_URL = "https://www.thaibma.or.th/yieldcurve/gov/";

/**
 * The published document (verified live). `Curve` is the plotted curve — `X` is
 * years to maturity and `Y` the yield in percent — and `Stat` is the benchmark
 * bond table beside it, which carries the same yields keyed by symbol and is
 * not read here.
 */
const CurveResponseSchema = z.object({
  Curve: z.array(
    z.object({
      Asof: z.string(),
      X: z.number(),
      Y: z.number(),
    }),
  ),
});

/**
 * Tenors kept on the curve. The publisher plots every integer year out to 50,
 * which renders as a wall of points; this is the Treasury-like density the
 * frame's maturity pills and 2s10s readout are built around.
 */
const KEPT_TENORS = new Set([
  "1M",
  "3M",
  "6M",
  "1Y",
  "2Y",
  "3Y",
  "4Y",
  "5Y",
  "6Y",
  "7Y",
  "8Y",
  "9Y",
  "10Y",
  "12Y",
  "15Y",
  "20Y",
  "25Y",
  "30Y",
]);

/** Just under the capability hook's 6h poll, so background refreshes still land. */
const CACHE_TTL_MS = 6 * 60 * 60_000;

const curveCache = new TtlCache<YieldCurve>({
  namespace: "zframes:thaibma:yield-curve",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

/**
 * `X` is a fractional number of years measured off the actual maturity dates
 * (a one-month bill is 0.0767 = 28/365), so the label is rounded rather than
 * read: under a year to the nearest month, from a year to the nearest year.
 */
function tenorOf(x: number): { label: string; months: number } | null {
  if (!Number.isFinite(x) || x <= 0) return null;
  if (x < 1) {
    const months = Math.round(x * 12);
    return months >= 1 ? { label: `${months}M`, months } : null;
  }
  const years = Math.round(x);
  return { label: `${years}Y`, months: years * 12 };
}

type CurveResponse = z.infer<typeof CurveResponseSchema>;

export function toYieldCurve({ Curve }: CurveResponse): YieldCurve {
  const points: YieldPoint[] = [];
  const seen = new Set<string>();
  let date = "";
  for (const row of Curve) {
    const tenor = tenorOf(row.X);
    if (!tenor || !KEPT_TENORS.has(tenor.label)) continue;
    if (!Number.isFinite(row.Y) || seen.has(tenor.label)) continue;
    seen.add(tenor.label);
    points.push({ label: tenor.label, months: tenor.months, rate: row.Y });
    if (date === "") date = row.Asof.slice(0, 10);
  }
  points.sort((a, b) => a.months - b.months);
  // A handful of points is not a curve — the 2s10s spread and the shape both
  // need the short and long ends, so a partial publish fails loudly.
  if (points.length < 4)
    throw new Error("thaibma: government curve returned too few tenors");
  return { date, points };
}

export class ThaibmaProvider implements MarketDataProvider {
  readonly name = "thaibma";
  readonly capabilities: readonly Capability[] = ["yield-curve"];

  async getYieldCurve(): Promise<YieldCurve> {
    return curveCache.get("latest", () =>
      fetchJson(GOV_CURVE_URL, CurveResponseSchema, {
        proxied: true,
        timeoutMs: 15_000,
      }).then(toYieldCurve),
    );
  }
}
