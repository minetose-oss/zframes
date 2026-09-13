import type { ReactNode } from "react";
import { SliceLegend } from "./slice-legend";

/**
 * A column per period, each column stacked out of the same named series.
 *
 * `BarChart` in `@zframes/charts` draws one value per category and
 * `StackedAreaChart` draws a continuous surface — neither renders "this year's
 * total, split three ways", which is how every composition-over-time statistic
 * a national publisher releases arrives. Two frames need exactly that
 * (`bond-market-stats`, `bond-issuance-bars`), so the column lives here rather
 * than twice.
 *
 * Heights are CSS percentages of the tallest period, so the whole thing
 * compresses with the card instead of needing a measured plot box — the same
 * reason the share bars in `metal-cot-concentration` are divs.
 */

export interface StackedSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackedPeriod {
  label: string;
  /** Per series key; a missing or non-positive entry contributes no segment. */
  values: Record<string, number>;
}

export function StackedBars({
  periods,
  series,
  formatTotal,
  caption,
}: {
  periods: StackedPeriod[];
  series: StackedSeries[];
  /** Renders the figure printed above each column. */
  formatTotal: (total: number) => string;
  caption?: ReactNode;
}) {
  const totals = periods.map((period) =>
    series.reduce((sum, s) => sum + Math.max(0, period.values[s.key] ?? 0), 0),
  );
  const peak = Math.max(...totals, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-h-0 flex-1 items-end gap-1">
        {periods.map((period, i) => (
          <div
            key={period.label}
            className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1"
            title={`${period.label} · ${formatTotal(totals[i])}`}
          >
            <div className="caption text-soft truncate text-center tabular-nums">
              {formatTotal(totals[i])}
            </div>
            <div
              className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
              style={{ height: `${peak > 0 ? (totals[i] / peak) * 100 : 0}%` }}
            >
              {series.map((s) => {
                const value = Math.max(0, period.values[s.key] ?? 0);
                if (value <= 0) return null;
                return (
                  <div
                    key={s.key}
                    style={{
                      height: `${(value / totals[i]) * 100}%`,
                      background: s.color,
                    }}
                  />
                );
              })}
            </div>
            <div className="caption text-soft truncate text-center">
              {period.label}
            </div>
          </div>
        ))}
      </div>
      <SliceLegend size="sm">
        {series.map((s) => (
          <SliceLegend.Item key={s.key} color={s.color} label={s.label} />
        ))}
      </SliceLegend>
      {caption !== undefined && (
        <div className="caption text-soft text-center">{caption}</div>
      )}
    </div>
  );
}
