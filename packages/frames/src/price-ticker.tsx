import { defineFrame, useDayStatsState, useMidsState } from "@zframes/core";
import type { z } from "zod";
import { tickerOf } from "./asset-logo";
import { MoverRow } from "./mover-row";
import { priceTickerMeta } from "./schemas";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = priceTickerMeta.schema;

/**
 * Live mids come off the `quote-stream` capability, which only Hyperliquid
 * serves — so a card pinned to another venue must not subscribe at all. Routing
 * would hand it Hyperliquid's stream regardless, and the tickers overlap: a
 * Bitkub or Settrade "BTC" row would then tick at Hyperliquid's BTC price,
 * which is a wrong number wearing a live indicator.
 */
const NO_STREAM: string[] = [];

function PriceTicker({ config }: { config: z.output<typeof schema> }) {
  const streamed =
    !config.source || config.source === "hyperliquid"
      ? config.symbols
      : NO_STREAM;
  const { mids, isLoading: midsLoading } = useMidsState(streamed);
  const { stats, isLoading: statsLoading } = useDayStatsState(
    config.symbols,
    undefined,
    config.source,
  );
  const hasAnyPrice = config.symbols.some(
    (symbol) =>
      mids[symbol] !== undefined || stats[symbol]?.markPx !== undefined,
  );

  if ((midsLoading || statsLoading) && !hasAnyPrice)
    return <FrameStatus loading>loading prices…</FrameStatus>;

  return (
    <div className={`flex flex-col gap-1.5 ${scrollAreaClass}`}>
      {config.symbols.map((symbol) => (
        <MoverRow
          key={symbol}
          symbol={symbol}
          label={tickerOf(symbol)}
          price={mids[symbol] ?? stats[symbol]?.markPx}
          changePct={stats[symbol]?.changePct}
          logoSize={18}
          gap="gap-3"
        />
      ))}
    </div>
  );
}

export const priceTickerFrame = defineFrame({
  ...priceTickerMeta,
  component: PriceTicker,
});
