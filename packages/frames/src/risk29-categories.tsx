import { defineFrame } from "@zframes/core";
import { useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import { risk29CategoriesMeta } from "./schemas/risk29";
import { FrameStatus } from "./ui";
import { risk29StateColor, risk29StateLabel } from "./risk29-shared";

const schema = risk29CategoriesMeta.schema;

function Risk29Categories({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);

  if (isLoading)
    return <FrameStatus loading>loading Risk29 categories…</FrameStatus>;
  if (error)
    return (
      <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>
    );
  if (!snapshot) return <FrameStatus>no current Risk29 snapshot</FrameStatus>;

  return (
    <div className="grid h-full min-h-0 grid-cols-2 grid-rows-4 gap-1.5 sm:gap-2 md:grid-cols-4 md:grid-rows-2">
      {snapshot.categories.map((category) => {
        const color = risk29StateColor(category.state);
        const available = category.availableSignals;
        const total = category.totalSignals;
        const availability = total > 0 ? `${available}/${total}` : "0/0";

        return (
          <div
            key={category.id}
            className="flex min-h-0 flex-col justify-between overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.025] px-2 py-1.5 sm:rounded-xl sm:p-3"
          >
            <div className="flex min-w-0 items-start justify-between gap-1 sm:gap-2">
              <div className="min-w-0">
                <div className="text-soft truncate text-[9px] leading-tight font-semibold uppercase sm:text-xs sm:font-normal">
                  {category.label}
                </div>
                <div className="text-soft mt-0.5 text-[8px] leading-none sm:mt-1 sm:text-xs sm:leading-normal">
                  weight {category.weight.toFixed(0)}%
                </div>
              </div>
              <span
                className="shrink-0 whitespace-nowrap rounded-full border px-1 py-0.5 text-[8px] leading-none font-bold tracking-[0.04em] sm:px-1.5 sm:text-xs sm:leading-normal sm:tracking-[0.06em]"
                style={{
                  color,
                  borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
                }}
              >
                {risk29StateLabel(category.state)}
              </span>
            </div>

            <div className="mt-1 flex min-w-0 items-end justify-between gap-1 sm:mt-2 sm:gap-2">
              <div
                className="min-w-0 text-lg leading-none font-bold tabular-nums sm:text-2xl"
                style={{ color }}
              >
                {category.score === null ? "—" : category.score.toFixed(0)}
                <span className="text-soft ml-1 text-[8px] font-normal sm:text-xs">
                  /100
                </span>
              </div>
              <div className="text-soft shrink-0 text-right text-[8px] leading-tight sm:text-xs sm:leading-normal">
                {availability}
                <span className="hidden sm:inline">
                  <br />
                  signals
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const risk29CategoriesFrame = defineFrame({
  ...risk29CategoriesMeta,
  component: Risk29Categories,
});
