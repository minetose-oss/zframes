import { defineFrame, useMoney, useRetailGoldPrice } from "@zframes/core";
import type { z } from "zod";
import { timeAgo } from "./format";
import { retailGoldMeta } from "./schemas";
import { Stat } from "./stat";
import { FrameStatus } from "./ui";

const schema = retailGoldMeta.schema;

function RetailGold({ config }: { config: z.output<typeof schema> }) {
  const { price, isLoading } = useRetailGoldPrice();
  const money = useMoney();

  if (isLoading) return <FrameStatus loading>loading gold quote…</FrameStatus>;
  if (!price) return <FrameStatus>no retail gold quote</FrameStatus>;

  const barSpread = price.bar.sell - price.bar.buy;
  const ornamentSpread = price.ornament.sell - price.ornament.buy;
  const announced = [
    `updated ${timeAgo(price.updatedAt)}`,
    price.revision === undefined ? null : `no. ${price.revision}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 w-full flex-col justify-center gap-3">
      <Stat.Strip cols={2} gap={2}>
        <Stat surface="tile">
          <Stat.Label>Bar buy</Stat.Label>
          <Stat.Value size="metric-sm">{money.price(price.bar.buy)}</Stat.Value>
        </Stat>
        <Stat surface="tile">
          <Stat.Label>Bar sell</Stat.Label>
          <Stat.Value size="metric-sm">
            {money.price(price.bar.sell)}
          </Stat.Value>
        </Stat>
      </Stat.Strip>

      {config.showOrnament && (
        <Stat.Strip cols={2} gap={2}>
          <Stat surface="tile">
            <Stat.Label>Ornament buy</Stat.Label>
            <Stat.Value>{money.price(price.ornament.buy)}</Stat.Value>
          </Stat>
          <Stat surface="tile">
            <Stat.Label>Ornament sell</Stat.Label>
            <Stat.Value>{money.price(price.ornament.sell)}</Stat.Value>
          </Stat>
        </Stat.Strip>
      )}

      <div className="caption text-soft">
        per baht-weight · 96.5% · bar spread {money.price(barSpread)}
        {config.showOrnament
          ? ` · ornament spread ${money.price(ornamentSpread)}`
          : ""}{" "}
        · {announced}
      </div>
    </div>
  );
}

export const retailGoldFrame = defineFrame({
  ...retailGoldMeta,
  component: RetailGold,
});
