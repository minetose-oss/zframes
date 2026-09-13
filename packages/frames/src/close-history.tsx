import {
  CHART_COLORS_MULTI_SERIES,
  type MultiSeriesData,
} from "@zframes/charts";
import { defineFrame, useDailyCloseHistory, useMoney } from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { changeColor, formatChangePct } from "./format";
import {
  downsample,
  sliceYears,
  timeframeFor,
  toChartData,
} from "./metals-shared";
import { closeHistoryMeta } from "./schemas";
import { TimeSeriesChart } from "./series-chart";
import { FrameStatus } from "./ui";

const schema = closeHistoryMeta.schema;

/** Years of history each window asks for; MAX is wider than any source carries. */
const WINDOW_YEARS: Record<z.output<typeof schema>["window"], number> = {
  "3M": 0.25,
  "6M": 0.5,
  "1Y": 1,
  "5Y": 5,
  MAX: 100,
};

function CloseHistory({ config }: { config: z.output<typeof schema> }) {
  const money = useMoney();
  const { history, isLoading } = useDailyCloseHistory(
    config.symbol,
    undefined,
    undefined,
    config.source,
  );
  const years = WINDOW_YEARS[config.window];

  const windowed = useMemo(
    () => downsample(sliceYears(history, years)),
    [history, years],
  );
  const series: MultiSeriesData[] = useMemo(() => {
    // A single point draws no path — an empty shell, not a chart.
    if (windowed.length < 2) return [];
    return [
      {
        id: config.symbol,
        name: config.symbol,
        color: CHART_COLORS_MULTI_SERIES[0],
        data: toChartData(windowed),
      },
    ];
  }, [windowed, config.symbol]);

  if (isLoading && history.length === 0)
    return <FrameStatus loading>loading close history…</FrameStatus>;
  if (series.length === 0)
    return <FrameStatus>no close history for “{config.symbol}”</FrameStatus>;

  const first = windowed[0].value;
  const last = windowed[windowed.length - 1].value;
  // The move across the VISIBLE window, which is what the chart draws — not the
  // session's change, which this once-a-day series could not show anyway.
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>{config.symbol} · daily close</CardHeader.Eyebrow>
          <CardHeader.Value>{money.price(last)}</CardHeader.Value>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Value tint={changeColor(changePct)}>
            {formatChangePct(changePct)}
          </CardHeader.Value>
          <CardHeader.Sub>over {config.window}</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>
      <div className="min-h-0 flex-1">
        <TimeSeriesChart
          series={series}
          timeframe={timeframeFor(years)}
          fill
          formatValue={money.magnitude}
        />
      </div>
    </div>
  );
}

export const closeHistoryFrame = defineFrame({
  ...closeHistoryMeta,
  component: CloseHistory,
});
