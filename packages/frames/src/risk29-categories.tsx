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
        const isPlanned = total === 0;
        const availability = isPlanned ? "not live" : `${available}/${total}`;
        const stateLabel = isPlanned
          ? "PLANNED"
          : risk29StateLabel(category.state);

        return (
          <div
            key={category.id}
            className="min-h-0 overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.025] px-2 py-1.5 sm:rounded-xl sm:p-3"
          >
            <div className="flex min-w-0 items-start justify-between gap-1 sm:gap-2">
              <div className="text-soft min-w-0 truncate text-[9px] leading-tight font-semibold uppercase sm:text-xs sm:font-normal">
                {category.label}
              </div>
              <span
                className="shrink-0 whitespace-nowrap rounded-full border px-1 py-0.5 text-[8px] leading-none font-bold tracking-[0.04em] sm:px-1.5 sm:text-xs sm:leading-normal sm:tracking-[0.06em]"
                style={{
                  color,
                  borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
                }}
              >
                {stateLabel}
              </span>
            </div>

            <div className="mt-1 flex min-w-0 items-center justify-between gap-1">
              <div className="min-w-0 truncate text-[9px] leading-tight sm:text-xs">
                {isPlanned ? (
                  <span className="text-soft">
                    weight {category.weight.toFixed(0)}% · not live
                  </span>
                ) : (
                  <>
                    <span className="font-bold tabular-nums" style={{ color }}>
                      {category.score === null
                        ? "—"
                        : category.score.toFixed(0)}
                    </span>
                    <span className="text-soft">
                      {" "}
                      /100 · weight {category.weight.toFixed(0)}%
                    </span>
                  </>
                )}
              </div>
              {!isPlanned && (
                <span className="text-soft shrink-0 text-[8px] leading-tight sm:text-xs">
                  {availability}
                </span>
              )}
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
