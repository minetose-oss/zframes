import type {
  BondIssuance,
  BondIssuancePeriod,
  BondMarketSplit,
  BondMarketStats,
  BondMarketYear,
  Capability,
  ExchangeKeyStats,
  ExchangeYearStats,
  FundAllocationBucket,
  FundIndustryAllocation,
  IndustryCap,
  IndustryCapPeriod,
  IndustryMarketCap,
  MarketDataProvider,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { parseCsvRows } from "@zframes/data-primitives/csv";
import { fetchText } from "@zframes/data-primitives/fetch";
import { usdRate } from "@zframes/data-primitives/fx-rate";

const INDUSTRY_CSV_URL =
  "https://dividend.sec.or.th/stat-report/STAT_INDUSTRY_TH.csv";
const FUND_CSV_URL = "https://dividend.sec.or.th/stat-report/MF_PORT_TH.csv";
const EXCHANGE_CSV_URL: Record<string, string> = {
  SET: "https://dividend.sec.or.th/stat-report/STAT_SET_TH.csv",
  mai: "https://dividend.sec.or.th/stat-report/STAT_MAI_TH.csv",
};
const SET_INVESTOR_CSV_URL =
  "https://dividend.sec.or.th/stat-report/STAT_TRADINGVALUE_SET_TH.csv";
const BOND_CSV_URL = "https://dividend.sec.or.th/stat-report/STAT_DEPT_TH.csv";
const BOND_ISSUANCE_CSV_URL =
  "https://dividend.sec.or.th/stat-report/OFFER_DEBT_COR_TH.csv";

/** Both files are restated quarterly, so half a day is already far finer than the source. */
const CACHE_TTL_MS = 12 * 60 * 60_000;
/** The industry file is ~100 KB and the host is slow under load. */
const FETCH_TIMEOUT_MS = 30_000;
/** Both files publish million THB. */
const MILLIONS = 1e6;
/** Buddhist Era is 543 years ahead of the Common Era. */
const BE_OFFSET = 543;

/**
 * The host sits behind an F5 WAF that answers this 246-byte HTML page with HTTP
 * 200 and `text/html` to any request carrying an `Origin` header — i.e. exactly
 * a browser's cross-origin fetch, and nothing else. The relay's own UA+Accept
 * passes, which is why both files are `proxied`. Without this check the page
 * parses as a one-row CSV and surfaces as "no data" rather than as the block it
 * is.
 */
function assertNotWafRejection(body: string, what: string): void {
  if (body.includes("<title>Request Rejected</title>"))
    throw new Error(
      `sec-th ${what}: blocked by the upstream WAF (a request carrying an Origin header is always rejected; it must go through the relay)`,
    );
}

/** Strip the UTF-8 BOM both files carry, so the first header cell matches. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * A published cell, or `null` when it is unreadable. Thousands separators are
 * removed and the publisher's `-` placeholder is a missing value, never a zero:
 * a zero would draw a real trough where there is only an absent print.
 */
function cellNumber(cell: string | undefined): number | null {
  const text = (cell ?? "").trim().replace(/,/g, "");
  if (text === "" || text === "-") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** `DD/MM/YYYY` in the Buddhist Era → an ISO Common-Era date, or null. */
function beDateToIso(cell: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((cell ?? "").trim());
  if (!match) return null;
  const [, day, month, beYear] = match;
  const year = Number(beYear) - BE_OFFSET;
  if (year < 1900 || year > 2200) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** A Buddhist-Era year cell → the Common-Era year, or null. */
function beYearToCe(cell: string | undefined): number | null {
  const beYear = cellNumber(cell);
  if (beYear === null) return null;
  const year = beYear - BE_OFFSET;
  return year >= 1900 && year <= 2200 ? year : null;
}

/** Epoch ms at the last instant of a calendar quarter, UTC. */
function quarterEndMs(year: number, quarter: number): number {
  return Date.UTC(year, quarter * 3, 0, 23, 59, 59, 999);
}

/**
 * Sector → industry group, as the SET publishes the hierarchy. Static because
 * the file itself carries no parent column: the two levels arrive in the same
 * column and are told apart only by membership here.
 */
const SECTOR_GROUP: Record<string, string> = {
  AGRI: "AGRO",
  FOOD: "AGRO",
  FASHION: "CONSUMP",
  HOME: "CONSUMP",
  PERSON: "CONSUMP",
  BANK: "FINCIAL",
  FIN: "FINCIAL",
  INSUR: "FINCIAL",
  AUTO: "INDUS",
  IMM: "INDUS",
  PAPER: "INDUS",
  PETRO: "INDUS",
  PKG: "INDUS",
  STEEL: "INDUS",
  CONMAT: "PROPCON",
  CONS: "PROPCON",
  PROP: "PROPCON",
  "PF&REIT": "PROPCON",
  ENERG: "RESOURC",
  MINE: "RESOURC",
  COMM: "SERVICE",
  HELTH: "SERVICE",
  MEDIA: "SERVICE",
  PROF: "SERVICE",
  TOURISM: "SERVICE",
  TRANS: "SERVICE",
  ETRON: "TECH",
  ICT: "TECH",
};

/** English display names for both levels; an unknown code keeps its code. */
const CODE_NAMES: Record<string, string> = {
  AGRO: "Agro & Food Industry",
  CONSUMP: "Consumer Products",
  FINCIAL: "Financials",
  INDUS: "Industrials",
  PROPCON: "Property & Construction",
  RESOURC: "Resources",
  SERVICE: "Services",
  TECH: "Technology",
  AGRI: "Agribusiness",
  FOOD: "Food & Beverage",
  FASHION: "Fashion",
  HOME: "Home & Office Products",
  PERSON: "Personal Products & Pharmaceuticals",
  BANK: "Banking",
  FIN: "Finance & Securities",
  INSUR: "Insurance",
  AUTO: "Automotive",
  IMM: "Industrial Materials & Machinery",
  PAPER: "Paper & Printing Materials",
  PETRO: "Petrochemicals & Chemicals",
  PKG: "Packaging",
  STEEL: "Steel & Metal Products",
  CONMAT: "Construction Materials",
  CONS: "Construction Services",
  PROP: "Property Development",
  "PF&REIT": "Property Funds & REITs",
  ENERG: "Energy & Utilities",
  MINE: "Mining",
  COMM: "Commerce",
  HELTH: "Health Care Services",
  MEDIA: "Media & Publishing",
  PROF: "Professional Services",
  TOURISM: "Tourism & Leisure",
  TRANS: "Transportation & Logistics",
  ETRON: "Electronic Components",
  ICT: "Information & Communication Technology",
};

const GROUP_CODES = new Set([
  "AGRO",
  "CONSUMP",
  "FINCIAL",
  "INDUS",
  "PROPCON",
  "RESOURC",
  "SERVICE",
  "TECH",
]);

function nameOf(code: string): string {
  return CODE_NAMES[code] ?? code;
}

/** One parsed row of the industry file, already normalised. */
interface IndustryRow {
  market: string;
  code: string;
  year: number;
  quarter: number;
  /** Million THB as published. */
  value: number;
}

function parseIndustryRows(csv: string): {
  rows: IndustryRow[];
  asOf: string | null;
} {
  const rows = parseCsvRows(stripBom(csv));
  const out: IndustryRow[] = [];
  let asOf: string | null = null;
  // Row 0 is the header.
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 6) continue;
    // Column 3 is "<CODE>   (Thai name)"; the code is its first token.
    const code = (cells[2] ?? "").trim().split(/\s+/)[0];
    const year = cellNumber(cells[3]);
    const quarter = cellNumber((cells[4] ?? "").replace(/[^\d]/g, ""));
    const value = cellNumber(cells[5]);
    if (!code || year === null || quarter === null || value === null) continue;
    if (asOf === null) asOf = beDateToIso(cells[0]);
    out.push({
      market: (cells[1] ?? "").trim().toUpperCase(),
      code,
      year,
      quarter,
      value,
    });
  }
  return { rows: out, asOf };
}

function periodLabel(year: number, quarter: number): string {
  return `${year} Q${quarter}`;
}

function parseIndustryMarketCap(
  csv: string,
  requested: string,
  thbPerUsd: number,
): IndustryMarketCap {
  const { rows, asOf } = parseIndustryRows(csv);
  // The file spells the second venue "MAI"; the contract reports it "mai".
  const wanted = requested.toUpperCase() === "MAI" ? "MAI" : "SET";
  const market = wanted === "MAI" ? "mai" : "SET";
  const mine = rows.filter((row) => row.market === wanted);
  if (mine.length === 0)
    throw new Error(`sec-th industry caps: no rows for market ${requested}`);

  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;

  // One entry per period, oldest → newest.
  const byPeriod = new Map<
    string,
    { year: number; quarter: number; byCode: Record<string, number> }
  >();
  for (const row of mine) {
    const key = periodLabel(row.year, row.quarter);
    let entry = byPeriod.get(key);
    if (!entry) {
      entry = { year: row.year, quarter: row.quarter, byCode: {} };
      byPeriod.set(key, entry);
    }
    entry.byCode[row.code] = toUsd(row.value);
  }
  const ordered = [...byPeriod.entries()].sort(
    (a, b) => a[1].year - b[1].year || a[1].quarter - b[1].quarter,
  );

  const history: IndustryCapPeriod[] = ordered.map(([period, entry]) => {
    const codes = Object.keys(entry.byCode);
    // Groups and sectors are both in `byCode`, so summing everything would
    // double-count wherever a market publishes both levels. Groups win; a
    // market that publishes only sectors (SET) sums those instead.
    const groupCodes = codes.filter((code) => GROUP_CODES.has(code));
    const summed = groupCodes.length > 0 ? groupCodes : codes;
    return {
      period,
      time: quarterEndMs(entry.year, entry.quarter),
      total: summed.reduce((sum, code) => sum + entry.byCode[code], 0),
      byCode: entry.byCode,
    };
  });

  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  const capOf = (code: string, group?: string): IndustryCap => {
    const prev = previous?.byCode[code];
    return {
      code,
      name: nameOf(code),
      ...(group ? { group } : {}),
      value: latest.byCode[code],
      ...(prev === undefined ? {} : { prev }),
    };
  };

  const latestCodes = Object.keys(latest.byCode);
  const sectors = latestCodes
    .filter((code) => !GROUP_CODES.has(code))
    .map((code) => capOf(code, SECTOR_GROUP[code]));
  const publishedGroups = latestCodes.filter((code) => GROUP_CODES.has(code));
  // SET publishes sectors only, mai publishes groups only. Rolling the sectors
  // up by the static parent map is what keeps the group level readable on both.
  const groups =
    publishedGroups.length > 0
      ? publishedGroups.map((code) => capOf(code))
      : rollUpToGroups(sectors);

  return {
    market,
    asOf: asOf ?? latest.period,
    period: latest.period,
    groups,
    sectors,
    history,
    source: "SEC Thailand",
  };
}

/** Sum sectors into their parent groups, carrying `prev` only where every child has one. */
function rollUpToGroups(sectors: IndustryCap[]): IndustryCap[] {
  const totals = new Map<string, { value: number; prev: number | null }>();
  for (const sector of sectors) {
    if (!sector.group) continue;
    const entry = totals.get(sector.group) ?? { value: 0, prev: 0 };
    entry.value += sector.value;
    entry.prev =
      entry.prev === null || sector.prev === undefined
        ? null
        : entry.prev + sector.prev;
    totals.set(sector.group, entry);
  }
  return [...totals.entries()].map(([code, entry]) => ({
    code,
    name: nameOf(code),
    value: entry.value,
    ...(entry.prev === null ? {} : { prev: entry.prev }),
  }));
}

/** Publisher's `type` column → the English bucket group. */
const FUND_GROUPS: Record<string, string> = {
  "หลักทรัพย์/ทรัพย์สินในประเทศที่จดทะเบียน": "Listed domestic",
  "หลักทรัพย์/ทรัพย์สินในประเทศที่อยู่นอกตลาด": "Unlisted domestic",
  "หลักทรัพย์/ทรัพย์สินต่างประเทศ": "Foreign",
  สินทรัพย์อื่น: "Other assets",
};

/** Publisher's `assetliab_desc` column → the English asset class. */
const FUND_CLASSES: Record<string, string> = {
  หุ้นสามัญ: "Common stock",
  หุ้นบุริมสิทธิ์: "Preferred stock",
  หน่วยลงทุน: "Fund units",
  "ใบแสดงสิทธิ/ใบสำคัญแสดงสิทธิ": "Warrants & rights",
  "หุ้นกู้/ตั๋วแลกเงิน/ตั๋วสัญญาใช้เงิน": "Corporate debt",
  "Euro Commercial Paper/Euro Medium Term Note": "ECP / EMTN",
  "ตั๋วเงินคลัง/พันธบัตร": "Government bonds & T-bills",
  ศุกูก: "Sukuk",
  สัญญาซื้อขายล่วงหน้า: "Derivatives",
  อสังหาริมทรัพย์: "Real estate",
  กองทรัสต์: "Trusts",
};

/** The deposits row spells out three instruments, so it is matched by prefix. */
const DEPOSITS_PREFIX = "เงินฝาก";
/** Net asset value AFTER netting out cross-holdings inside one asset manager. */
const NAV_AFTER_PREFIX = "มูลค่าทรัพย์สินสุทธิ (หลังหัก";

function fundClassLabel(desc: string): string | null {
  if (desc.startsWith(DEPOSITS_PREFIX)) return "Deposits";
  return FUND_CLASSES[desc] ?? null;
}

function parseFundAllocation(
  csv: string,
  thbPerUsd: number,
): FundIndustryAllocation {
  const rows = parseCsvRows(stripBom(csv));
  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;

  let asOf: string | null = null;
  let period: string | null = null;
  let totalNavMillions: number | null = null;
  const raw: { group: string; label: string; millions: number }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 6) continue;
    const type = (cells[1] ?? "").trim();
    const desc = (cells[2] ?? "").trim();
    const value = cellNumber(cells[5]);
    if (value === null) continue;
    if (asOf === null) asOf = beDateToIso(cells[0]);
    if (period === null) {
      // Unlike the industry file, the year column here is Buddhist Era.
      const beYear = cellNumber(cells[3]);
      const quarter = cellNumber((cells[4] ?? "").replace(/[^\d]/g, ""));
      if (beYear !== null && quarter !== null)
        period = periodLabel(beYear - BE_OFFSET, quarter);
    }
    if (type.startsWith(NAV_AFTER_PREFIX)) {
      totalNavMillions = value;
      continue;
    }
    const group = FUND_GROUPS[type];
    if (!group) continue;
    // "Other assets" is one bucket with no class breakdown; everything else
    // needs a translatable class. A zero or negative row (the derivatives
    // legs net short) is not an allocation and is dropped.
    const label = group === "Other assets" ? group : fundClassLabel(desc);
    if (!label || value <= 0) continue;
    raw.push({ group, label, millions: value });
  }

  if (totalNavMillions === null || totalNavMillions <= 0)
    throw new Error(
      "sec-th fund allocation: no net-asset-value row (มูลค่าทรัพย์สินสุทธิ หลังหัก…) in the published file",
    );
  if (raw.length === 0)
    throw new Error("sec-th fund allocation: no usable allocation rows");

  const totalNav = toUsd(totalNavMillions);
  const buckets: FundAllocationBucket[] = raw.map((entry) => ({
    group: entry.group,
    label: entry.label,
    value: toUsd(entry.millions),
    sharePct: (entry.millions / totalNavMillions) * 100,
  }));

  return {
    asOf: asOf ?? period ?? "",
    period: period ?? "",
    totalNav,
    buckets,
    source: "SEC Thailand",
  };
}

/**
 * Publisher's `รายการ` label → the field it fills. Every label in these files
 * may carry a TRAILING SPACE on some rows and not others (the 2568 prints of
 * `ราคาปิดต่อมูลค่าหุ้นตามบัญชี (เท่า)` lost theirs mid-file), so every lookup
 * here is against a trimmed key.
 */
const EXCHANGE_STAT_FIELDS: Record<
  string,
  | "tradingValue"
  | "avgDailyValue"
  | "turnoverPct"
  | "marketCap"
  | "listedCompanies"
  | "listedSecurities"
  | "peRatio"
  | "pbvRatio"
  | "dividendYieldPct"
> = {
  "มูลค่าซื้อขายทั้งหมด (ล้านบาท)": "tradingValue",
  "มูลค่าซื้อขายเฉลี่ยต่อวัน (ล้านบาท)": "avgDailyValue",
  "อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ)": "turnoverPct",
  "มูลค่าหลักทรัพย์ตามราคาตลาด (ล้านบาท)": "marketCap",
  จำนวนบริษัทจดทะเบียน: "listedCompanies",
  จำนวนหลักทรัพย์จดทะเบียน: "listedSecurities",
  "ราคาปิดต่อกำไรต่อหุ้น (เท่า)": "peRatio",
  "ราคาปิดต่อมูลค่าหุ้นตามบัญชี (เท่า)": "pbvRatio",
  "อัตราเงินปันผลตอบแทน (ร้อยละ)": "dividendYieldPct",
};

/** Which of those arrive as million THB rather than a ratio, a count or a percent. */
const EXCHANGE_MONEY_FIELDS = new Set([
  "tradingValue",
  "avgDailyValue",
  "marketCap",
]);

/**
 * The index row is the one line whose label is venue-specific — SET spells it
 * `…ตลาดหลักทรัพย์แห่งประเทศไทย` and mai `…ตลาดหลักทรัพย์ เอ็ม เอ ไอ` — so it
 * is matched by the word "index" the two share rather than by either spelling.
 */
const INDEX_LABEL_MARK = "ดัชนี";

/** Publisher's `ประเภทผู้ลงทุน` column → the investor class it reports. */
const INVESTOR_CLASSES: Record<
  string,
  "foreign" | "institution" | "proprietary"
> = {
  ผู้ลงทุนต่างประเทศ: "foreign",
  ผู้ลงทุนสถาบันในประเทศ: "institution",
  บัญชีบริษัทหลักทรัพย์: "proprietary",
};

/** Net bought/sold over the year, million THB. */
const INVESTOR_NET_ITEM = "มูลค่าซื้อขายสุทธิ";
/** That class's share of the year's gross turnover, percent. */
const INVESTOR_SHARE_ITEM = "สัดส่วนมูลค่าซื้อขายรวม (ร้อยละ)";

function parseExchangeKeyStats(
  csv: string,
  market: string,
  thbPerUsd: number,
): { asOf: string | null; byYear: Map<number, ExchangeYearStats> } {
  const rows = parseCsvRows(stripBom(csv));
  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;
  const byYear = new Map<number, ExchangeYearStats>();
  let asOf: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 4) continue;
    const item = (cells[1] ?? "").trim();
    const year = beYearToCe(cells[2]);
    const value = cellNumber(cells[3]);
    if (!item || year === null || value === null) continue;
    const entry = byYear.get(year) ?? { year };
    if (item.includes(INDEX_LABEL_MARK)) {
      entry.indexClose = value;
    } else {
      const field = EXCHANGE_STAT_FIELDS[item];
      if (!field) continue;
      entry[field] = EXCHANGE_MONEY_FIELDS.has(field) ? toUsd(value) : value;
    }
    if (asOf === null) asOf = beDateToIso(cells[0]);
    byYear.set(year, entry);
  }

  if (byYear.size === 0)
    throw new Error(`sec-th exchange key stats: no rows for market ${market}`);
  return { asOf, byYear };
}

/** One investor class's year: net bought/sold in USD, and its share of turnover. */
interface Flow {
  net: number;
  sharePct: number;
}

const INVESTOR_ORDER = ["foreign", "institution", "proprietary"] as const;

/**
 * Attach the per-year investor split the publisher issues for SET only. The
 * three classes are reported as one document each, so a year is only annotated
 * once all three carry both a net and a share.
 */
function mergeInvestorFlows(
  csv: string,
  byYear: Map<number, ExchangeYearStats>,
  thbPerUsd: number,
): void {
  const rows = parseCsvRows(stripBom(csv));
  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;
  type Partials = Partial<
    Record<"foreign" | "institution" | "proprietary", Partial<Flow>>
  >;
  const pending = new Map<number, Partials>();

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 5) continue;
    const item = (cells[1] ?? "").trim();
    const investor = INVESTOR_CLASSES[(cells[2] ?? "").trim()];
    const year = beYearToCe(cells[3]);
    const value = cellNumber(cells[4]);
    if (!investor || year === null || value === null) continue;
    const entry = pending.get(year) ?? {};
    const flow = entry[investor] ?? {};
    if (item === INVESTOR_NET_ITEM) flow.net = toUsd(value);
    else if (item === INVESTOR_SHARE_ITEM) flow.sharePct = value;
    else continue;
    entry[investor] = flow;
    pending.set(year, entry);
  }

  for (const [year, entry] of pending) {
    const stats = byYear.get(year);
    if (!stats) continue;
    const flows = INVESTOR_ORDER.map((investor) => entry[investor]);
    if (
      flows.some(
        (flow) => flow?.net === undefined || flow.sharePct === undefined,
      )
    )
      continue;
    stats.investors = Object.fromEntries(
      INVESTOR_ORDER.map((investor, i) => [investor, flows[i] as Flow]),
    ) as ExchangeYearStats["investors"];
  }
}

/** Publisher's `ประเภท` column → the slice of the bond market it reports. */
const BOND_SEGMENTS: Record<string, keyof BondMarketSplit> = {
  ยอดรวม: "total",
  ตราสารหนี้ภาครัฐ: "government",
  ตราสารหนี้ภาคเอกชน: "corporate",
  พันธบัตรต่างประเทศ: "foreign",
  // The turnover block repeats its own item name where the others say "total".
  อัตราการหมุนเวียนของการซื้อขาย: "total",
};

/** The four items published across all four segments. */
const BOND_SPLIT_ITEMS: Record<
  string,
  "outstanding" | "tradingValue" | "turnoverPct" | "registeredIssues"
> = {
  "มูลค่าหลักทรัพย์ขึ้นทะเบียนคงค้าง (ล้านบาท)": "outstanding",
  "มูลค่าซื้อขาย (ล้านบาท)": "tradingValue",
  "อัตราการหมุนเวียนของการซื้อขาย (ร้อยละ)": "turnoverPct",
  จำนวนหลักทรัพย์ขึ้นทะเบียน: "registeredIssues",
};

/** Which of those are million THB rather than a percent or a count. */
const BOND_MONEY_SPLITS = new Set(["outstanding", "tradingValue"]);

const BOND_AVG_DAILY_ITEM = "มูลค่าซื้อขายเฉลี่ยต่อวัน (ล้านบาท)";
const BOND_SHARE_ITEM = "สัดส่วนมูลค่าซื้อขาย (ร้อยละ)";
const BOND_INDEX_ITEM = "Bond Index";

/** Publisher's investor classes for the traded-share block, in published order. */
const BOND_INVESTOR_LABELS: Record<string, string> = {
  รายย่อย: "Retail",
  กองทุนรวม: "Mutual funds",
  บริษัทประกัน: "Insurers",
  บริษัทในประเทศ: "Domestic companies",
  บริษัทต่างประเทศ: "Foreign companies",
  ระหว่างผู้ค้าตราสารหนี้: "Inter-dealer",
  สถาบันการเงินที่ไม่มีใบอนุญาตค้าตราสารหนี้:
    "Non-dealer financial institutions",
  "อื่น ๆ": "Others",
};

/** The `Bond Index` block's own four types; already English in the file. */
const BOND_INDEX_FIELDS: Record<
  string,
  | "govTotalReturnIndex"
  | "corpTotalReturnIndex"
  | "avgGovYieldPct"
  | "avgCorpYieldPct"
> = {
  "Government Bond Total Return Index": "govTotalReturnIndex",
  "MTM Corporate Bond Total Return Index": "corpTotalReturnIndex",
  "Average Government Bond Yield (ร้อยละ)": "avgGovYieldPct",
  "Average MTM Corporate Bond Yield (ร้อยละ)": "avgCorpYieldPct",
};

function emptyBondYear(year: number): BondMarketYear {
  return {
    year,
    outstanding: {},
    tradingValue: {},
    turnoverPct: {},
    registeredIssues: {},
    tradingShareByInvestor: [],
  };
}

function parseBondMarketStats(csv: string, thbPerUsd: number): BondMarketStats {
  const rows = parseCsvRows(stripBom(csv));
  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;
  const byYear = new Map<number, BondMarketYear>();
  let asOf: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 5) continue;
    const item = (cells[1] ?? "").trim();
    const type = (cells[2] ?? "").trim();
    const year = beYearToCe(cells[3]);
    const value = cellNumber(cells[4]);
    if (!item || year === null || value === null) continue;
    const entry = byYear.get(year) ?? emptyBondYear(year);

    const split = BOND_SPLIT_ITEMS[item];
    const investorLabel = BOND_INVESTOR_LABELS[type];
    if (split) {
      const segment = BOND_SEGMENTS[type];
      if (!segment) continue;
      entry[split][segment] = BOND_MONEY_SPLITS.has(split)
        ? toUsd(value)
        : value;
    } else if (item === BOND_AVG_DAILY_ITEM) {
      entry.avgDailyTradingValue = toUsd(value);
    } else if (item === BOND_SHARE_ITEM && investorLabel) {
      entry.tradingShareByInvestor.push({ label: investorLabel, pct: value });
    } else if (item === BOND_INDEX_ITEM) {
      const field = BOND_INDEX_FIELDS[type];
      if (!field) continue;
      entry[field] = value;
    } else continue;

    if (asOf === null) asOf = beDateToIso(cells[0]);
    byYear.set(year, entry);
  }

  if (byYear.size === 0)
    throw new Error("sec-th bond market stats: no usable rows");
  return {
    asOf: asOf ?? "",
    years: [...byYear.values()].sort((a, b) => a.year - b.year),
    source: "SEC Thailand",
  };
}

/** Publisher's `invest_type` column → the English instrument name. */
const ISSUANCE_INSTRUMENTS: Record<string, string> = {
  ตั๋วเงิน: "Bills of exchange",
  หุ้นกู้ระยะสั้น: "Short-term debentures",
  "หุ้นกู้ระยะยาว / พันธบัตรระยะยาว": "Long-term debentures & bonds",
  หุ้นกู้สกุลเงินต่างประเทศ: "Foreign-currency debentures",
  "ตราสารเงินกองทุน (Basel)": "Basel capital instruments",
  "ตราสารด้อยสิทธิเพื่อนับเป็นเงินกองทุนของบริษัทประกันภัย (IC Bond)":
    "Insurer capital bonds",
  "หุ้นกู้ Securitization": "Securitisation",
  หุ้นกู้อนุพันธ์: "Structured notes",
  หุ้นกู้แปลงสภาพ: "Convertibles",
};

const ISSUANCE_CORPORATE = "1.ตราสารหนี้ภาคเอกชน";
const ISSUANCE_DOMESTIC = "1.ในประเทศ";
const ISSUANCE_OFFSHORE = "2.ต่างประเทศ";

function parseBondIssuance(csv: string, thbPerUsd: number): BondIssuance {
  const rows = parseCsvRows(stripBom(csv));
  const toUsd = (millionThb: number) => (millionThb * MILLIONS) / thbPerUsd;
  const byPeriod = new Map<string, BondIssuancePeriod>();
  let asOf: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 8) continue;
    const bondType = (cells[1] ?? "").trim();
    const country = (cells[2] ?? "").trim();
    const instrument = (cells[4] ?? "").trim();
    // Unlike every other file on this host, THIS year column is already
    // Common Era and its quarter is spelled "Q1".
    const year = cellNumber(cells[5]);
    const quarter = Number(/^Q([1-4])$/.exec((cells[6] ?? "").trim())?.[1]);
    const value = cellNumber(cells[7]);
    if (year === null || !Number.isFinite(quarter) || value === null) continue;
    if (asOf === null) asOf = beDateToIso(cells[0]);

    const period = periodLabel(year, quarter);
    let entry = byPeriod.get(period);
    if (!entry) {
      entry = {
        period,
        time: quarterEndMs(year, quarter),
        total: 0,
        corporate: 0,
        government: 0,
        domestic: 0,
        offshore: 0,
        byInstrument: {},
      };
      byPeriod.set(period, entry);
    }

    const usd = toUsd(value);
    const corporate = bondType === ISSUANCE_CORPORATE;
    entry.total += usd;
    if (corporate) entry.corporate += usd;
    else entry.government += usd;
    if (country === ISSUANCE_DOMESTIC) entry.domestic += usd;
    else if (country === ISSUANCE_OFFSHORE) entry.offshore += usd;
    // Instrument is a corporate-only breakdown: the government rows repeat one
    // bond type, so mixing them in would draw a bar nobody published. An
    // unmapped instrument keeps its Thai label rather than vanishing.
    if (corporate) {
      const label = ISSUANCE_INSTRUMENTS[instrument] ?? instrument;
      entry.byInstrument[label] = (entry.byInstrument[label] ?? 0) + usd;
    }
  }

  if (byPeriod.size === 0)
    throw new Error("sec-th bond issuance: no usable rows");
  // `time` is the quarter end, so it orders the periods on its own.
  const periods = [...byPeriod.values()].sort((a, b) => a.time - b.time);

  return { asOf: asOf ?? "", periods, source: "SEC Thailand" };
}

const industryCache = new TtlCache<IndustryMarketCap>({
  namespace: "zframes:sec-th:industry",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

const fundCache = new TtlCache<FundIndustryAllocation>({
  namespace: "zframes:sec-th:fund-port",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

const exchangeStatsCache = new TtlCache<ExchangeKeyStats>({
  namespace: "zframes:sec-th:exchange-stats",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

const bondMarketCache = new TtlCache<BondMarketStats>({
  namespace: "zframes:sec-th:bond-market",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

const bondIssuanceCache = new TtlCache<BondIssuance>({
  namespace: "zframes:sec-th:bond-issuance",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

/**
 * Free, no-API-key provider for the two statistics CSVs SEC Thailand publishes
 * on `dividend.sec.or.th`: the SET/mai market capitalisation by industry group
 * and sector (back to 2020 Q1), and the mutual-fund industry's asset allocation
 * for the latest quarter. Both are published in million THB and converted to
 * USD on the way out, since every capability here is denominated in USD.
 *
 * Both files are proxied: the host's WAF rejects any request carrying an
 * `Origin` header, so a browser can only reach them through the runtime's
 * same-origin relay, and they degrade to empty on a static host.
 *
 * The same host also publishes the two exchanges' key statistics by year
 * (`exchange-key-stats`, with SET's investor split merged in from a second
 * file), the bond market's own statistics by year (`bond-market-stats`) and
 * bond issuance by quarter (`bond-issuance`).
 *
 * Provides `industry-market-cap`, `fund-industry-allocation`,
 * `exchange-key-stats`, `bond-market-stats` and `bond-issuance`.
 */
export class SecThProvider implements MarketDataProvider {
  readonly name = "sec-th";
  readonly capabilities: readonly Capability[] = [
    "industry-market-cap",
    "fund-industry-allocation",
    "exchange-key-stats",
    "bond-market-stats",
    "bond-issuance",
  ];

  async getIndustryMarketCap(market = "SET"): Promise<IndustryMarketCap> {
    const key = market.toUpperCase() === "MAI" ? "mai" : "SET";
    return industryCache.get(key, async () => {
      // One rate for every period: this is a composition view, so the whole
      // history is read in today's dollars rather than each quarter in its own.
      const [csv, thbPerUsd] = await Promise.all([
        fetchText(INDUSTRY_CSV_URL, {
          proxied: true,
          timeoutMs: FETCH_TIMEOUT_MS,
        }),
        usdRate("THB"),
      ]);
      assertNotWafRejection(csv, "industry caps");
      return parseIndustryMarketCap(csv, key, thbPerUsd);
    });
  }

  async getFundIndustryAllocation(): Promise<FundIndustryAllocation> {
    return fundCache.get("latest", async () => {
      const [csv, thbPerUsd] = await Promise.all([
        fetchText(FUND_CSV_URL, {
          proxied: true,
          timeoutMs: FETCH_TIMEOUT_MS,
        }),
        usdRate("THB"),
      ]);
      assertNotWafRejection(csv, "fund allocation");
      return parseFundAllocation(csv, thbPerUsd);
    });
  }

  async getExchangeKeyStats(market = "SET"): Promise<ExchangeKeyStats> {
    const key = market.toUpperCase() === "MAI" ? "mai" : "SET";
    return exchangeStatsCache.get(key, async () => {
      // One rate for the whole table, as the industry view does: these are
      // composition figures read in today's dollars, not each year in its own.
      const [csv, thbPerUsd] = await Promise.all([
        fetchText(EXCHANGE_CSV_URL[key], {
          proxied: true,
          timeoutMs: FETCH_TIMEOUT_MS,
        }),
        usdRate("THB"),
      ]);
      assertNotWafRejection(csv, "exchange key stats");
      const { asOf, byYear } = parseExchangeKeyStats(csv, key, thbPerUsd);
      // The investor split is published for the main board only.
      if (key === "SET") {
        const investorCsv = await fetchText(SET_INVESTOR_CSV_URL, {
          proxied: true,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
        assertNotWafRejection(investorCsv, "exchange investor flows");
        mergeInvestorFlows(investorCsv, byYear, thbPerUsd);
      }
      return {
        market: key,
        asOf: asOf ?? "",
        years: [...byYear.values()].sort((a, b) => a.year - b.year),
        source: "SEC Thailand",
      };
    });
  }

  async getBondMarketStats(): Promise<BondMarketStats> {
    return bondMarketCache.get("latest", async () => {
      const [csv, thbPerUsd] = await Promise.all([
        fetchText(BOND_CSV_URL, { proxied: true, timeoutMs: FETCH_TIMEOUT_MS }),
        usdRate("THB"),
      ]);
      assertNotWafRejection(csv, "bond market stats");
      return parseBondMarketStats(csv, thbPerUsd);
    });
  }

  async getBondIssuance(): Promise<BondIssuance> {
    return bondIssuanceCache.get("latest", async () => {
      const [csv, thbPerUsd] = await Promise.all([
        fetchText(BOND_ISSUANCE_CSV_URL, {
          proxied: true,
          timeoutMs: FETCH_TIMEOUT_MS,
        }),
        usdRate("THB"),
      ]);
      assertNotWafRejection(csv, "bond issuance");
      return parseBondIssuance(csv, thbPerUsd);
    });
  }
}
