import {
  CHART_COLORS_MULTI_SERIES,
  type MultiSeriesData,
} from "@zframes/charts";
import { defineFrame, useMacroReferenceSeries, useMoney } from "@zframes/core";
import { useCallback, useMemo } from "react";
import type { z } from "zod";
// Generic series maths that happens to live in the metals module: windowing and
// thinning are the same arithmetic for a fix history and a published statistic.
import {
  downsample,
  sliceYears,
  timeframeFor,
  toChartData,
} from "./metals-shared";
import {
  SeriesHeader,
  formatSeriesValue,
  withUnitLabel,
} from "./official-series-shared";
import { officialSeriesMeta } from "./schemas";
import { FrameStatus } from "./ui";
import { TimeSeriesChart } from "./series-chart";

const schema = officialSeriesMeta.schema;

function OfficialSeriesChart({ config }: { config: z.output<typeof schema> }) {
  const { series: official, isLoading } = useMacroReferenceSeries(
    config.seriesId,
    undefined,
    config.source,
  );

  const series: MultiSeriesData[] = useMemo(() => {
    if (!official) return [];
    const windowed = downsample(sliceYears(official.points, config.years));
    // A single point draws no path — that's an empty shell, not a chart.
    if (windowed.length < 2) return [];
    return [
      {
        id: official.seriesId,
        name: official.label,
        color: CHART_COLORS_MULTI_SERIES[0],
        data: toChartData(windowed),
      },
    ];
  }, [official, config.years]);

  // The axis reads in the series' OWN unit, so a policy rate is ticked "1.25%"
  // where a property-price index is ticked "183.82".
  const unit = official?.unit ?? "index";
  const money = useMoney();
  // A `usd` series (a country's GDP, reserves, FDI) is money and follows the
  // board's display currency; `index` and `percent` are unit-less levels.
  const formatValue = useCallback(
    (value: number) =>
      unit === "usd" ? money.compact(value) : formatSeriesValue(value, unit),
    [unit, money],
  );

  // The header carries the per-quantity label the axis leaves off, and a priced
  // series wants its exact figure: "$1,106.47/t", not the compact "$1.11K/t" an
  // aggregate like a country's GDP reads better as.
  const unitLabel = official?.unitLabel;
  const formatHeaderValue = useCallback(
    (value: number) =>
      unit === "usd"
        ? withUnitLabel(
            unitLabel ? money.price(value) : money.compact(value),
            unitLabel,
          )
        : formatSeriesValue(value, unit, unitLabel),
    [unit, unitLabel, money],
  );

  if (isLoading && !official)
    return <FrameStatus loading>loading published series…</FrameStatus>;
  if (!official || series.length === 0)
    return <FrameStatus>no published series yet</FrameStatus>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SeriesHeader series={official} formatValue={formatHeaderValue} />
      <div className="min-h-0 flex-1">
        <TimeSeriesChart
          series={series}
          timeframe={timeframeFor(config.years)}
          fill
          formatValue={formatValue}
        />
      </div>
    </div>
  );
}

export const officialSeriesFrame = defineFrame({
  ...officialSeriesMeta,
  component: OfficialSeriesChart,
});
