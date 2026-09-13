import { BarChart, CHART_COLORS_MULTI_SERIES } from "@zframes/charts";
import { defineFrame, useBondMarketStats, useMoney } from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { ChartCard } from "./chart-card";
import { ABSENT, formatPct } from "./format";
import { bondMarketStatsMeta } from "./schemas";
import { StackedBars } from "./stacked-bars";
import { FrameStatus } from "./ui";

const schema = bondMarketStatsMeta.schema;

/** The three slices that actually stack: `total` is their sum, not a fourth band. */
const SEGMENTS = [
  {
    key: "government",
    label: "Government",
    color: CHART_COLORS_MULTI_SERIES[0],
  },
  { key: "corporate", label: "Corporate", color: CHART_COLORS_MULTI_SERIES[1] },
  { key: "foreign", label: "Foreign", color: CHART_COLORS_MULTI_SERIES[3] },
] as const;

/** Whole percents keep the axis readable; module-level so the identity is stable. */
const formatTurnover = (value: number) => formatPct(value, 0);

function BondMarketStats({ config }: { config: z.output<typeof schema> }) {
  const { stats, isLoading } = useBondMarketStats();
  const money = useMoney();
  const years = stats?.years ?? [];
  const latest = years[years.length - 1];

  const periods = useMemo(
    () =>
      years.map((year) => {
        const split =
          config.metric === "trading" ? year.tradingValue : year.outstanding;
        return {
          label: String(year.year),
          values: {
            government: split.government ?? 0,
            corporate: split.corporate ?? 0,
            foreign: split.foreign ?? 0,
          },
        };
      }),
    [years, config.metric],
  );

  const turnoverBars = useMemo(() => {
    if (!latest) return [];
    return [
      { label: "All bonds", value: latest.turnoverPct.total },
      { label: "Government", value: latest.turnoverPct.government },
      { label: "Corporate", value: latest.turnoverPct.corporate },
      { label: "Foreign", value: latest.turnoverPct.foreign },
    ].flatMap((bar) =>
      bar.value === undefined ? [] : [{ label: bar.label, value: bar.value }],
    );
  }, [latest]);

  const investorBars = useMemo(
    () =>
      [...(latest?.tradingShareByInvestor ?? [])]
        .sort((a, b) => b.pct - a.pct)
        .map((entry) => ({ label: entry.label, value: entry.pct })),
    [latest],
  );

  if (isLoading)
    return <FrameStatus loading>loading bond-market statistics…</FrameStatus>;
  if (!latest) return <FrameStatus>no bond-market statistics</FrameStatus>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader>
        <CardHeader.Main>
          <CardHeader.Eyebrow>{latest.year} · average yield</CardHeader.Eyebrow>
          <CardHeader.Value
            size="metric-lg"
            absent={latest.avgGovYieldPct === undefined}
          >
            {latest.avgGovYieldPct === undefined
              ? ABSENT
              : formatPct(latest.avgGovYieldPct, 2)}
          </CardHeader.Value>
          <CardHeader.Sub size="caption">
            government ·{" "}
            {latest.avgCorpYieldPct === undefined
              ? ABSENT
              : formatPct(latest.avgCorpYieldPct, 2)}{" "}
            corporate
          </CardHeader.Sub>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Value absent={latest.govTotalReturnIndex === undefined}>
            {latest.govTotalReturnIndex === undefined
              ? ABSENT
              : latest.govTotalReturnIndex.toFixed(1)}
            {" / "}
            {latest.corpTotalReturnIndex === undefined
              ? ABSENT
              : latest.corpTotalReturnIndex.toFixed(1)}
          </CardHeader.Value>
          <CardHeader.Sub>gov / corp total return</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      {config.metric === "investors" ? (
        <ChartCard align="center" gap={1} className="text-normal">
          <ChartCard.Body>
            <BarChart
              data={investorBars}
              orientation="horizontal"
              fill
              formatValue={formatTurnover}
            />
          </ChartCard.Body>
          <ChartCard.Caption>
            {latest.year} traded value by investor class
          </ChartCard.Caption>
        </ChartCard>
      ) : config.metric === "turnover" ? (
        <ChartCard align="center" gap={1} className="text-normal">
          <ChartCard.Body>
            <BarChart
              data={turnoverBars}
              orientation="horizontal"
              fill
              formatValue={formatTurnover}
            />
          </ChartCard.Body>
          <ChartCard.Caption>
            {latest.year} traded value as a share of value outstanding
          </ChartCard.Caption>
        </ChartCard>
      ) : (
        <div className="min-h-0 flex-1">
          <StackedBars
            periods={periods}
            series={[...SEGMENTS]}
            formatTotal={money.compact}
            caption={
              config.metric === "trading"
                ? "value traded per year"
                : "registered value outstanding at year end"
            }
          />
        </div>
      )}
    </div>
  );
}

export const bondMarketStatsFrame = defineFrame({
  ...bondMarketStatsMeta,
  component: BondMarketStats,
});
