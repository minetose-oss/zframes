import { defineFrame } from "@zframes/core";
import { useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import { risk29HeatmapMeta } from "./schemas/risk29";
import { FrameStatus, scrollAreaClass, scrollAreaXClass } from "./ui";
import {
  formatRisk29Value,
  risk29DirectionColor,
  risk29DirectionLabel,
  risk29FreshnessColor,
  risk29StateColor,
  risk29StateLabel,
} from "./risk29-shared";

const schema = risk29HeatmapMeta.schema;

function Risk29Heatmap({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);

  if (isLoading)
    return <FrameStatus loading>loading Risk29 signals…</FrameStatus>;
  if (error)
    return (
      <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>
    );
  if (!snapshot) return <FrameStatus>no current Risk29 snapshot</FrameStatus>;

  const signals = snapshot.signals.slice(0, config.maxSignals);

  return (
    <div className={`h-full min-h-0 ${scrollAreaXClass}`}>
      <div className="flex h-full min-h-0 min-w-[760px] flex-col">
        <div className="caption text-soft grid grid-cols-[minmax(150px,1.7fr)_minmax(80px,0.8fr)_minmax(100px,0.9fr)_72px_92px_100px_74px] gap-2 border-b border-white/[0.08] px-2 pb-2 uppercase tracking-[0.06em]">
          <span>Signal</span>
          <span>Category</span>
          <span>Value</span>
          <span className="text-right">Risk</span>
          <span>State</span>
          <span>Direction</span>
          <span>Fresh</span>
        </div>

        <div className={scrollAreaClass}>
          {signals.map((signal) => {
            const stateColor = risk29StateColor(signal.state);
            const freshnessColor = risk29FreshnessColor(signal.freshness);

            return (
              <div
                key={signal.id}
                className="grid grid-cols-[minmax(150px,1.7fr)_minmax(80px,0.8fr)_minmax(100px,0.9fr)_72px_92px_100px_74px] items-center gap-2 border-b border-white/[0.05] px-2 py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="body-sm text-strong truncate font-semibold">
                    {signal.label}
                  </div>
                  <div className="caption text-soft truncate">
                    {signal.sourceSeries ?? signal.source}
                  </div>
                </div>

                <span className="caption text-soft truncate capitalize">
                  {signal.category}
                </span>

                <span className="body-sm text-normal truncate tabular-nums">
                  {formatRisk29Value(signal.value, signal.unit)}
                </span>

                <span
                  className="body-sm text-right font-bold tabular-nums"
                  style={{ color: stateColor }}
                >
                  {signal.riskScore === null
                    ? "—"
                    : signal.riskScore.toFixed(0)}
                </span>

                <span
                  className="caption truncate font-bold tracking-[0.05em]"
                  style={{ color: stateColor }}
                >
                  {risk29StateLabel(signal.state)}
                </span>

                <span
                  className="caption truncate"
                  style={{ color: risk29DirectionColor(signal.direction) }}
                >
                  {risk29DirectionLabel(signal.direction)}
                </span>

                <span
                  className="caption truncate font-semibold uppercase"
                  style={{ color: freshnessColor }}
                >
                  {signal.freshness}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const risk29HeatmapFrame = defineFrame({
  ...risk29HeatmapMeta,
  component: Risk29Heatmap,
});
