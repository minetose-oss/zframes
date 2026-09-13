import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThaibmaProvider as ThaibmaProviderType } from "./index";

// What this file pins, and why it matters:
//
//  1. **Tenor mapping.** `X` is a fractional number of YEARS off the real
//     maturity dates (0.0767 is a 28-day bill), so every label is rounded —
//     under a year to the nearest month, from a year to the nearest year. A
//     label read straight off `X` would title a 1-month bill "0.08Y".
//  2. **The density filter.** The publisher plots every integer year to 50; the
//     frame's 2s10s readout and maturity pills are built around a Treasury-like
//     ladder, so the 11Y/13Y/…/50Y points are dropped.
//  3. **Ordering.** Points come out shortest → longest by MONTHS, which is what
//     `YieldCurve.points` promises and what the curve path draws.
//  4. **Transport.** www.thaibma.or.th is CORS-walled, so the browser path goes
//     through the same-origin proxy while Node fetches the gov endpoint direct.
//
// `curveCache` is a module-level singleton with stale-on-error, so a value
// primed by an earlier test would mask every error path. Each test therefore
// gets a fresh module (and an empty cache) via `vi.resetModules()`.
type Ctor = typeof ThaibmaProviderType;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.ThaibmaProvider;
}

const GOV_CURVE_URL = "https://www.thaibma.or.th/yieldcurve/gov/";
const ASOF = "2026-09-11T00:00:00";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** One `Curve` row as the publisher emits it: years to maturity, percent yield. */
function point(x: number, y: number, asof = ASOF) {
  return { Asof: asof, X: x, Y: y };
}

/** The two-key document: the plotted curve plus the benchmark table beside it. */
function document(curve: ReturnType<typeof point>[]) {
  return {
    Curve: curve,
    Stat: [
      {
        Asof: ASOF,
        Symbol: "T-BILL1M",
        MaturityDate: null,
        Ttm: 0.076712328767123,
        Yield: 0.928,
        Change: 0.3554,
        Spread: 5.8559777777778,
        GroupOrder: 1,
        IsSynthetic: false,
        IsPlot: true,
        IsBenchmark: false,
      },
    ],
  };
}

function stubJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A realistic published curve: the three bills, then every integer year to 50. */
function fullCurve() {
  const rows = [
    point(0.076712328767123, 0.928),
    point(0.249315068493151, 0.960381),
    point(0.498630136986301, 0.980651),
  ];
  for (let year = 1; year <= 50; year++) rows.push(point(year, 1 + year / 20));
  return rows;
}

describe("ThaibmaProvider", () => {
  let ThaibmaProvider: Ctor;

  beforeEach(async () => {
    ThaibmaProvider = await loadProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("advertises its identity and capabilities", () => {
    const provider = new ThaibmaProvider();
    expect(provider.name).toBe("thaibma");
    expect(provider.capabilities).toEqual(["yield-curve"]);
  });

  describe("curve parsing", () => {
    it("labels sub-year points in months and year points in years", async () => {
      stubJson(
        document([
          point(0.076712328767123, 0.928),
          point(0.249315068493151, 0.96),
          point(0.498630136986301, 0.98),
          point(1, 1.0),
          point(10, 2.1),
        ]),
      );

      const curve = await new ThaibmaProvider().getYieldCurve();

      expect(curve.date).toBe("2026-09-11");
      expect(curve.points).toEqual([
        { label: "1M", months: 1, rate: 0.928 },
        { label: "3M", months: 3, rate: 0.96 },
        { label: "6M", months: 6, rate: 0.98 },
        { label: "1Y", months: 12, rate: 1.0 },
        { label: "10Y", months: 120, rate: 2.1 },
      ]);
    });

    it("keeps only the Treasury-like ladder out of all 53 published tenors", async () => {
      stubJson(document(fullCurve()));

      const curve = await new ThaibmaProvider().getYieldCurve();

      // The 18 kept tenors — note 11Y, 13Y, 14Y, 16Y…19Y, 21Y…50Y are gone.
      expect(curve.points.map((p) => p.label)).toEqual([
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
    });

    it("sorts by maturity even when the publisher emits them out of order", async () => {
      stubJson(
        document([
          point(30, 3.5),
          point(0.249315068493151, 0.96),
          point(10, 2.1),
          point(2, 1.1),
          point(0.076712328767123, 0.928),
        ]),
      );

      const curve = await new ThaibmaProvider().getYieldCurve();

      expect(curve.points.map((p) => p.months)).toEqual([1, 3, 24, 120, 360]);
      expect(curve.points.map((p) => p.label)).toEqual([
        "1M",
        "3M",
        "2Y",
        "10Y",
        "30Y",
      ]);
    });

    it("throws on an empty curve, and on one too thin to read a shape off", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(document([])))
        // Three kept tenors is under the four-point floor; the 11Y is dropped by
        // the density filter, so it cannot make up the count.
        .mockResolvedValueOnce(
          jsonResponse(
            document([
              point(1, 1),
              point(2, 1.1),
              point(11, 2.2),
              point(5, 1.4),
            ]),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const provider = new ThaibmaProvider();

      for (let i = 0; i < 2; i++) {
        await expect(provider.getYieldCurve()).rejects.toThrow(
          /thaibma: government curve returned too few tenors/,
        );
      }
      // A failure is never cached, so each call retried the load.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects a body whose shape has drifted", async () => {
      stubJson({ Curve: [{ Asof: ASOF, X: "0.5", Y: 1 }] });

      await expect(new ThaibmaProvider().getYieldCurve()).rejects.toThrow();
    });
  });

  describe("transport", () => {
    it("fetches the gov endpoint direct in Node (proxying is a no-op there)", async () => {
      const fetchMock = stubJson(document(fullCurve()));

      await new ThaibmaProvider().getYieldCurve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(GOV_CURVE_URL);
    });

    it("routes through the same-origin proxy in the browser", async () => {
      // Simulate a browser so the shared transport takes its proxy-rewrite
      // branch — www.thaibma.or.th sends no CORS headers.
      vi.stubGlobal("document", {});
      const fetchMock = stubJson(document(fullCurve()));

      await new ThaibmaProvider().getYieldCurve();

      expect(fetchMock.mock.calls[0][0]).toBe(
        `/__zframes/proxy?url=${encodeURIComponent(GOV_CURVE_URL)}`,
      );
    });
  });

  describe("caching", () => {
    it("serves the single 'latest' slot to a second instance without re-fetching", async () => {
      const fetchMock = stubJson(document(fullCurve()));

      const first = await new ThaibmaProvider().getYieldCurve();
      const second = await new ThaibmaProvider().getYieldCurve();

      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("serves the last good curve when a later fetch fails", async () => {
      vi.useFakeTimers();
      const fetchMock = stubJson(document(fullCurve()));
      const provider = new ThaibmaProvider();
      const good = await provider.getYieldCurve();

      vi.advanceTimersByTime(7 * 60 * 60_000);
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));

      expect(await provider.getYieldCurve()).toEqual(good);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
