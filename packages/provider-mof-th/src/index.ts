import type {
  Capability,
  MarketDataProvider,
  NationalDebt,
  NationalDebtComponent,
  NationalDebtPoint,
} from "@zframes/spec";
import { TtlCache } from "@zframes/data-primitives/cache";
import { parseCsvRows } from "@zframes/data-primitives/csv";
import { fetchText } from "@zframes/data-primitives/fetch";

const PUBLIC_DEBT_CSV_URL =
  "https://dataservices.mof.go.th/export/csv/menu5?id=4";

/** Republished once a month, so a reload inside half a day reuses the file. */
const CACHE_TTL_MS = 12 * 60 * 60_000;

/** Thai month names as the ministry spells them, in calendar order. */
const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

/** Buddhist Era runs 543 years ahead of the Gregorian calendar. */
const BE_OFFSET = 543;

/**
 * English wording for the ministry's five top-level lines, keyed by the numeric
 * prefix the file itself carries. Keyed by number rather than by the Thai label
 * on purpose: row 5 is published with a typo (หนื้ for หนี้), so a text match
 * would drop a component the moment the ministry fixes its own spelling.
 */
const COMPONENT_LABELS: Record<number, string> = {
  1: "Government debt",
  2: "State-enterprise debt",
  3: "Financial state-enterprise debt (guaranteed)",
  4: "FIDF debt",
  5: "Other government agencies",
};

const TOP_LEVEL_ROW = /^\s*([1-5])\.(?!\d)/;
const DEBT_TO_GDP_ROW = /debt\s*:\s*gdp/i;
const FX_RATE_ROW = /อัตราแลกเปลี่ยน/;

/** The ministry publishes every amount in MILLIONS of baht. */
const MILLION = 1e6;

interface Column {
  /** ISO date of the month's last day, e.g. "2026-02-28". */
  date: string;
  time: number;
}

/** "1,048,955.88" → 1048955.88; anything unreadable → null. */
function amount(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const value = Number(cell.replace(/,/g, "").trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * `"กุมภาพันธ์ 2569"` → the last day of that month. The header carries a Thai
 * month name and a Buddhist-era year, and the figure is a month-end stock, so
 * the column's date is the month's close rather than its first day.
 */
function parseMonthColumn(header: string): Column | null {
  const match = /^\s*(\S+)\s+(\d{4})\s*$/.exec(header);
  if (!match) return null;
  const month = THAI_MONTHS.indexOf(match[1]);
  if (month === -1) return null;
  const year = Number(match[2]) - BE_OFFSET;
  // Day 0 of the FOLLOWING month is the last day of this one, leap years included.
  const time = Date.UTC(year, month + 1, 0);
  return { date: new Date(time).toISOString().slice(0, 10), time };
}

function parse(csv: string): NationalDebt {
  // The export is UTF-8 with a BOM; left in place it becomes part of the first
  // header cell and nothing downstream would notice.
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ""));
  const header = rows[0];
  if (!header || header.length < 2)
    throw new Error("mof-th public debt: no month columns in the CSV header");

  const columns: (Column | null)[] = header.map((cell, index) =>
    index === 0 ? null : parseMonthColumn(cell),
  );
  const monthIndices = columns
    .map((column, index) => (column ? index : -1))
    .filter((index) => index !== -1);
  if (monthIndices.length === 0)
    throw new Error(
      "mof-th public debt: no readable Thai month column headers",
    );

  const components = new Map<number, string[]>();
  let rateRow: string[] | undefined;
  let gdpRow: string[] | undefined;
  for (const row of rows.slice(1)) {
    const label = row[0] ?? "";
    const topLevel = TOP_LEVEL_ROW.exec(label);
    if (topLevel) {
      // First occurrence wins: the file repeats a section number in its
      // footnotes, and the summary line is the one that comes first.
      if (!components.has(Number(topLevel[1])))
        components.set(Number(topLevel[1]), row);
      continue;
    }
    if (!rateRow && FX_RATE_ROW.test(label)) rateRow = row;
    else if (!gdpRow && DEBT_TO_GDP_ROW.test(label)) gdpRow = row;
  }

  const missing = [1, 2, 3, 4, 5].filter((n) => !components.has(n));
  if (missing.length > 0)
    throw new Error(
      `mof-th public debt: missing top-level row(s) ${missing.join(", ")}`,
    );
  if (!rateRow)
    throw new Error(
      "mof-th public debt: missing the published THB/USD rate row — every figure here is baht",
    );
  if (!gdpRow)
    throw new Error("mof-th public debt: missing the Debt : GDP (%) row");

  const trend: NationalDebtPoint[] = [];
  // Columns run newest → oldest in the file; a trend reads the other way.
  for (const index of [...monthIndices].reverse()) {
    const rate = amount(rateRow[index]);
    if (rate === null || rate <= 0) continue;
    let millionThb = 0;
    for (const row of components.values()) {
      const value = amount(row[index]);
      if (value === null) continue;
      millionThb += value;
    }
    const column = columns[index]!;
    trend.push({
      time: column.time,
      date: column.date,
      total: (millionThb * MILLION) / rate,
    });
  }
  if (trend.length === 0)
    throw new Error("mof-th public debt: no column carried a usable rate");

  const latest = monthIndices[0];
  const latestRate = amount(rateRow[latest])!;
  const breakdown: NationalDebtComponent[] = [];
  for (const [number, row] of [...components.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const value = amount(row[latest]);
    // A zero line is a component the ministry currently reports as retired
    // (the FIDF's is 0.00), and a tile reading zero is noise, not data.
    if (value === null || value === 0) continue;
    breakdown.push({
      label: COMPONENT_LABELS[number],
      value: (value * MILLION) / latestRate,
    });
  }

  const debt: NationalDebt = {
    date: trend[trend.length - 1].date,
    total: trend[trend.length - 1].total,
    breakdown,
    trend,
  };
  const debtToGdpPct = amount(gdpRow[latest]);
  if (debtToGdpPct !== null) debt.debtToGdpPct = debtToGdpPct;
  return debt;
}

const debtCache = new TtlCache<NationalDebt>({
  namespace: "zframes:mof-th:public-debt",
  ttlMs: CACHE_TTL_MS,
  persist: true,
});

/**
 * Free, no-API-key provider for Thailand's Ministry of Finance public-debt
 * release — the national counterpart of the US Treasury's "Debt to the Penny",
 * serving the `national-debt` capability. The ministry splits its debt its own
 * way (government, state enterprises, financial state enterprises, the FIDF,
 * other agencies), so the US public/intragovernmental pair stays undefined and
 * the split arrives as `breakdown`.
 *
 * Amounts are published in millions of baht and converted at the rate the
 * ministry states in the same file, per column — its own rate, not a market
 * one, which is what keeps the total consistent with the Debt : GDP figure
 * beside it. The host is CORS-blocked, so the browser path goes through the
 * runtime's same-origin relay and the frames degrade to empty on a static host.
 */
export class MofThProvider implements MarketDataProvider {
  readonly name = "mof-th";
  readonly capabilities: readonly Capability[] = ["national-debt"];

  /**
   * The capability's `days` argument is accepted at the call site and has no
   * effect here, which is why it is not even named: the ministry's export
   * carries three month-end columns and offers no window parameter, so there is
   * nothing to widen or narrow. Every caller gets the same three points.
   */
  async getNationalDebt(): Promise<NationalDebt> {
    return debtCache.get("latest", () =>
      fetchText(PUBLIC_DEBT_CSV_URL, {
        proxied: true,
        timeoutMs: 15_000,
      }).then(parse),
    );
  }
}
