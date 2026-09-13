import { CHART_COLORS_MULTI_SERIES } from "@zframes/charts";
import { defineFrame, useBondIssuance, useMoney } from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { ABSENT, changeColor, formatChangePct } from "./format";
import { bondIssuanceBarsMeta } from "./schemas";
import { StackedBars, type StackedSeries } from "./stacked-bars";
import { FrameStatus } from "./ui";

const schema = bondIssuanceBarsMeta.schema;

const TYPE_SERIES: StackedSeries[] = [
  {
    key: "corporate",
    label: "Corporate",
    color: CHART_COLORS_MULTI_SERIES[1],
  },
  {
    key: "government",
    label: "Government",
    color: CHART_COLORS_MULTI_SERIES[0],
  },
];

const MARKET_SERIES: StackedSeries[] = [
  { key: "domestic", label: "Domestic", color: CHART_COLORS_MULTI_SERIES[2] },
  { key: "offshore", label: "Offshore", color: CHART_COLORS_MULTI_SERIES[4] },
];

const CAPTIONS = {
  type: "new bond supply per quarter, by issuer",
  market: "new bond supply per quarter, by where it was offered",
  instrument: "corporate issuance per quarter, by instrument",
} as const;

function BondIssuanceBars({ config }: { config: z.output<typeof schema> }) {
  const { issuance, isLoading } = useBondIssuance();
  const money = useMoney();

  const shown = useMemo(
    () => (issuance?.periods ?? []).slice(-config.quarters),
    [issuance, config.quarters],
  );

  // Instruments are whatever the publisher used across the window, largest
  // first — the set shifts between quarters, so it cannot be a static list.
  const instrumentSeries = useMemo(() => {
    const totals = new Map<string, number>();
    for (const period of shown)
      for (const [label, value] of Object.entries(period.byInstrument))
        totals.set(label, (totals.get(label) ?? 0) + value);
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label], i) => ({
        key: label,
        label,
        color: CHART_COLORS_MULTI_SERIES[i % CHART_COLORS_MULTI_SERIES.length],
      }));
  }, [shown]);

  const series =
    config.split === "type"
      ? TYPE_SERIES
      : config.split === "market"
        ? MARKET_SERIES
        : instrumentSeries;

  const periods = useMemo(
    () =>
      shown.map((period) => ({
        label: period.period,
        values:
          config.split === "instrument"
            ? period.byInstrument
            : config.split === "market"
              ? { domestic: period.domestic, offshore: period.offshore }
              : { corporate: period.corporate, government: period.government },
      })),
    [shown, config.split],
  );

  if (isLoading)
    return <FrameStatus loading>loading bond issuance…</FrameStatus>;
  if (periods.length === 0 || series.length === 0)
    return <FrameStatus>no bond-issuance data</FrameStatus>;

  const totalOf = (i: number) =>
    series.reduce(
      (sum, s) => sum + Math.max(0, periods[i].values[s.key] ?? 0),
      0,
    );
  const latest = totalOf(periods.length - 1);
  const previous = periods.length > 1 ? totalOf(periods.length - 2) : 0;
  const qoqPct = previous > 0 ? ((latest - previous) / previous) * 100 : NaN;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader>
        <CardHeader.Main>
          <CardHeader.Eyebrow>
            {shown[shown.length - 1].period} issued
          </CardHeader.Eyebrow>
          <CardHeader.Value size="metric-lg">
            {money.compact(latest)}
          </CardHeader.Value>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Value
            tint={changeColor(qoqPct)}
            absent={!Number.isFinite(qoqPct)}
          >
            {Number.isFinite(qoqPct) ? formatChangePct(qoqPct) : ABSENT}
          </CardHeader.Value>
          <CardHeader.Sub>on the quarter</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div className="min-h-0 flex-1">
        <StackedBars
          periods={periods}
          series={series}
          formatTotal={money.compact}
          caption={CAPTIONS[config.split]}
        />
      </div>
    </div>
  );
}

export const bondIssuanceBarsFrame = defineFrame({
  ...bondIssuanceBarsMeta,
  component: BondIssuanceBars,
});
