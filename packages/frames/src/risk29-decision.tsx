import { defineFrame } from "@zframes/core";
import { useRisk29History, useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import { risk29DecisionBrief, risk29StateColor } from "./risk29-shared";
import { risk29DecisionMeta } from "./schemas/risk29";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = risk29DecisionMeta.schema;

function Risk29Decision({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);
  const { history } = useRisk29History(Math.max(config.refreshMs, 5 * 60_000));

  if (isLoading)
    return (
      <FrameStatus loading>building today&apos;s Risk29 brief…</FrameStatus>
    );
  if (error)
    return (
      <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>
    );
  if (!snapshot) return <FrameStatus>no current Risk29 snapshot</FrameStatus>;

  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const previous = history?.points
    .filter(
      (point) =>
        Number.isFinite(point.time) &&
        (!Number.isFinite(generatedAtMs) || point.time < generatedAtMs),
    )
    .at(-1);
  const brief = risk29DecisionBrief(snapshot, previous);
  const color = risk29StateColor(snapshot.state);

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${scrollAreaClass}`}>
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
              Daily Decision Brief
            </div>
            <div className="body-sm text-strong mt-1 font-semibold">
              {brief.headline}
            </div>
          </div>
          <span
            className="caption shrink-0 rounded-full border px-2 py-0.5 font-bold tracking-[0.06em]"
            style={{
              color,
              borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
            }}
          >
            {brief.posture}
          </span>
        </div>
        {brief.confidence === "degraded" && (
          <div className="caption mt-2 rounded-lg border border-white/[0.08] px-2 py-1 text-soft">
            Data confidence degraded — review source health before acting.
          </div>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
            What changed
          </div>
          <div className="caption text-normal mt-1.5 leading-snug">
            {brief.whatChanged}
          </div>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
            Why
          </div>
          <div className="caption text-normal mt-1.5 leading-snug">
            {brief.why}
          </div>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
            Action today
          </div>
          <div className="caption text-normal mt-1.5 leading-snug">
            {brief.today}
          </div>
        </div>
      </div>
    </div>
  );
}

export const risk29DecisionFrame = defineFrame({
  ...risk29DecisionMeta,
  component: Risk29Decision,
});
