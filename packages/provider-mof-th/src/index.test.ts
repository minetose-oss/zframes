import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MofThProvider as MofThProviderType } from "./index";

// The debt cache is a module-level singleton (and persisted), so each test gets
// a genuinely fresh module via vi.resetModules() + a dynamic import — the same
// isolation the other provider suites use.
type Ctor = typeof MofThProviderType;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.MofThProvider;
}

/**
 * The live export (2026-09), trimmed to the rows the parser reads plus two
 * sub-rows that must NOT be summed into the total. Verbatim otherwise: the BOM,
 * the quoting, the thousands separators, the Buddhist-era headers, and the
 * publisher's own typo in row 5 (หนื้ for หนี้).
 */
const CSV =
  "﻿" +
  [
    '"ชื่อรายการ","กุมภาพันธ์ 2569","มกราคม 2569","ธันวาคม 2568"',
    '"1. หนี้รัฐบาล (1.1+1.2+1.3)","11,388,490.85","11,303,239.50","11,213,103.78"',
    '"1.1 หนี้ที่รัฐบาลกู้โดยตรง","10,500,000.00","10,400,000.00","10,300,000.00"',
    '"1.2 หนี้ที่รัฐบาลกู้เพื่อชดใช้ความเสียหายให้แก่กองทุนฯ","888,490.85","903,239.50","913,103.78"',
    '"2. หนี้รัฐวิสาหกิจ (2.1+2.2)","1,048,955.88","1,049,856.35","1,049,260.72"',
    '"3. หนี้รัฐวิสาหกิจที่ทำธุรกิจในภาคการเงินฯ (รัฐบาลค้ำประกัน) (3.1+3.2)","123,625.39","154,626.06","154,752.85"',
    '"4. หนี้กองทุนเพื่อการฟื้นฟูฯ (4.1+4.2)","0.00","0.00","0.00"',
    '"5. หนื้หน่วยงานของรัฐ (5.1+5.2)","34,659.46","35,393.66","36,577.45"',
    '"Debt : GDP (%)","66.09","65.96","65.64"',
    '"ประมาณการ GDP (ล้านบาท)","19,059,846.29","19,059,846.29","19,059,846.29"',
    '"อัตราแลกเปลี่ยน (บาท)","31.26","31.51","31.74"',
  ].join("\n");

const MILLION_THB = {
  feb: 11_388_490.85 + 1_048_955.88 + 123_625.39 + 0 + 34_659.46,
  jan: 11_303_239.5 + 1_049_856.35 + 154_626.06 + 0 + 35_393.66,
  dec: 11_213_103.78 + 1_049_260.72 + 154_752.85 + 0 + 36_577.45,
};

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

function stubFetch(body = CSV, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(textResponse(body, status)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Drop a row from the fixture by its leading label fragment. */
function without(fragment: string): string {
  return CSV.split("\n")
    .filter((line) => !line.includes(fragment))
    .join("\n");
}

describe("MofThProvider", () => {
  let MofThProvider: Ctor;

  beforeEach(async () => {
    MofThProvider = await loadProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises the national-debt capability under its pin name", () => {
    const provider = new MofThProvider();
    expect(provider.name).toBe("mof-th");
    expect(provider.capabilities).toEqual(["national-debt"]);
  });

  it("totals the five top-level rows and converts at the published rate", async () => {
    stubFetch();
    const debt = await new MofThProvider().getNationalDebt();
    // Sub-rows (1.1, 1.2) belong to row 1 and must not be counted again.
    expect(debt.total).toBeCloseTo((MILLION_THB.feb * 1e6) / 31.26, 2);
    expect(debt.date).toBe("2026-02-28");
  });

  it("dates each column to its month end, oldest first", async () => {
    stubFetch();
    const { trend } = await new MofThProvider().getNationalDebt();
    expect(trend.map((point) => point.date)).toEqual([
      "2025-12-31",
      "2026-01-31",
      "2026-02-28",
    ]);
    expect(trend[0].time).toBe(Date.UTC(2025, 11, 31));
    expect(trend.map((point) => point.total)).toEqual([
      (MILLION_THB.dec * 1e6) / 31.74,
      (MILLION_THB.jan * 1e6) / 31.51,
      (MILLION_THB.feb * 1e6) / 31.26,
    ]);
    // The ministry splits its debt its own way, so the US pair stays absent.
    for (const point of trend) {
      expect(point.heldByPublic).toBeUndefined();
      expect(point.intragovernmental).toBeUndefined();
    }
  });

  it("labels the publisher's split in English and drops the retired line", async () => {
    stubFetch();
    const debt = await new MofThProvider().getNationalDebt();
    expect(debt.breakdown?.map((line) => line.label)).toEqual([
      "Government debt",
      "State-enterprise debt",
      "Financial state-enterprise debt (guaranteed)",
      // "FIDF debt" reads 0.00 in this release and is left out.
      "Other government agencies",
    ]);
    expect(debt.breakdown?.[0].value).toBeCloseTo(
      (11_388_490.85 * 1e6) / 31.26,
      2,
    );
    expect(debt.heldByPublic).toBeUndefined();
    expect(debt.intragovernmental).toBeUndefined();
  });

  it("reads the ministry's own Debt : GDP percentage", async () => {
    stubFetch();
    const debt = await new MofThProvider().getNationalDebt();
    expect(debt.debtToGdpPct).toBe(66.09);
  });

  it("ignores the days argument — the export carries three months, always", async () => {
    stubFetch();
    const provider = new MofThProvider();
    // The capability's signature carries a `days` argument; this implementation
    // declares none, so the call site's extra argument is simply dropped.
    const call = provider.getNationalDebt as (
      days?: number,
    ) => ReturnType<typeof provider.getNationalDebt>;
    const wide = await call.call(provider, 3650);
    expect(wide.trend).toHaveLength(3);
  });

  it("throws when the published rate row is gone — the figures are baht", async () => {
    stubFetch(without("อัตราแลกเปลี่ยน"));
    await expect(new MofThProvider().getNationalDebt()).rejects.toThrow(
      /THB\/USD rate row/,
    );
  });

  it("throws when the Debt : GDP row is gone", async () => {
    stubFetch(without("Debt : GDP"));
    await expect(new MofThProvider().getNationalDebt()).rejects.toThrow(
      /Debt : GDP/,
    );
  });

  it("throws when a top-level component row is gone", async () => {
    stubFetch(without("3. หนี้รัฐวิสาหกิจที่ทำธุรกิจ"));
    await expect(new MofThProvider().getNationalDebt()).rejects.toThrow(
      /missing top-level row\(s\) 3/,
    );
  });

  it("throws when no column header parses as a Thai month", async () => {
    stubFetch(
      CSV.replace("กุมภาพันธ์ 2569", "Feb-26").replace(
        /"(มกราคม|ธันวาคม) \d{4}"/g,
        '"x"',
      ),
    );
    await expect(new MofThProvider().getNationalDebt()).rejects.toThrow(
      /month column headers/,
    );
  });

  it("serves a second call from cache", async () => {
    const fetchMock = stubFetch();
    const provider = new MofThProvider();
    await provider.getNationalDebt();
    await provider.getNationalDebt();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
