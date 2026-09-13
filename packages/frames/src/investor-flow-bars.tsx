import { BarChart } from "@zframes/charts";
import { defineFrame, useInvestorTypeFlow, useMoney } from "@zframes/core";
import { useMemo } from "react";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { DOWN_COLOR, UP_COLOR } from "./format";
import { investorFlowBarsMeta } from "./schemas";
import { Stat } from "./stat";
import { FrameStatus } from "./ui";

const schema = investorFlowBarsMeta.schema;

function InvestorFlowBars({ config }: { config: z.output<typeof schema> }) {
  const money = useMoney();
  const { flow, isLoading } = useInvestorTypeFlow(config.market);

  const data = useMemo(
    () =>
      (flow?.investors ?? []).map((row) => ({
        label: row.name,
        value: row.net,
      })),
    [flow],
  );

  if (isLoading && !flow)
    return <FrameStatus loading>loading investor flows…</FrameStatus>;
  if (!flow || data.length === 0)
    return <FrameStatus>no investor flows yet</FrameStatus>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>{flow.market} investor flows</CardHeader.Eyebrow>
          <CardHeader.Value>{money.compact(flow.totalValue)}</CardHeader.Value>
          <CardHeader.Sub>session traded value</CardHeader.Sub>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Sub>{flow.asOf}</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div className="min-h-0 flex-1">
        <BarChart
          data={data}
          orientation="horizontal"
          color={UP_COLOR}
          negativeColor={DOWN_COLOR}
          fill
          formatValue={money.compact}
        />
      </div>

      {config.showGross && (
        <Stat.Strip cols={4} gap={1} className="shrink-0">
          {flow.investors.map((row) => (
            <Stat key={row.type}>
              <Stat.Label>{row.name}</Stat.Label>
              {/* Bought over sold, in the market's own reading of the two
                  colours — the net bar above is the difference between them. */}
              <Stat.Value tint={UP_COLOR}>{money.compact(row.buy)}</Stat.Value>
              <Stat.Hint tint={DOWN_COLOR}>{money.compact(row.sell)}</Stat.Hint>
            </Stat>
          ))}
        </Stat.Strip>
      )}
    </div>
  );
}

export const investorFlowBarsFrame = defineFrame({
  ...investorFlowBarsMeta,
  component: InvestorFlowBars,
});
