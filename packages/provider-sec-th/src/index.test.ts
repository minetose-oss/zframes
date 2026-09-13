import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecThProvider as SecThProviderType } from "./index";

// The two TtlCaches here plus the one behind the shared fx-rate primitive are
// module-level singletons, so each test takes a genuinely fresh module (empty
// caches) via vi.resetModules() + a dynamic import — otherwise a primed value
// leaks into the next test's error path.
type Ctor = typeof SecThProviderType;

/** THB per USD every stub answers, so the expected USD figures are exact. */
const FX = 33.6;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.SecThProvider;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const FX_HOSTS = [
  "frankfurter",
  "fxratesapi",
  "currency-api",
  "data-api.ecb.europa.eu",
];

function isFxUrl(url: unknown): boolean {
  return FX_HOSTS.some((host) => String(url).includes(host));
}

/**
 * Both capability methods fetch the CSV and the USD/THB rate in parallel, so a
 * single-response mock would feed the FX body to the CSV parser. Frankfurter
 * (the chain's primary) answers here, leaving the fallbacks untouched.
 */
function stubFetch(csvByUrlFragment: Record<string, string>) {
  const fetchMock = vi.fn((url: string) => {
    if (isFxUrl(url))
      return Promise.resolve(jsonResponse({ rates: { THB: FX } }));
    const hit = Object.entries(csvByUrlFragment).find(([fragment]) =>
      String(url).includes(fragment),
    );
    if (!hit) return Promise.reject(new Error(`unstubbed url: ${String(url)}`));
    return Promise.resolve(textResponse(hit[1]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const BOM = "﻿";

/**
 * Cut from the live file (2026-09-13): the BOM, the Thai header, MAI's
 * group-only rows and SET's sector-only rows, a `-` for a missing print, and
 * the ampersand code that a naive word-split would drop.
 */
const INDUSTRY_CSV = [
  `${BOM}ข้อมูล ณ วันที่,ตลาด,ประเภทอุตสาหกรรม,ปี,ไตรมาส,มูลค่า`,
  `30/06/2569,MAI,AGRO    (เกษตรและอุตสาหกรรมอาหาร),2026,Quarter 1,"13,477.63"`,
  `30/06/2569,MAI,AGRO    (เกษตรและอุตสาหกรรมอาหาร),2026,Quarter 2,"19,251.39"`,
  `30/06/2569,MAI,TECH    (เทคโนโลยี),2026,Quarter 1,"9,000.00"`,
  `30/06/2569,MAI,TECH    (เทคโนโลยี),2026,Quarter 2,"11,000.00"`,
  `30/06/2569,SET,BANK    (ธนาคาร),2026,Quarter 1,"2,000,000.00"`,
  `30/06/2569,SET,BANK    (ธนาคาร),2026,Quarter 2,"2,500,000.00"`,
  `30/06/2569,SET,FIN     (เงินทุนและหลักทรัพย์),2026,Quarter 1,"500,000.00"`,
  `30/06/2569,SET,FIN     (เงินทุนและหลักทรัพย์),2026,Quarter 2,"600,000.00"`,
  `30/06/2569,SET,PF&REIT (กองทุนรวมอสังหาริมทรัพย์และกองทรัสต์),2026,Quarter 1,-`,
  `30/06/2569,SET,PF&REIT (กองทุนรวมอสังหาริมทรัพย์และกองทรัสต์),2026,Quarter 2,"300,000.00"`,
  `30/06/2569,SET,ZZZ     (หมวดใหม่),2026,Quarter 2,"1,000.00"`,
  "",
].join("\n");

/** Cut from the live file (2026-09-13), keeping one row of every shape. */
const FUND_CSV = [
  `${BOM}As of date,type,assetliab_desc,year,quarter,value`,
  "31/3/2569,หลักทรัพย์/ทรัพย์สินในประเทศที่จดทะเบียน,หุ้นสามัญ,2569,ไตรมาส 1,965102.4566",
  "31/3/2569,หลักทรัพย์/ทรัพย์สินในประเทศที่จดทะเบียน,ศุกูก,2569,ไตรมาส 1,0",
  "31/3/2569,หลักทรัพย์/ทรัพย์สินในประเทศที่จดทะเบียน,สัญญาซื้อขายล่วงหน้า,2569,ไตรมาส 1,-3.3439592",
  "31/3/2569,หลักทรัพย์/ทรัพย์สินในประเทศที่อยู่นอกตลาด,เงินฝาก/บัตรเงินฝาก/หนังสือยืนยันการรับฝากเงิน,2569,ไตรมาส 1,166005.1861",
  "31/3/2569,หลักทรัพย์/ทรัพย์สินต่างประเทศ,Euro Commercial Paper/Euro Medium Term Note,2569,ไตรมาส 1,6151.136672",
  "31/3/2569,สินทรัพย์อื่น,-,2569,ไตรมาส 1,72823.97542",
  "31/3/2569,หนี้สินอื่น,-,2569,ไตรมาส 1,111237.7952",
  "31/3/2569,มูลค่าทรัพย์สินสุทธิ (ก่อนหักมูลค่าการลงทุนในกองทุนภายใต้ บลจ.เดียวกัน),-,2569,ไตรมาส 1,5828534.015",
  "31/3/2569,มูลค่าทรัพย์สินสุทธิ (หลังหักมูลค่าการลงทุนในกองทุนภายใต้ บลจ.เดียวกัน),-,2569,ไตรมาส 1,5786872.777",
  "",
].join("\n");

/** What the host's F5 WAF answers, verbatim, with HTTP 200 and text/html. */
const WAF_REJECTION =
  "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 1799735157251140869<br><br></body></html>";

/** Million THB → USD at the stubbed rate, the provider's own conversion. */
const usd = (millionThb: number) => (millionThb * 1e6) / FX;

let SecThProvider: Ctor;

beforeEach(async () => {
  SecThProvider = await loadProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getIndustryMarketCap", () => {
  it("parses SET's sector rows and rolls them up into groups", async () => {
    stubFetch({ STAT_INDUSTRY_TH: INDUSTRY_CSV });
    const caps = await new SecThProvider().getIndustryMarketCap("SET");

    expect(caps.market).toBe("SET");
    // The header cell is BOM-prefixed; a failed strip would shift every column.
    expect(caps.asOf).toBe("2026-06-30");
    expect(caps.period).toBe("2026 Q2");
    expect(caps.source).toBe("SEC Thailand");

    expect(caps.sectors.map((s) => s.code)).toEqual([
      "BANK",
      "FIN",
      "PF&REIT",
      "ZZZ",
    ]);
    const bank = caps.sectors.find((s) => s.code === "BANK");
    expect(bank).toEqual({
      code: "BANK",
      name: "Banking",
      group: "FINCIAL",
      value: usd(2_500_000),
      prev: usd(2_000_000),
    });
    // The ampersand code survives the first-token split and keeps its parent.
    expect(caps.sectors.find((s) => s.code === "PF&REIT")).toEqual({
      code: "PF&REIT",
      name: "Property Funds & REITs",
      group: "PROPCON",
      value: usd(300_000),
    });
    // An unknown code keeps its code as the name and has no parent group.
    expect(caps.sectors.find((s) => s.code === "ZZZ")).toEqual({
      code: "ZZZ",
      name: "ZZZ",
      value: usd(1_000),
    });

    // SET publishes no group rows, so the groups are summed from the sectors.
    expect(caps.groups).toEqual([
      {
        code: "FINCIAL",
        name: "Financials",
        value: usd(3_100_000),
        prev: usd(2_500_000),
      },
      // PF&REIT has no previous print, so its parent reports none either.
      { code: "PROPCON", name: "Property & Construction", value: usd(300_000) },
    ]);
  });

  it("orders history oldest → newest and totals each period", async () => {
    stubFetch({ STAT_INDUSTRY_TH: INDUSTRY_CSV });
    const caps = await new SecThProvider().getIndustryMarketCap("SET");

    expect(caps.history.map((h) => h.period)).toEqual(["2026 Q1", "2026 Q2"]);
    expect(caps.history[0].total).toBeCloseTo(usd(2_500_000), 3);
    expect(caps.history[1].total).toBeCloseTo(usd(3_401_000), 3);
    // The `-` cell is a missing print, never a zero.
    expect(caps.history[0].byCode["PF&REIT"]).toBeUndefined();
    expect(new Date(caps.history[1].time).toISOString()).toBe(
      "2026-06-30T23:59:59.999Z",
    );
  });

  it("reports mai's group-only rows with no sectors", async () => {
    stubFetch({ STAT_INDUSTRY_TH: INDUSTRY_CSV });
    const caps = await new SecThProvider().getIndustryMarketCap("mai");

    expect(caps.market).toBe("mai");
    expect(caps.sectors).toEqual([]);
    expect(caps.groups.map((g) => g.code)).toEqual(["AGRO", "TECH"]);
    expect(caps.groups[0].value).toBe(usd(19_251.39));
    expect(caps.groups[0].prev).toBe(usd(13_477.63));
    expect(caps.history[1].total).toBe(usd(19_251.39 + 11_000));
  });

  it("accepts the market case-insensitively", async () => {
    stubFetch({ STAT_INDUSTRY_TH: INDUSTRY_CSV });
    const caps = await new SecThProvider().getIndustryMarketCap("MAI");
    expect(caps.market).toBe("mai");
  });

  it("names the WAF block instead of parsing its page as CSV", async () => {
    stubFetch({ STAT_INDUSTRY_TH: WAF_REJECTION });
    await expect(
      new SecThProvider().getIndustryMarketCap("SET"),
    ).rejects.toThrow(/blocked by the upstream WAF/);
  });
});

describe("getFundIndustryAllocation", () => {
  it("translates the buckets, drops the empty and negative rows", async () => {
    stubFetch({ MF_PORT_TH: FUND_CSV });
    const allocation = await new SecThProvider().getFundIndustryAllocation();

    // The year column here is Buddhist Era, unlike the industry file's.
    expect(allocation.period).toBe("2026 Q1");
    expect(allocation.asOf).toBe("2026-03-31");
    expect(allocation.source).toBe("SEC Thailand");

    expect(allocation.buckets.map((b) => `${b.group}/${b.label}`)).toEqual([
      "Listed domestic/Common stock",
      "Unlisted domestic/Deposits",
      "Foreign/ECP / EMTN",
      "Other assets/Other assets",
    ]);
    expect(allocation.buckets[0].value).toBe(usd(965_102.4566));
  });

  it("takes the NAV after intra-manager holdings and shares against it", async () => {
    stubFetch({ MF_PORT_TH: FUND_CSV });
    const allocation = await new SecThProvider().getFundIndustryAllocation();

    // The file carries a larger "before netting" total directly above it.
    expect(allocation.totalNav).toBe(usd(5_786_872.777));
    expect(allocation.buckets[0].sharePct).toBeCloseTo(
      (965_102.4566 / 5_786_872.777) * 100,
      10,
    );
  });

  it("throws when the net-asset-value row is missing", async () => {
    const withoutTotal = FUND_CSV.split("\n")
      .filter((line) => !line.includes("หลังหัก"))
      .join("\n");
    stubFetch({ MF_PORT_TH: withoutTotal });
    await expect(
      new SecThProvider().getFundIndustryAllocation(),
    ).rejects.toThrow(/no net-asset-value row/);
  });

  it("names the WAF block here too", async () => {
    stubFetch({ MF_PORT_TH: WAF_REJECTION });
    await expect(
      new SecThProvider().getFundIndustryAllocation(),
    ).rejects.toThrow(/blocked by the upstream WAF/);
  });
});
