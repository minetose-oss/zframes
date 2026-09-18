import {
  CHART_COLORS_MULTI_SERIES,
  ChartTimeframe,
  type MultiSeriesData,
} from "@zframes/charts";
import { defineFrame } from "@zframes/core";
import { useRisk29History } from "@zframes/core/risk29";
import { useMemo } from "react";
import type { z } from "zod";
import { ChartCard } from "./chart-card";
import { risk29HistoryMeta } from "./schemas/risk29";
import { FrameStatus } from "./ui";
import { TimeSeriesChart } from "./series-chart";
import { RISK29_ACCENT } from "./risk29-shared";

const schema = risk29HistoryMeta.schema;

const CATEGORY_LABELS: Record<string, string> = {
  macro: "Macro",
  credit: "Credit",
  valuation: "Valuation",
  sentiment: "Sentiment",
  qualitative: "Qualitative",
  liquidity: "Liquidity",
  global: "Global",
  technical: "Technical",
};

function Risk29History({ config }: { config: z.output<typeof schema> }) {
  const { history, isLoading, error } = useRisk29History(config.refreshMs);

  const series = useMemo<MultiSeriesData[]>(() => {
    if (!history || history.points.length === 0) return [];

    const latestTime = history.points.at(-1)?.time ?? 0;
    const cutoff = latestTime - config.days * 24 * 60 * 60 * 1000;
    const points = history.points.filter((point) => point.time >= cutoff);

    const aggregate: MultiSeriesData = {
      id: "risk29",
      name: "Risk29",
      color: RISK29_ACCENT,
      data: points
        .filter((point) => point.score !== null)
        .map((point) => ({
          date: new Date(point.time).toISOString(),
          value: point.score as number,
        })),
    };

    if (!config.showCategories) return [aggregate];

    const categoryIds = Object.keys(CATEGORY_LABELS);
    const categorySeries = categoryIds
      .map((categoryId, index): MultiSeriesData => ({
        id: categoryId,
        name: CATEGORY_LABELS[categoryId],
        color:
          CHART_COLORS_MULTI_SERIES[
            (index + 1) % CHART_COLORS_MULTI_SERIES.length
          ],
        data: points.flatMap((point) => {
          const value =
            point.categoryScores[
              categoryId as keyof typeof point.categoryScores
            ];
          return value === undefined
            ? []
            : [{ date: new Date(point.time).toISOString(), value }];
        }),
      }))
      .filter((item) => item.data.length >= 2);

    return [aggregate, ...categorySeries];
  }, [config.days, config.showCategories, history]);

  if (isLoading && !history)
    return <FrameStatus loading>loading Risk29 history…</FrameStatus>;
  if (error) return <FrameStatus>Risk29 history unavailable</FrameStatus>;
  if (series.length === 0 || series[0].data.length < 2) {
    const pointCount = series[0]?.data.length ?? 0;
    return (
      <FrameStatus>
        collecting Risk29 history — {pointCount} point{pointCount === 1 ? "" : "s"} available
      </FrameStatus>
    );
  }

  const pointCount = series[0].data.length;
  const latest = series[0].data.at(-1)?.value;
  const first = series[0].data[0]?.value;
  const delta =
    latest !== undefined && first !== undefined ? latest - first : null;

  return (
    <ChartCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="caption text-soft uppercase">
            {config.days}D trend
          </div>
          <div className="metric-sm text-strong tabular-nums">
            {latest?.toFixed(1)}
            {delta !== null && (
              <span className="caption text-soft ml-1.5">
                {delta > 0 ? "+" : ""}
                {delta.toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div className="caption text-soft text-right">
          {pointCount} observations
          <br />
          higher = more risk
        </div>
      </div>

      <ChartCard.Body>
        <TimeSeriesChart
          series={series}
          timeframe={
            config.days <= 31
              ? ChartTimeframe["1M"]
              : config.days <= 92
                ? ChartTimeframe["3M"]
                : ChartTimeframe["1Y"]
          }
          fill
          yDomain={[0, 100]}
          formatValue={(value) => value.toFixed(1)}
        />
      </ChartCard.Body>

      <ChartCard.Caption>
        Risk29 aggregate{config.showCategories ? " + category overlays" : ""}
      </ChartCard.Caption>
    </ChartCard>
  );
}

export const risk29HistoryFrame = defineFrame({
  ...risk29HistoryMeta,
  component: Risk29History,
});
