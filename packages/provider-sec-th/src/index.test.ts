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

/**
 * Cut from the live file (2026-09-13). Note the label of the first two rows
 * carries a TRAILING SPACE and the P/BV label loses its halfway down — the
 * publisher is inconsistent within one file, which is why every lookup trims.
 * Years are Buddhist Era here.
 */
const SET_STATS_CSV = [
  `${BOM}ข้อมูล ณ วันที่,รายการ,ปี,ค่า`,
  "31/12/2568,ดัชนีราคาหลักทรัพย์ตลาดหลักทรัพย์แห่งประเทศไทย ,2567,1400.21",
  "31/12/2568,ดัชนีราคาหลักทรัพย์ตลาดหลักทรัพย์แห่งประเทศไทย ,2568,1259.67",
  '31/12/2568,มูลค่าซื้อขายทั้งหมด (ล้านบาท),2567,"11,000,000.00"',
  '31/12/2568,มูลค่าซื้อขายทั้งหมด (ล้านบาท),2568,"9,957,995.69"',
  '31/12/2568,มูลค่าซื้อขายเฉลี่ยต่อวัน (ล้านบาท),2567,"45,000.00"',
  '31/12/2568,มูลค่าซื้อขายเฉลี่ยต่อวัน (ล้านบาท),2568,"41,148.74"',
  "31/12/2568,อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ) ,2567,60.11",
  "31/12/2568,อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ),2568,56.2095727",
  '31/12/2568,มูลค่าหลักทรัพย์ตามราคาตลาด (ล้านบาท) ,2567,"17,500,000.00"',
  '31/12/2568,มูลค่าหลักทรัพย์ตามราคาตลาด (ล้านบาท),2568,"16,189,722.67"',
  "31/12/2568,จำนวนบริษัทจดทะเบียน ,2567,645",
  "31/12/2568,จำนวนบริษัทจดทะเบียน,2568,638",
  "31/12/2568,จำนวนหลักทรัพย์จดทะเบียน ,2567,2145",
  "31/12/2568,จำนวนหลักทรัพย์จดทะเบียน,2568,2131",
  "31/12/2568,ราคาปิดต่อกำไรต่อหุ้น (เท่า) ,2567,-",
  "31/12/2568,ราคาปิดต่อกำไรต่อหุ้น (เท่า),2568,15.44",
  "31/12/2568,ราคาปิดต่อมูลค่าหุ้นตามบัญชี (เท่า) ,2567,1.4",
  "31/12/2568,ราคาปิดต่อมูลค่าหุ้นตามบัญชี (เท่า),2568,1.19",
  "31/12/2568,อัตราเงินปันผลตอบแทน (ร้อยละ) ,2567,3.42",
  "31/12/2568,อัตราเงินปันผลตอบแทน (ร้อยละ),2568,3.71",
  "",
].join("\n");

/** The mai file, whose index row is the one label that differs per venue. */
const MAI_STATS_CSV = [
  `${BOM}ข้อมูล ณ วันที่,รายการ,ปี,ค่า`,
  "31/12/2568,ดัชนีราคาหลักทรัพย์ตลาดหลักทรัพย์ เอ็ม เอ ไอ,2568,217.05",
  '31/12/2568,มูลค่าหลักทรัพย์ตามราคาตลาด (ล้านบาท),2568,"219,554.52"',
  "31/12/2568,จำนวนบริษัทจดทะเบียน,2568,230",
  "",
].join("\n");

/**
 * The investor file. Four classes are published; the fourth (domestic
 * individuals) has no slot in the contract and must be ignored rather than
 * mis-bucketed.
 */
const SET_INVESTOR_CSV = [
  `${BOM}ข้อมูล ณ วันที่,รายการ,ประเภทผู้ลงทุน,ปี,มูลค่า`,
  "31/12/2568,มูลค่าซื้อขายสุทธิ ,ผู้ลงทุนต่างประเทศ,2568,-100000.5",
  "31/12/2568,สัดส่วนมูลค่าซื้อขายรวม (ร้อยละ),ผู้ลงทุนต่างประเทศ,2568,52.4",
  "31/12/2568,มูลค่าซื้อขายสุทธิ ,ผู้ลงทุนสถาบันในประเทศ,2568,55000.25",
  "31/12/2568,สัดส่วนมูลค่าซื้อขายรวม (ร้อยละ),ผู้ลงทุนสถาบันในประเทศ,2568,13.1",
  "31/12/2568,มูลค่าซื้อขายสุทธิ ,บัญชีบริษัทหลักทรัพย์,2568,12000",
  "31/12/2568,สัดส่วนมูลค่าซื้อขายรวม (ร้อยละ),บัญชีบริษัทหลักทรัพย์,2568,9.8",
  "31/12/2568,มูลค่าซื้อขายสุทธิ ,ผู้ลงทุนทั่วไปในประเทศ,2568,33000",
  // 2567 has a net for one class and no share, so the year stays unannotated.
  "31/12/2568,มูลค่าซื้อขายสุทธิ ,ผู้ลงทุนต่างประเทศ,2567,-80000",
  "",
].join("\n");

/**
 * Cut from the live bond file (2026-09-13): the four segments, the turnover
 * block that repeats its own item name where the others say "ยอดรวม", the
 * Thai investor classes, the English `Bond Index` block, and a `-` print.
 */
const BOND_CSV = [
  `${BOM}ข้อมูล ณ วันที่,รายการ,ประเภท,ปี,ค่า`,
  '31/12/2568,มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท) ,ยอดรวม,2568,"18,175,072.20"',
  '31/12/2568,มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท) ,ตราสารหนี้ภาครัฐ,2568,"13,612,527.31"',
  '31/12/2568,มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท) ,ตราสารหนี้ภาคเอกชน ,2568,"4,509,601.65"',
  "31/12/2568,มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท) ,พันธบัตรต่างประเทศ,2568,-",
  '31/12/2568,มูลค่าซื้อขาย (ล้านบาท) ,ยอดรวม,2568,"21,958,275.22"',
  '31/12/2568,มูลค่าซื้อขาย (ล้านบาท) ,ตราสารหนี้ภาครัฐ,2568,"20,466,035.02"',
  '31/12/2568,มูลค่าซื้อขายเฉลี่ยต่อวัน (ล้านบาท) ,มูลค่าซื้อขายเฉลี่ยต่อวัน,2568,"90,736.67"',
  "31/12/2568,อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ),อัตราการหมุนเวียนของการซื้อขาย,2568,123.731286",
  "31/12/2568,อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ),ตราสารหนี้ภาคเอกชน ,2568,32.84517819",
  "31/12/2568,จำนวนหลักทรัพย์ขึ้นทะเบียน,ยอดรวม,2568,2770",
  "31/12/2568,จำนวนหลักทรัพย์ขึ้นทะเบียน,ตราสารหนี้ภาครัฐ,2568,471",
  "31/12/2568,สัดส่วนมูลค่าซื้อขาย (ร้อยละ),รายย่อย,2568,1.36",
  "31/12/2568,สัดส่วนมูลค่าซื้อขาย (ร้อยละ),ระหว่างผู้ค้าตราสารหนี้,2568,34.82",
  "31/12/2568,สัดส่วนมูลค่าซื้อขาย (ร้อยละ),อื่น ๆ,2568,2.41",
  "31/12/2568,Bond Index,Government Bond Total Return Index,2568,364.158709",
  "31/12/2568,Bond Index,Average Government Bond Yield (ร้อยละ),2568,2.034241",
  "31/12/2568,Bond Index,MTM Corporate Bond Total Return Index,2568,234.8998",
  "31/12/2568,Bond Index,Average MTM Corporate Bond Yield (ร้อยละ),2568,2.46734",
  '31/12/2568,มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท) ,ยอดรวม,2567,"17,000,000.00"',
  "",
].join("\n");

/**
 * Cut from the live issuance file (2026-09-13). Its year column is COMMON ERA
 * and its quarter is spelled `Q1`, unlike every other file on this host.
 */
const ISSUANCE_CSV = [
  `${BOM}As of date,bond_type,offer_country_name_th,corporation_type,invest_type,year,quarter,value_mn_bath`,
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,1.ในประเทศ,1.นิติบุคคลไทย,ตั๋วเงิน,2024,Q4,100000",
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,1.ในประเทศ,1.นิติบุคคลไทย,ตั๋วเงิน,2025,Q1,165576.82",
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,1.ในประเทศ,1.นิติบุคคลไทย,หุ้นกู้ระยะยาว / พันธบัตรระยะยาว,2025,Q1,50000",
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,2.ต่างประเทศ,1.นิติบุคคลไทย,หุ้นกู้สกุลเงินต่างประเทศ,2025,Q1,8000",
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,1.ในประเทศ,1.นิติบุคคลไทย,หุ้นกู้ชนิดใหม่,2025,Q1,1000",
  "31/12/2568,1.ตราสารหนี้ภาคเอกชน,1.ในประเทศ,1.นิติบุคคลไทย,หุ้นกู้แปลงสภาพ,2025,Q1,-",
  "31/12/2568,2.ตราสารหนี้ภาครัฐไทย,1.ในประเทศ,1.ภาครัฐไทย,หุ้นกู้ระยะยาว / พันธบัตรระยะยาว,2025,Q1,400000",
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

describe("getExchangeKeyStats", () => {
  it("reads SET's table across its trailing-space labels and BE years", async () => {
    stubFetch({
      STAT_SET_TH: SET_STATS_CSV,
      STAT_TRADINGVALUE: SET_INVESTOR_CSV,
    });
    const stats = await new SecThProvider().getExchangeKeyStats("SET");

    expect(stats.market).toBe("SET");
    expect(stats.asOf).toBe("2025-12-31");
    expect(stats.source).toBe("SEC Thailand");
    // Buddhist-Era year columns, oldest → newest.
    expect(stats.years.map((y) => y.year)).toEqual([2024, 2025]);

    const latest = stats.years[1];
    expect(latest.indexClose).toBe(1259.67);
    expect(latest.tradingValue).toBe(usd(9_957_995.69));
    expect(latest.avgDailyValue).toBe(usd(41_148.74));
    expect(latest.marketCap).toBe(usd(16_189_722.67));
    expect(latest.turnoverPct).toBe(56.2095727);
    expect(latest.listedCompanies).toBe(638);
    expect(latest.listedSecurities).toBe(2131);
    expect(latest.peRatio).toBe(15.44);
    expect(latest.pbvRatio).toBe(1.19);
    expect(latest.dividendYieldPct).toBe(3.71);
    // The `-` print is absent, never a zero P/E.
    expect(stats.years[0].peRatio).toBeUndefined();
  });

  it("merges the investor split, and only where the year is complete", async () => {
    stubFetch({
      STAT_SET_TH: SET_STATS_CSV,
      STAT_TRADINGVALUE: SET_INVESTOR_CSV,
    });
    const stats = await new SecThProvider().getExchangeKeyStats("SET");

    expect(stats.years[1].investors).toEqual({
      foreign: { net: usd(-100_000.5), sharePct: 52.4 },
      institution: { net: usd(55_000.25), sharePct: 13.1 },
      proprietary: { net: usd(12_000), sharePct: 9.8 },
    });
    // 2567 carries one class and no share, so it is left unannotated rather
    // than published as a partial split.
    expect(stats.years[0].investors).toBeUndefined();
  });

  it("matches mai's own index label and fetches no investor file", async () => {
    const fetchMock = stubFetch({ STAT_MAI_TH: MAI_STATS_CSV });
    const stats = await new SecThProvider().getExchangeKeyStats("mai");

    expect(stats.market).toBe("mai");
    expect(stats.years[0].indexClose).toBe(217.05);
    expect(stats.years[0].marketCap).toBe(usd(219_554.52));
    expect(stats.years[0].investors).toBeUndefined();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("STAT_TRADINGVALUE"))).toBe(false);
  });

  it("accepts the market case-insensitively", async () => {
    stubFetch({ STAT_MAI_TH: MAI_STATS_CSV });
    const stats = await new SecThProvider().getExchangeKeyStats("MAI");
    expect(stats.market).toBe("mai");
  });

  it("names the WAF block instead of parsing its page as CSV", async () => {
    stubFetch({ STAT_MAI_TH: WAF_REJECTION });
    await expect(
      new SecThProvider().getExchangeKeyStats("mai"),
    ).rejects.toThrow(/blocked by the upstream WAF/);
  });
});

describe("getBondMarketStats", () => {
  it("splits each item across the four segments", async () => {
    stubFetch({ STAT_DEPT_TH: BOND_CSV });
    const stats = await new SecThProvider().getBondMarketStats();

    expect(stats.asOf).toBe("2025-12-31");
    expect(stats.years.map((y) => y.year)).toEqual([2024, 2025]);
    const latest = stats.years[1];
    expect(latest.outstanding).toEqual({
      total: usd(18_175_072.2),
      government: usd(13_612_527.31),
      // The segment label carries a trailing space in this file too.
      corporate: usd(4_509_601.65),
    });
    // The `-` print leaves the segment absent rather than drawing a zero bar.
    expect(latest.outstanding.foreign).toBeUndefined();
    expect(latest.tradingValue.total).toBe(usd(21_958_275.22));
    expect(latest.avgDailyTradingValue).toBe(usd(90_736.67));
    expect(latest.registeredIssues).toEqual({ total: 2770, government: 471 });
  });

  it("reads the turnover block's self-named total and the English index rows", async () => {
    stubFetch({ STAT_DEPT_TH: BOND_CSV });
    const latest = (await new SecThProvider().getBondMarketStats()).years[1];

    expect(latest.turnoverPct.total).toBe(123.731286);
    expect(latest.turnoverPct.corporate).toBe(32.84517819);
    expect(latest.govTotalReturnIndex).toBe(364.158709);
    expect(latest.corpTotalReturnIndex).toBe(234.8998);
    expect(latest.avgGovYieldPct).toBe(2.034241);
    expect(latest.avgCorpYieldPct).toBe(2.46734);
  });

  it("translates the investor classes into English, in published order", async () => {
    stubFetch({ STAT_DEPT_TH: BOND_CSV });
    const latest = (await new SecThProvider().getBondMarketStats()).years[1];

    expect(latest.tradingShareByInvestor).toEqual([
      { label: "Retail", pct: 1.36 },
      { label: "Inter-dealer", pct: 34.82 },
      { label: "Others", pct: 2.41 },
    ]);
  });

  it("names the WAF block here too", async () => {
    stubFetch({ STAT_DEPT_TH: WAF_REJECTION });
    await expect(new SecThProvider().getBondMarketStats()).rejects.toThrow(
      /blocked by the upstream WAF/,
    );
  });
});

describe("getBondIssuance", () => {
  it("parses the Common-Era year and Qn quarter this one file uses", async () => {
    stubFetch({ OFFER_DEBT_COR_TH: ISSUANCE_CSV });
    const issuance = await new SecThProvider().getBondIssuance();

    // The as-of stamp is still Buddhist Era even though the year column is not.
    expect(issuance.asOf).toBe("2025-12-31");
    expect(issuance.periods.map((p) => p.period)).toEqual([
      "2024 Q4",
      "2025 Q1",
    ]);
    expect(new Date(issuance.periods[1].time).toISOString()).toBe(
      "2025-03-31T23:59:59.999Z",
    );
  });

  it("totals each quarter by issuer and by where it was offered", async () => {
    stubFetch({ OFFER_DEBT_COR_TH: ISSUANCE_CSV });
    const latest = (await new SecThProvider().getBondIssuance()).periods[1];

    expect(latest.corporate).toBeCloseTo(
      usd(165_576.82 + 50_000 + 8_000 + 1_000),
      3,
    );
    expect(latest.government).toBe(usd(400_000));
    expect(latest.total).toBeCloseTo(latest.corporate + latest.government, 3);
    expect(latest.domestic).toBeCloseTo(
      usd(165_576.82 + 50_000 + 1_000 + 400_000),
      3,
    );
    expect(latest.offshore).toBe(usd(8_000));
  });

  it("maps the instruments to English and keeps an unknown one in Thai", async () => {
    stubFetch({ OFFER_DEBT_COR_TH: ISSUANCE_CSV });
    const latest = (await new SecThProvider().getBondIssuance()).periods[1];

    expect(latest.byInstrument).toEqual({
      "Bills of exchange": usd(165_576.82),
      "Long-term debentures & bonds": usd(50_000),
      "Foreign-currency debentures": usd(8_000),
      หุ้นกู้ชนิดใหม่: usd(1_000),
    });
    // The `-` row contributes nothing at all, not a zero-height segment.
    expect(latest.byInstrument["Convertibles"]).toBeUndefined();
    // Government paper never enters the instrument breakdown.
    expect(Object.keys(latest.byInstrument)).toHaveLength(4);
  });

  it("names the WAF block here too", async () => {
    stubFetch({ OFFER_DEBT_COR_TH: WAF_REJECTION });
    await expect(new SecThProvider().getBondIssuance()).rejects.toThrow(
      /blocked by the upstream WAF/,
    );
  });
});
