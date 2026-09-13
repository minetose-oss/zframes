import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldBankProvider as WorldBankProviderType } from "./index";

// What this file pins, and why it matters:
//
//  1. **Unit from the indicator's own suffix.** `.ZG`/`.ZS` are already percent,
//     `.CD` is current US dollars, and `.CN` is current LOCAL currency — which
//     is why it maps to `index`, not `usd`: a frame rendering baht behind a
//     dollar sign states a number that is wrong by a factor of ~33.
//  2. **Null values are dropped, not zeroed.** A year a country did not report
//     arrives as `value: null`; charted as 0 it would draw a collapse to nothing
//     in the middle of an otherwise healthy series.
//  3. **Ordering.** The API answers newest-first and `OfficialSeries.points`
//     promises oldest → newest.
//  4. **Annual stamping.** A yearly figure describes the whole year, so it sits
//     at 31 December — at 1 January, 2025's GDP would plot before 2025 happened.
type Ctor = typeof WorldBankProviderType;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.WorldBankProvider;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function stubJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const META = {
  page: 1,
  pages: 1,
  per_page: 100,
  total: 60,
  sourceid: "2",
  lastupdated: "2026-07-13",
};

/** One published row, exactly as the API shapes it. */
function row(
  indicatorId: string,
  indicatorName: string,
  date: string,
  value: number | null,
) {
  return {
    indicator: { id: indicatorId, value: indicatorName },
    country: { id: "TH", value: "Thailand" },
    countryiso3code: "THA",
    date,
    value,
    unit: "",
    obs_status: "",
    decimal: 0,
  };
}

/** The `[metadata, rows]` envelope, newest row first as published. */
function body(rows: unknown[] | null) {
  return [META, rows];
}

describe("WorldBankProvider", () => {
  let WorldBankProvider: Ctor;

  beforeEach(async () => {
    WorldBankProvider = await loadProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("advertises its identity and capabilities", () => {
    const provider = new WorldBankProvider();
    expect(provider.name).toBe("worldbank");
    expect(provider.capabilities).toEqual(["macro-reference-series"]);
  });

  it("requests the indicator/country pair keyless and unproxied", async () => {
    const fetchMock = stubJson(
      body([
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", 577_009_981_112),
      ]),
    );
    // Simulate a browser: api.worldbank.org answers `*`, so there is no hop.
    vi.stubGlobal("document", {});

    await new WorldBankProvider().getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.worldbank.org/v2/country/THA/indicator/NY.GDP.MKTP.CD?format=json&mrv=60&per_page=100",
    );
  });

  it("reverses the published order and stamps each year at 31 December", async () => {
    stubJson(
      body([
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", 577_009_981_112),
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2024", 529_385_520_941),
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2023", 514_000_000_000),
      ]),
    );

    const series = await new WorldBankProvider().getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );

    expect(series.points).toEqual([
      { time: Date.UTC(2023, 11, 31), value: 514_000_000_000 },
      { time: Date.UTC(2024, 11, 31), value: 529_385_520_941 },
      { time: Date.UTC(2025, 11, 31), value: 577_009_981_112 },
    ]);
    expect(series.seriesId).toBe("WB:NY.GDP.MKTP.CD:THA");
    expect(series.label).toBe("GDP (current US$) · Thailand");
    expect(series.frequency).toBe("annual");
    expect(series.date).toBe("2025-12-31");
    expect(series.latest).toBe(577_009_981_112);
    expect(series.source).toBe("World Bank");
  });

  it("maps the unit off the indicator suffix", async () => {
    const cases: [string, string][] = [
      ["NY.GDP.MKTP.CD", "usd"],
      // Balance-of-payments dollar series end in `.CD.WD`, not `.CD`.
      ["BX.KLT.DINV.CD.WD", "usd"],
      ["FP.CPI.TOTL.ZG", "percent"],
      ["NE.EXP.GNFS.ZS", "percent"],
      // Current LOCAL currency — a dollar sign here would be a factual error.
      ["NY.GDP.MKTP.CN", "index"],
      ["SP.POP.TOTL", "index"],
    ];

    for (const [indicator, unit] of cases) {
      const WorldBank = await loadProvider();
      stubJson(body([row(indicator, indicator, "2025", 42)]));
      const series = await new WorldBank().getMacroReferenceSeries(
        `WB:${indicator}:THA`,
      );
      expect(series.unit, indicator).toBe(unit);
    }
  });

  it("measures a percent series in points and a level series in percent", async () => {
    stubJson(
      body([
        row(
          "FP.CPI.TOTL.ZG",
          "Inflation, consumer prices (annual %)",
          "2025",
          -0.13,
        ),
        row(
          "FP.CPI.TOTL.ZG",
          "Inflation, consumer prices (annual %)",
          "2024",
          0.4,
        ),
      ]),
    );

    const percent = await new WorldBankProvider().getMacroReferenceSeries(
      "WB:FP.CPI.TOTL.ZG:THA",
    );
    expect(percent.change).toBeCloseTo(-0.53, 10);

    const WorldBank = await loadProvider();
    stubJson(
      body([
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", 110),
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2024", 100),
      ]),
    );
    const level = await new WorldBank().getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );
    expect(level.change).toBeCloseTo(10, 10);
  });

  it("drops unreported years rather than charting them as zero", async () => {
    stubJson(
      body([
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", 577),
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2024", null),
        row("NY.GDP.MKTP.CD", "GDP (current US$)", "2023", 514),
      ]),
    );

    const series = await new WorldBankProvider().getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );

    expect(series.points.map((p) => p.value)).toEqual([514, 577]);
  });

  it("throws when the pair has no observations at all", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(body(null)))
      .mockResolvedValueOnce(
        jsonResponse(
          body([row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", null)]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new WorldBankProvider();

    for (let i = 0; i < 2; i++) {
      await expect(
        provider.getMacroReferenceSeries("WB:NY.GDP.MKTP.CD:THA"),
      ).rejects.toThrow(/worldbank: series .* returned no observations/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on an id outside the grammar before touching the network", async () => {
    const fetchMock = stubJson(body([]));
    const provider = new WorldBankProvider();

    for (const id of [
      "NY.GDP.MKTP.CD",
      "WB:NY.GDP.MKTP.CD",
      "WB:NY.GDP.MKTP.CD:TH",
      "WB::THA",
      "BIS:CBPOL:TH",
    ]) {
      await expect(provider.getMacroReferenceSeries(id)).rejects.toThrow(
        /worldbank: unknown series id/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body whose shape has drifted", async () => {
    stubJson(body([{ indicator: "GDP", date: "2025", value: 1 }]));

    await expect(
      new WorldBankProvider().getMacroReferenceSeries("WB:NY.GDP.MKTP.CD:THA"),
    ).rejects.toThrow();
  });

  it("serves a second read of the same id from cache", async () => {
    const fetchMock = stubJson(
      body([row("NY.GDP.MKTP.CD", "GDP (current US$)", "2025", 577)]),
    );
    const provider = new WorldBankProvider();

    const first = await provider.getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );
    const second = await provider.getMacroReferenceSeries(
      "WB:NY.GDP.MKTP.CD:THA",
    );

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
