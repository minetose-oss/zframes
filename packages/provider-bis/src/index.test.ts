import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BisProvider as BisProviderType } from "./index";

// What this file pins, and why it matters:
//
//  1. **Columns read by NAME.** The four dataflows do not share a column order —
//     `WS_CBPOL` has `SOURCE_REF`/`TITLE` in the middle, `WS_EER` a `TITLE_TS`
//     and no source, `WS_XRU` a different tail — so a positional parser is right
//     for at most one of them and silently publishes a decimals count as a
//     policy rate for the rest. The fixture headers below are copied verbatim
//     from the live responses.
//  2. **Multi-country parsing.** One request answers for every country in the
//     key, interleaved; rows are grouped by `REF_AREA` and returned in the order
//     the CALLER asked for, not the publisher's.
//  3. **`prev` / `changedOn`.** The previous rate is the most recent DIFFERENT
//     one, and `changedOn` is the first period of the current rate's unbroken
//     run — not simply the month before last, which would report a change every
//     month on a rate that has been on hold for a year.
//  4. **Period parsing.** `2026-Q1` resolves to the quarter's LAST day and
//     `2026-08` to the month's first; a quarter stamped at its start would plot
//     three months before the data it describes.
//  5. **The id grammar.** Every `BIS:…` branch maps to its live-verified series
//     key, including the FREQ letter, which differs per variant (the real
//     effective exchange rate exists only monthly). An unknown id throws before
//     the network rather than 404ing inside the transport.
type Ctor = typeof BisProviderType;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.BisProvider;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function stubCsv(text: string) {
  const fetchMock = vi.fn().mockResolvedValue(textResponse(text));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function csv(header: string, rows: string[]) {
  return [header, ...rows, ""].join("\r\n");
}

/** The live `WS_CBPOL` header. */
const CBPOL_HEADER =
  "FREQ,REF_AREA,UNIT_MEASURE,UNIT_MULT,TIME_FORMAT,COMPILATION,DECIMALS," +
  "SOURCE_REF,SUPP_INFO_BREAKS,TITLE,TIME_PERIOD,OBS_VALUE,OBS_STATUS," +
  "OBS_CONF,OBS_PRE_BREAK";

/**
 * One `WS_CBPOL` row. `COMPILATION` is quoted and full of commas in the real
 * file, so it is quoted here too — a naive split would shift `OBS_VALUE`.
 */
function cbpolRow(
  area: string,
  period: string,
  value: number | string,
  bank: string,
) {
  return [
    "M",
    area,
    "368",
    "0",
    "",
    '"Offical market intervention representative rate, liquidity providing repo rate."',
    "4",
    bank,
    "",
    ` Central bank policy rates - ${area} - Monthly - End of period`,
    period,
    value,
    "A",
    "F",
    "",
  ].join(",");
}

const EER_HEADER =
  "FREQ,EER_TYPE,EER_BASKET,REF_AREA,UNIT_MEASURE,TIME_FORMAT,COLLECTION," +
  "TITLE_TS,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK";

function eerRow(freq: string, type: string, period: string, value: number) {
  return [
    freq,
    type,
    "B",
    "TH",
    "882",
    "",
    "A",
    `Thailand - ${type === "N" ? "Nominal" : "Real"} - Broad (64 economies)`,
    period,
    value,
    "A",
    "F",
    "",
  ].join(",");
}

const SPP_HEADER =
  "FREQ,REF_AREA,VALUE,UNIT_MEASURE,UNIT_MULT,BREAKS,COVERAGE,TITLE_TS," +
  "TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK";

function sppRow(value: string, period: string, obs: number) {
  return [
    "Q",
    "TH",
    value,
    "628",
    "0",
    "",
    "",
    "",
    period,
    obs,
    "A",
    "F",
    "",
  ].join(",");
}

const XRU_HEADER =
  "FREQ,REF_AREA,CURRENCY,COLLECTION,UNIT_MULT,DECIMALS,AVAILABILITY,TITLE," +
  "TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_PRE_BREAK,OBS_CONF";

function xruRow(period: string, obs: number) {
  return [
    "D",
    "TH",
    "THB",
    "A",
    "0",
    "6",
    "A",
    " Exchange rates against USD Thailand - Baht - Daily - Average of observations through period",
    period,
    obs,
    "A",
    "",
    "F",
  ].join(",");
}

const BASE = "https://stats.bis.org/api/v2/data/dataflow/BIS/";

describe("BisProvider", () => {
  let BisProvider: Ctor;

  beforeEach(async () => {
    BisProvider = await loadProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("advertises its identity and capabilities", () => {
    const provider = new BisProvider();
    expect(provider.name).toBe("bis");
    expect(provider.capabilities).toEqual([
      "policy-rates",
      "macro-reference-series",
    ]);
  });

  describe("getPolicyRates", () => {
    it("splits one interleaved response into per-country rates, in the requested order", async () => {
      const fetchMock = stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("US", "2026-07", 3.875, "US Federal Reserve System"),
          cbpolRow("TH", "2026-07", 1.25, "Bank of Thailand"),
          cbpolRow("US", "2026-08", 3.625, "US Federal Reserve System"),
          cbpolRow("TH", "2026-08", 1, "Bank of Thailand"),
        ]),
      );

      const rates = await new BisProvider().getPolicyRates(["TH", "US"]);

      // Requested order, not the publisher's row order.
      expect(rates.map((r) => r.country)).toEqual(["TH", "US"]);
      expect(rates[0]).toEqual({
        country: "TH",
        bank: "Bank of Thailand",
        rate: 1,
        date: "2026-08-01",
        prev: 1.25,
        changedOn: "2026-08-01",
        source: "BIS",
      });
      expect(rates[1].rate).toBe(3.625);
      expect(rates[1].bank).toBe("US Federal Reserve System");
      // One request covers the whole basket, codes sorted into the key.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_CBPOL/1.0/M.TH+US?format=csv&lastNObservations=36`,
      );
    });

    it("walks back over a held rate to find the previous distinct one", async () => {
      stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("TH", "2026-02", 1.75, "Bank of Thailand"),
          cbpolRow("TH", "2026-03", 1.5, "Bank of Thailand"),
          cbpolRow("TH", "2026-04", 1.25, "Bank of Thailand"),
          cbpolRow("TH", "2026-05", 1.25, "Bank of Thailand"),
          cbpolRow("TH", "2026-06", 1.25, "Bank of Thailand"),
        ]),
      );

      const [rate] = await new BisProvider().getPolicyRates(["TH"]);

      expect(rate.rate).toBe(1.25);
      expect(rate.date).toBe("2026-06-01");
      // 1.5 is the most recent DIFFERENT rate, and the current run starts in
      // April — not May, which is merely the month before last.
      expect(rate.prev).toBe(1.5);
      expect(rate.changedOn).toBe("2026-04-01");
    });

    it("leaves `prev` absent when the window shows no change at all", async () => {
      stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("JP", "2026-07", 1, "Bank of Japan"),
          cbpolRow("JP", "2026-08", 1, "Bank of Japan"),
        ]),
      );

      const [rate] = await new BisProvider().getPolicyRates(["JP"]);

      expect("prev" in rate).toBe(false);
      expect(rate.changedOn).toBe("2026-07-01");
    });

    it("names the euro area's bank when the publisher leaves SOURCE_REF blank", async () => {
      stubCsv(csv(CBPOL_HEADER, [cbpolRow("XM", "2026-08", 2.25, "")]));

      const [rate] = await new BisProvider().getPolicyRates(["xm"]);

      expect(rate.country).toBe("XM");
      expect(rate.bank).toBe("European Central Bank");
    });

    it("drops a country the publisher answered nothing for", async () => {
      stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("TH", "2026-08", 1, "Bank of Thailand"),
          cbpolRow("GB", "2026-08", "", "Bank of England"),
        ]),
      );

      const rates = await new BisProvider().getPolicyRates(["TH", "GB"]);

      expect(rates.map((r) => r.country)).toEqual(["TH"]);
    });

    it("defaults to the verified basket, Thailand first", async () => {
      const fetchMock = stubCsv(
        csv(CBPOL_HEADER, [cbpolRow("TH", "2026-08", 1, "Bank of Thailand")]),
      );

      const rates = await new BisProvider().getPolicyRates();

      expect(rates[0].country).toBe("TH");
      // Singapore and Vietnam are absent: BIS publishes no policy rate for
      // either and including them 404s the whole multi-country request.
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain("TH+");
      expect(url).not.toContain("SG");
      expect(url).not.toContain("VN");
    });

    it("shares one download between two orderings of the same basket", async () => {
      const fetchMock = stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("TH", "2026-08", 1, "Bank of Thailand"),
          cbpolRow("US", "2026-08", 3.625, "US Federal Reserve System"),
        ]),
      );
      const provider = new BisProvider();

      const first = await provider.getPolicyRates(["TH", "US"]);
      const second = await provider.getPolicyRates(["US", "TH"]);

      expect(first.map((r) => r.country)).toEqual(["TH", "US"]);
      expect(second.map((r) => r.country)).toEqual(["US", "TH"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getMacroReferenceSeries", () => {
    it("reads a monthly policy-rate history and labels it from SOURCE_REF", async () => {
      const fetchMock = stubCsv(
        csv(CBPOL_HEADER, [
          cbpolRow("TH", "2026-07", 1.25, "Bank of Thailand"),
          cbpolRow("TH", "2026-08", 1, "Bank of Thailand"),
        ]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:CBPOL:TH",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_CBPOL/1.0/M.TH?format=csv&lastNObservations=240`,
      );
      expect(series.seriesId).toBe("BIS:CBPOL:TH");
      expect(series.label).toBe("Bank of Thailand policy rate");
      expect(series.unit).toBe("percent");
      expect(series.frequency).toBe("monthly");
      expect(series.latest).toBe(1);
      expect(series.date).toBe("2026-08-01");
      // A rate's move is in percentage POINTS, not percent.
      expect(series.change).toBeCloseTo(-0.25, 10);
      expect(series.points).toEqual([
        { time: Date.UTC(2026, 6, 1), value: 1.25 },
        { time: Date.UTC(2026, 7, 1), value: 1 },
      ]);
      expect(series.source).toBe("BIS");
    });

    it("fetches the nominal effective exchange rate daily", async () => {
      const fetchMock = stubCsv(
        csv(EER_HEADER, [
          eerRow("D", "N", "2026-09-05", 102.5),
          eerRow("D", "N", "2026-09-08", 102.94),
        ]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:EER:N:TH",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_EER/1.0/D.N.B.TH?format=csv&lastNObservations=1500`,
      );
      expect(series.label).toBe("TH nominal effective exchange rate (broad)");
      expect(series.unit).toBe("index");
      expect(series.frequency).toBe("daily");
      expect(series.date).toBe("2026-09-08");
      // An index level moves in percent.
      expect(series.change).toBeCloseTo(((102.94 - 102.5) / 102.5) * 100, 10);
    });

    it("fetches the REAL effective exchange rate monthly (no daily series exists)", async () => {
      const fetchMock = stubCsv(
        csv(EER_HEADER, [eerRow("M", "R", "2026-07", 97.72)]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:EER:R:TH",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_EER/1.0/M.R.B.TH?format=csv&lastNObservations=240`,
      );
      expect(series.frequency).toBe("monthly");
      expect(series.label).toBe("TH real effective exchange rate (broad)");
    });

    it("stamps a quarterly property-price point at the quarter's last day", async () => {
      const fetchMock = stubCsv(
        csv(SPP_HEADER, [
          sppRow("N", "2025-Q4", 181.2),
          sppRow("N", "2026-Q1", 183.8196),
        ]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:SPP:N:TH",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_SPP/1.0/Q.TH.N.628?format=csv&lastNObservations=120`,
      );
      expect(series.frequency).toBe("quarterly");
      expect(series.label).toBe("TH residential property prices (nominal)");
      expect(series.points).toEqual([
        { time: Date.UTC(2025, 11, 31), value: 181.2 },
        { time: Date.UTC(2026, 2, 31), value: 183.8196 },
      ]);
      expect(series.date).toBe("2026-03-31");
    });

    it("fetches the real property-price variant off the same dataflow", async () => {
      const fetchMock = stubCsv(
        csv(SPP_HEADER, [sppRow("R", "2026-Q1", 150.8307)]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:SPP:R:TH",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_SPP/1.0/Q.TH.R.628?format=csv&lastNObservations=120`,
      );
      expect(series.label).toBe("TH residential property prices (real)");
    });

    it("reads the USD exchange rate as a unitless level", async () => {
      const fetchMock = stubCsv(
        csv(XRU_HEADER, [
          xruRow("2026-09-05", 32.8),
          xruRow("2026-09-08", 32.914586),
        ]),
      );

      const series = await new BisProvider().getMacroReferenceSeries(
        "BIS:XRU:TH:THB",
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE}WS_XRU/1.0/D.TH.THB.A?format=csv&lastNObservations=1500`,
      );
      expect(series.label).toBe("USD/THB");
      // `usd` would render 32.91 baht per dollar as "$32.91".
      expect(series.unit).toBe("index");
      expect(series.latest).toBe(32.914586);
    });

    it("fetches direct, with no proxy hop, even in a browser", async () => {
      // stats.bis.org echoes the requesting Origin, so these frames keep working
      // on a static host where the proxied US sources degrade to empty.
      vi.stubGlobal("document", {});
      const fetchMock = stubCsv(
        csv(CBPOL_HEADER, [cbpolRow("TH", "2026-08", 1, "Bank of Thailand")]),
      );

      await new BisProvider().getMacroReferenceSeries("BIS:CBPOL:TH");

      expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/stats\./);
    });

    it("throws on an unknown id before touching the network", async () => {
      const fetchMock = stubCsv("");
      const provider = new BisProvider();

      for (const id of [
        "CPIAUCSL",
        "BIS:CBPOL",
        "BIS:CBPOL:THA",
        "BIS:EER:X:TH",
        "BIS:SPP:TH",
        "BIS:XRU:TH",
        "BIS:UNKNOWN:TH",
      ]) {
        await expect(provider.getMacroReferenceSeries(id)).rejects.toThrow(
          /bis: unknown series id/,
        );
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws when the dataflow answers a header with no observations", async () => {
      stubCsv(csv(CBPOL_HEADER, []));

      await expect(
        new BisProvider().getMacroReferenceSeries("BIS:CBPOL:TH"),
      ).rejects.toThrow(/returned no rows/);
    });
  });
});
