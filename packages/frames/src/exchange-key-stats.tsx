import {
  defineFrame,
  useExchangeKeyStats,
  useMoney,
  type ExchangeYearStats,
  type Money,
} from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import {
  ABSENT,
  changeColor,
  formatCompact,
  formatLevel,
  formatPct,
} from "./format";
import { exchangeKeyStatsMeta } from "./schemas";
import { FrameStatus, scrollAreaXClass } from "./ui";

const schema = exchangeKeyStatsMeta.schema;

interface Row {
  label: string;
  /** `null` prints the greyed placeholder rather than a confident figure. */
  cell: (year: ExchangeYearStats, money: Money) => string | null;
  /** Semantic gain/loss tint, for the one row that has a direction. */
  tint?: (year: ExchangeYearStats) => string | undefined;
}

const ROWS: Row[] = [
  {
    label: "Index close",
    cell: (y) =>
      y.indexClose === undefined ? null : formatLevel(y.indexClose),
  },
  {
    label: "Market cap",
    cell: (y, money) =>
      y.marketCap === undefined ? null : money.compact(y.marketCap),
  },
  {
    label: "Trading value",
    cell: (y, money) =>
      y.tradingValue === undefined ? null : money.compact(y.tradingValue),
  },
  {
    label: "Avg daily value",
    cell: (y, money) =>
      y.avgDailyValue === undefined ? null : money.compact(y.avgDailyValue),
  },
  {
    label: "Turnover",
    cell: (y) =>
      y.turnoverPct === undefined ? null : formatPct(y.turnoverPct, 1),
  },
  {
    label: "Listed companies",
    cell: (y) =>
      y.listedCompanies === undefined ? null : formatCompact(y.listedCompanies),
  },
  {
    label: "P/E",
    cell: (y) => (y.peRatio === undefined ? null : formatLevel(y.peRatio)),
  },
  {
    label: "P/BV",
    cell: (y) => (y.pbvRatio === undefined ? null : formatLevel(y.pbvRatio)),
  },
  {
    label: "Dividend yield",
    cell: (y) =>
      y.dividendYieldPct === undefined
        ? null
        : formatPct(y.dividendYieldPct, 2),
  },
];

/** SET only — mai's publisher issues no investor split, so the row is appended. */
const FOREIGN_NET_ROW: Row = {
  label: "Foreign net",
  cell: (y, money) =>
    y.investors === undefined ? null : money.compact(y.investors.foreign.net),
  tint: (y) =>
    y.investors === undefined
      ? undefined
      : changeColor(y.investors.foreign.net),
};

function ExchangeKeyStats({ config }: { config: z.output<typeof schema> }) {
  const { stats, isLoading } = useExchangeKeyStats(config.market);
  const money = useMoney();

  const years = useMemo(
    () => (stats?.years ?? []).slice(-config.years),
    [stats, config.years],
  );
  const rows = useMemo(
    () =>
      years.some((year) => year.investors !== undefined)
        ? [...ROWS, FOREIGN_NET_ROW]
        : ROWS,
    [years],
  );

  if (isLoading)
    return <FrameStatus loading>loading exchange statistics…</FrameStatus>;
  if (years.length === 0)
    return <FrameStatus>no exchange statistics</FrameStatus>;

  const latest = years[years.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader>
        <CardHeader.Main>
          <CardHeader.Eyebrow>
            {stats?.market ?? config.market} · {latest.year}
          </CardHeader.Eyebrow>
          <CardHeader.Value
            size="metric-lg"
            absent={latest.indexClose === undefined}
          >
            {latest.indexClose === undefined
              ? ABSENT
              : formatLevel(latest.indexClose)}
          </CardHeader.Value>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Value absent={latest.marketCap === undefined}>
            {latest.marketCap === undefined
              ? ABSENT
              : money.compact(latest.marketCap)}
          </CardHeader.Value>
          <CardHeader.Sub>market cap</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div className={`${scrollAreaXClass} min-h-0 flex-1`}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="caption text-soft sticky left-0 py-1 pr-2 text-left font-normal uppercase">
                &nbsp;
              </th>
              {years.map((year) => (
                <th
                  key={year.year}
                  className="caption text-soft py-1 pl-2 text-right font-normal tabular-nums"
                >
                  {year.year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-white/[0.06]">
                <td
                  className="body-sm text-normal max-w-[9rem] truncate py-1 pr-2 font-semibold"
                  title={row.label}
                >
                  {row.label}
                </td>
                {years.map((year) => {
                  const text = row.cell(year, money);
                  return (
                    <td
                      key={year.year}
                      className={`body-sm py-1 pl-2 text-right tabular-nums ${
                        text === null ? "text-disabled" : "text-strong"
                      }`}
                      style={
                        text === null ? undefined : { color: row.tint?.(year) }
                      }
                    >
                      {text ?? ABSENT}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const exchangeKeyStatsFrame = defineFrame({
  ...exchangeKeyStatsMeta,
  component: ExchangeKeyStats,
});
