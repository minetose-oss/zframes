import { MiniLineChart } from "@zframes/charts";
import { defineFrame, useNationalDebt } from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { formatCompactUsd, formatPct } from "./format";
import { nationalDebtMeta } from "./schemas";
import { Stat } from "./stat";
import { FrameStatus } from "./ui";

const schema = nationalDebtMeta.schema;

const DAY_MS = 86_400_000;

/**
 * How often this publisher prints, read off the trend rather than hardcoded:
 * the US Treasury posts each business day, a finance ministry monthly, and the
 * caption must not claim a freshness the data does not have.
 */
function cadenceOf(times: number[]): string {
  if (times.length < 2) return "";
  const span = times[times.length - 1] - times[0];
  return span / (times.length - 1) / DAY_MS > 20 ? "monthly" : "daily";
}

function SplitTiles({ lines }: { lines: { label: string; value: number }[] }) {
  return (
    <Stat.Strip
      cols={2}
      gap={1.5}
      className="border-t border-white/[0.08] pt-2"
    >
      {lines.map((line) => (
        <Stat key={line.label} surface="tile">
          <Stat.Label>{line.label}</Stat.Label>
          <Stat.Value>{formatCompactUsd(line.value)}</Stat.Value>
        </Stat>
      ))}
    </Stat.Strip>
  );
}

function NationalDebt({ config }: { config: z.output<typeof schema> }) {
  const { debt, isLoading } = useNationalDebt(
    config.trendDays,
    undefined,
    config.source,
  );

  const sparkline = useMemo(
    () =>
      (debt?.trend ?? []).map((point) => ({
        date: new Date(point.time).toISOString(),
        value: point.total,
      })),
    [debt?.trend],
  );

  if (isLoading)
    return <FrameStatus loading>loading national debt…</FrameStatus>;
  if (!debt) return <FrameStatus>no debt data yet</FrameStatus>;

  const first = debt.trend[0];
  const change = first ? debt.total - first.total : null;
  const cadence = cadenceOf(debt.trend.map((point) => point.time));
  // The publisher's own split, whichever shape it takes: the US pair, or the
  // components a ministry that splits its debt some other way reports. A
  // publisher with neither drops the row rather than printing two dashes.
  const split: { label: string; value: number }[] =
    debt.breakdown && debt.breakdown.length > 0
      ? debt.breakdown.slice(0, 5)
      : debt.heldByPublic !== undefined && debt.intragovernmental !== undefined
        ? [
            { label: "Held by public", value: debt.heldByPublic },
            { label: "Intragovernmental", value: debt.intragovernmental },
          ]
        : [];

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-3">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>total public debt</CardHeader.Eyebrow>
          {/* `ink="normal"`, not the sub-line's default `soft`: the
              publisher's own print date reads as data here. */}
          <CardHeader.Sub ink="normal">as of {debt.date}</CardHeader.Sub>
        </CardHeader.Main>
        <CardHeader.Aside>
          {debt.debtToGdpPct !== undefined && (
            <CardHeader.Value>
              {formatPct(debt.debtToGdpPct, 1)}
            </CardHeader.Value>
          )}
          <CardHeader.Sub>
            {debt.debtToGdpPct !== undefined ? `of GDP · ${cadence}` : cadence}
          </CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="metric-xl text-strong leading-none">
          {formatCompactUsd(debt.total)}
        </div>
        {change !== null && first && (
          <div className="min-w-0 text-right">
            <div className="body-md text-normal font-bold tabular-nums">
              {change >= 0 ? "+" : ""}
              {formatCompactUsd(change)}
            </div>
            <div className="caption text-soft truncate">since {first.date}</div>
          </div>
        )}
      </div>

      <MiniLineChart
        data={sparkline}
        width={210}
        height={42}
        color="hsl(var(--zf-accent-hue, 242) 85% 72%)"
      />

      {config.showSplit && split.length > 0 && <SplitTiles lines={split} />}
    </div>
  );
}

export const nationalDebtFrame = defineFrame({
  ...nationalDebtMeta,
  component: NationalDebt,
});
