import { CHART_COLORS_MULTI_SERIES, PieChart } from "@zframes/charts";
import {
  defineFrame,
  useFundIndustryAllocation,
  useMoney,
} from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { formatPct } from "./format";
import { fundIndustryAllocationMeta } from "./schemas";
import { SliceLegend } from "./slice-legend";
import { FrameStatus } from "./ui";

const schema = fundIndustryAllocationMeta.schema;

const OTHER_LABEL = "Other";

function FundIndustryAllocation({
  config,
}: {
  config: z.output<typeof schema>;
}) {
  const { allocation, isLoading } = useFundIndustryAllocation();
  const money = useMoney();

  const slices = useMemo(() => {
    if (!allocation) return [];
    const totals = new Map<string, number>();
    for (const bucket of allocation.buckets) {
      const key = config.groupBy === "group" ? bucket.group : bucket.label;
      totals.set(key, (totals.get(key) ?? 0) + bucket.value);
    }
    const sorted = [...totals.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, config.maxSlices);
    const tail = sorted.slice(config.maxSlices);
    const folded =
      tail.length > 0
        ? [
            ...head,
            {
              name: OTHER_LABEL,
              value: tail.reduce((sum, entry) => sum + entry.value, 0),
            },
          ]
        : head;
    return folded.map((entry, i) => ({
      ...entry,
      color: CHART_COLORS_MULTI_SERIES[i % CHART_COLORS_MULTI_SERIES.length],
    }));
  }, [allocation, config.groupBy, config.maxSlices]);

  if (isLoading) return <FrameStatus loading>loading allocation…</FrameStatus>;
  if (!allocation || slices.length === 0)
    return <FrameStatus>no allocation data</FrameStatus>;

  // The publisher's own shares are measured against net asset value, which nets
  // out liabilities and intra-manager cross-holdings — so the buckets sum to a
  // little over 100%. The ring's own proportions are what the eye reads; the
  // printed share stays the published one.
  const shown = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4">
      <div className="min-h-0 w-full flex-1">
        <PieChart
          data={slices}
          fill
          width={200}
          height={200}
          innerRadius={58}
          outerRadius={92}
          colors={slices.map((slice) => slice.color)}
        >
          <div className="flex flex-col items-center gap-0.5">
            <span className="caption text-soft">{allocation.period} NAV</span>
            <span className="metric-md text-strong">
              {money.compact(allocation.totalNav)}
            </span>
          </div>
        </PieChart>
      </div>

      <SliceLegend>
        {slices.map((slice) => (
          <SliceLegend.Item
            key={slice.name}
            color={slice.color}
            label={slice.name}
          >
            {formatPct((slice.value / shown) * 100, 1)}
            <span className="caption text-soft ml-1.5">
              {money.compact(slice.value)}
            </span>
          </SliceLegend.Item>
        ))}
      </SliceLegend>
    </div>
  );
}

export const fundIndustryAllocationFrame = defineFrame({
  ...fundIndustryAllocationMeta,
  component: FundIndustryAllocation,
});
