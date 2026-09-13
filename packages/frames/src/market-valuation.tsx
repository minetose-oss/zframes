import { defineFrame, useMarketSnapshot, useMoney } from "@zframes/core";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { formatLevel, formatPct } from "./format";
import { marketValuationMeta } from "./schemas";
import { Stat } from "./stat";
import { FrameStatus } from "./ui";

const schema = marketValuationMeta.schema;

function MarketValuation({ config }: { config: z.output<typeof schema> }) {
  const money = useMoney();
  const { snapshot, isLoading } = useMarketSnapshot(config.market);
  const valuation = snapshot?.valuation;

  if (isLoading && !snapshot)
    return <FrameStatus loading>loading market valuation…</FrameStatus>;
  // The publisher releases the multiples separately from the index board, so a
  // snapshot without them is a live card missing one release, not a failure.
  if (!valuation) return <FrameStatus>no valuation published yet</FrameStatus>;

  const stats: [string, string][] = [
    ["Market cap", money.compact(valuation.marketCap)],
    ["P/E", formatLevel(valuation.peRatio)],
    ["P/BV", formatLevel(valuation.pbvRatio)],
    ["Yield", formatPct(valuation.dividendYieldPct)],
    ["Turnover", formatPct(valuation.turnoverRatioPct)],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-2">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>
            {snapshot?.market ?? config.market} valuation
          </CardHeader.Eyebrow>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Sub>{valuation.asOf}</CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <Stat.Strip cols={5} gap={1.5}>
        {stats.map(([label, value]) => (
          <Stat key={label}>
            <Stat.Label>{label}</Stat.Label>
            <Stat.Value>{value}</Stat.Value>
          </Stat>
        ))}
      </Stat.Strip>
    </div>
  );
}

export const marketValuationFrame = defineFrame({
  ...marketValuationMeta,
  component: MarketValuation,
});
