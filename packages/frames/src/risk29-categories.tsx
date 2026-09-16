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
    <div className="grid h-full min-h-0 grid-cols-2 gap-2 md:grid-cols-4">
      {snapshot.categories.map((category) => {
        const color = risk29StateColor(category.state);
        const available = category.availableSignals;
        const total = category.totalSignals;
        const availability = total > 0 ? `${available}/${total}` : "0/0";

        return (
          <div
            key={category.id}
            className="flex min-h-0 flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="caption text-soft truncate uppercase">
                  {category.label}
                </div>
                <div className="caption text-soft mt-1">
                  weight {category.weight.toFixed(0)}%
                </div>
              </div>
              <span
                className="caption shrink-0 rounded-full border px-1.5 py-0.5 font-bold tracking-[0.06em]"
                style={{
                  color,
                  borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
                }}
              >
                {risk29StateLabel(category.state)}
              </span>
            </div>

            <div className="mt-2 flex items-end justify-between gap-2">
              <div className="metric-sm tabular-nums" style={{ color }}>
                {category.score === null ? "—" : category.score.toFixed(0)}
                <span className="caption text-soft ml-1">/100</span>
              </div>
              <div className="caption text-soft text-right">
                {availability}
                <br />
                signals
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
