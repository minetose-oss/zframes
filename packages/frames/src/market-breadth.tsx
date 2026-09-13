import { defineFrame, useMarketSnapshot } from "@zframes/core";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { DOWN_COLOR, UP_COLOR, formatCompact, formatPct } from "./format";
import { asOfIct, sessionLabel } from "./market-session";
import { marketBreadthMeta } from "./schemas";
import { Stat } from "./stat";
import { FrameStatus } from "./ui";

const schema = marketBreadthMeta.schema;

function MarketBreadth({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading } = useMarketSnapshot(config.market);

  if (isLoading) return <FrameStatus loading>loading breadth…</FrameStatus>;
  if (!snapshot) return <FrameStatus>no breadth data yet</FrameStatus>;

  const { gainers, losers, unchanged } = snapshot.breadth;
  const listings = gainers + losers + unchanged;
  if (listings <= 0) return <FrameStatus>no breadth data yet</FrameStatus>;

  const share = (count: number) => (count / listings) * 100;
  // `tint` is deliberately absent on the flat slice: the bar's neutral fill is
  // too faint to read as a figure, so its count keeps the card's own ink.
  const segments = [
    { key: "gainers", count: gainers, fill: UP_COLOR, tint: UP_COLOR },
    { key: "unchanged", count: unchanged, fill: "rgb(255 255 255 / 0.18)" },
    { key: "losers", count: losers, fill: DOWN_COLOR, tint: DOWN_COLOR },
  ] as { key: string; count: number; fill: string; tint?: string }[];

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-2">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>{snapshot.market} breadth</CardHeader.Eyebrow>
        </CardHeader.Main>
        <CardHeader.Aside>
          <CardHeader.Sub>
            {sessionLabel(snapshot.status)} · {asOfIct(snapshot.asOf)}
          </CardHeader.Sub>
        </CardHeader.Aside>
      </CardHeader>

      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${gainers} advancing, ${unchanged} unchanged, ${losers} declining of ${listings} listings`}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            style={{
              width: `${share(segment.count)}%`,
              backgroundColor: segment.fill,
            }}
          />
        ))}
      </div>

      <Stat.Strip cols={3} gap={2}>
        {segments.map((segment) => (
          <Stat key={segment.key}>
            <Stat.Label>{segment.key}</Stat.Label>
            <Stat.Value tint={segment.tint}>
              {formatCompact(segment.count)}
            </Stat.Value>
            <Stat.Hint>{formatPct(share(segment.count), 1)}</Stat.Hint>
          </Stat>
        ))}
      </Stat.Strip>
    </div>
  );
}

export const marketBreadthFrame = defineFrame({
  ...marketBreadthMeta,
  component: MarketBreadth,
});
