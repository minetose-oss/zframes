import { defineFrame, useMarketSnapshot, useMoney } from "@zframes/core";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { changeColor, formatChangePct, formatLevel } from "./format";
import { MetricRow } from "./metric-row";
import { marketIndexBoardMeta } from "./schemas";
import { asOfIct, sessionLabel } from "./market-session";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = marketIndexBoardMeta.schema;

function MarketIndexBoard({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading } = useMarketSnapshot(config.market);
  // Index levels are unit-less and never convert; the venue's traded VALUE is
  // money, so it is the one figure on this card that goes through the board's
  // display currency.
  const money = useMoney();

  if (isLoading) return <FrameStatus loading>loading index board…</FrameStatus>;
  if (!snapshot || snapshot.indices.length === 0)
    return <FrameStatus>no index data yet</FrameStatus>;

  const indices = snapshot.indices.slice(0, config.maxIndices);
  const turnover = snapshot.indices[0]?.valueUsd;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>{snapshot.name}</CardHeader.Eyebrow>
          <CardHeader.Sub ink="normal">
            {sessionLabel(snapshot.status)} · {asOfIct(snapshot.asOf)}
          </CardHeader.Sub>
        </CardHeader.Main>
        {turnover !== undefined && (
          <CardHeader.Aside>
            <CardHeader.Value>{money.compact(turnover)}</CardHeader.Value>
            <CardHeader.Sub>turnover</CardHeader.Sub>
          </CardHeader.Aside>
        )}
      </CardHeader>

      <div className={scrollAreaClass}>
        {indices.map((index) => (
          <MetricRow
            key={index.symbol}
            label={index.name}
            meta={
              config.showHighLow &&
              index.low !== undefined &&
              index.high !== undefined
                ? `${formatLevel(index.low)} – ${formatLevel(index.high)}`
                : undefined
            }
            value={
              <div className="text-right">
                <div className="tabular-nums">{formatLevel(index.last)}</div>
                <div
                  className="caption tabular-nums"
                  style={{ color: changeColor(index.changePct) }}
                >
                  {formatChangePct(index.changePct)}
                </div>
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}

export const marketIndexBoardFrame = defineFrame({
  ...marketIndexBoardMeta,
  component: MarketIndexBoard,
});
