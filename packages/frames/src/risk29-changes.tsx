import { defineFrame } from "@zframes/core";
import { useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import { risk29ChangesMeta } from "./schemas/risk29";
import { FrameStatus, scrollAreaClass } from "./ui";
import { risk29StateColor, risk29StateLabel } from "./risk29-shared";

const schema = risk29ChangesMeta.schema;

function Risk29Changes({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);

  if (isLoading)
    return <FrameStatus loading>loading Risk29 changes…</FrameStatus>;
  if (error)
    return (
      <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>
    );
  if (!snapshot) return <FrameStatus>no current Risk29 snapshot</FrameStatus>;

  if (snapshot.changes.length === 0) {
    const focus = [...snapshot.signals]
      .filter(
        (signal) =>
          signal.riskScore !== null &&
          signal.state !== "unavailable" &&
          signal.freshness !== "error",
      )
      .sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0))
      .slice(0, 3);

    return (
      <div className={`flex h-full min-h-0 flex-col gap-2 ${scrollAreaClass}`}>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
          <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
            No material state changes
          </div>
          <div className="caption text-soft mt-1 leading-snug">
            No signal changed Risk29 state since the prior run. Current highest-risk
            live signals are shown below.
          </div>
        </div>

        {focus.map((signal) => {
          const color = risk29StateColor(signal.state);
          return (
            <div
              key={signal.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="body-sm text-strong truncate font-semibold">
                    {signal.label}
                  </div>
                  <div className="caption text-soft mt-1 capitalize">
                    Current focus · {signal.category}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className="body-sm font-bold tabular-nums"
                    style={{ color }}
                  >
                    {signal.riskScore?.toFixed(0)}
                  </div>
                  <div
                    className="caption mt-0.5 font-bold tracking-[0.05em]"
                    style={{ color }}
                  >
                    {risk29StateLabel(signal.state)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const changes = [...snapshot.changes]
    .sort((a, b) => Math.abs(b.scoreDelta ?? 0) - Math.abs(a.scoreDelta ?? 0))
    .slice(0, config.maxItems);

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${scrollAreaClass}`}>
      {changes.map((change) => {
        const color = risk29StateColor(change.toState);
        const delta = change.scoreDelta;

        return (
          <div
            key={`${change.signalId}-${change.fromState}-${change.toState}`}
            className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="body-sm text-strong truncate font-semibold">
                  {change.label}
                </div>
                <div className="caption text-soft mt-1 leading-snug">
                  {change.summary}
                </div>
              </div>
              {delta !== null && (
                <span
                  className="body-sm shrink-0 font-bold tabular-nums"
                  style={{
                    color:
                      delta > 0
                        ? risk29StateColor("alert")
                        : delta < 0
                          ? risk29StateColor("normal")
                          : "currentColor",
                  }}
                >
                  {delta > 0 ? "+" : ""}
                  {delta.toFixed(0)}
                </span>
              )}
            </div>

            <div className="caption mt-2 flex items-center gap-1.5 font-bold tracking-[0.05em]">
              <span style={{ color: risk29StateColor(change.fromState) }}>
                {risk29StateLabel(change.fromState)}
              </span>
              <span className="text-soft">→</span>
              <span style={{ color }}>{risk29StateLabel(change.toState)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const risk29ChangesFrame = defineFrame({
  ...risk29ChangesMeta,
  component: Risk29Changes,
});
