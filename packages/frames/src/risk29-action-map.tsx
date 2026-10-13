import { defineFrame } from "@zframes/core";
import { useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import {
  risk29PortfolioActionMap,
  risk29StateColor,
} from "./risk29-shared";
import { risk29ActionMapMeta } from "./schemas/risk29";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = risk29ActionMapMeta.schema;

function Risk29ActionMap({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);

  if (isLoading)
    return <FrameStatus loading>building Risk29 action map…</FrameStatus>;
  if (error)
    return <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>;
  if (!snapshot) return <FrameStatus>no current Risk29 snapshot</FrameStatus>;

  const items = risk29PortfolioActionMap(snapshot);
  const color = risk29StateColor(snapshot.state);

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${scrollAreaClass}`}>
      <div className="flex items-start justify-between gap-3 px-0.5">
        <div>
          <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
            Portfolio Action Map
          </div>
          <div className="caption text-soft mt-0.5">
            Risk-budget overlay only — not a standalone return forecast.
          </div>
        </div>
        <span
          className="caption shrink-0 rounded-full border px-2 py-0.5 font-bold"
          style={{
            color,
            borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
          }}
        >
          {snapshot.state.toUpperCase()}
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.bucket}
            className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
          >
            <div className="caption text-soft truncate font-semibold">
              {item.bucket}
            </div>
            <div
              className="body-sm mt-1 font-bold tracking-[0.04em]"
              style={{ color }}
            >
              {item.bias}
            </div>
            <div className="caption text-soft mt-1.5 leading-snug">
              {item.rationale}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const risk29ActionMapFrame = defineFrame({
  ...risk29ActionMapMeta,
  component: Risk29ActionMap,
});
