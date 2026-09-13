import { TreeChart, type TreeNode } from "@zframes/charts";
import { defineFrame, useIndustryMarketCap, useMoney } from "@zframes/core";
import type { IndustryCap } from "@zframes/spec";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { ABSENT, changeColor, formatChangePct, formatPct } from "./format";
import { industryCapTreemapMeta } from "./schemas";
import { treemapLeaf } from "./treemap-leaf";
import { FrameStatus } from "./ui";

const schema = industryCapTreemapMeta.schema;

interface IndustryNode extends TreeNode {
  name: string;
  cap: number;
  /** Quarter over quarter, percent; null where the publisher has no prior print. */
  changePct: number | null;
}

const Leaf = treemapLeaf<IndustryNode>(
  (d) => d.id,
  (d, money) => money.compact(d.cap),
);

function changePctOf(cap: IndustryCap): number | null {
  if (cap.prev === undefined || cap.prev === 0) return null;
  return ((cap.value - cap.prev) / cap.prev) * 100;
}

function IndustryCapTreemap({ config }: { config: z.output<typeof schema> }) {
  const { caps, isLoading } = useIndustryMarketCap(config.market);
  const money = useMoney();

  // mai publishes no sectors, so a sector card there falls back to the groups
  // rather than rendering an empty mosaic.
  const rows = useMemo(() => {
    if (!caps) return [];
    const preferred = config.level === "group" ? caps.groups : caps.sectors;
    return preferred.length > 0 ? preferred : caps.groups;
  }, [caps, config.level]);

  const data: IndustryNode[] = useMemo(
    () =>
      rows
        .filter((row) => row.value > 0)
        .map((row) => ({
          id: row.code,
          value: row.value,
          name: row.name,
          cap: row.value,
          changePct: changePctOf(row),
        })),
    [rows],
  );

  const shownCapUsd = useMemo(
    () => data.reduce((sum, node) => sum + node.cap, 0),
    [data],
  );

  const totals = useMemo(() => {
    const latest = caps?.history[caps.history.length - 1];
    const previous = caps?.history[caps.history.length - 2];
    if (!latest) return null;
    const changePct =
      previous && previous.total > 0
        ? ((latest.total - previous.total) / previous.total) * 100
        : null;
    return { total: latest.total, changePct };
  }, [caps]);

  if (isLoading)
    return <FrameStatus loading>loading industry caps…</FrameStatus>;
  if (!caps || data.length === 0)
    return <FrameStatus>no industry data</FrameStatus>;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <CardHeader>
        <CardHeader.Main>
          <CardHeader.Eyebrow>
            {caps.market} · {config.level === "group" ? "groups" : "sectors"} ·{" "}
            {caps.period}
          </CardHeader.Eyebrow>
          <CardHeader.Value size="metric-lg">
            {money.compact(totals?.total ?? shownCapUsd)}
          </CardHeader.Value>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Value
            tint={
              totals?.changePct === null || totals?.changePct === undefined
                ? undefined
                : changeColor(totals.changePct)
            }
            absent={
              totals?.changePct === null || totals?.changePct === undefined
            }
          >
            {totals?.changePct === null || totals?.changePct === undefined
              ? ABSENT
              : formatChangePct(totals.changePct)}
          </CardHeader.Value>
          <CardHeader.Sub>vs prev quarter</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div className="min-h-0 flex-1">
        <TreeChart
          data={data}
          LeafComponent={Leaf}
          getColorValue={(node) => node.changePct ?? 0}
          formatTooltip={(node) => ({
            title: node.name,
            rows: [
              { label: "market cap", value: money.compact(node.cap) },
              {
                label: "QoQ",
                value:
                  node.changePct === null
                    ? ABSENT
                    : formatChangePct(node.changePct),
                color:
                  node.changePct === null
                    ? undefined
                    : changeColor(node.changePct),
              },
            ],
            footer:
              shownCapUsd > 0
                ? `${formatPct((node.cap / shownCapUsd) * 100, 1)} of ${caps.market}`
                : undefined,
          })}
        />
      </div>
    </div>
  );
}

export const industryCapTreemapFrame = defineFrame({
  ...industryCapTreemapMeta,
  component: IndustryCapTreemap,
});
