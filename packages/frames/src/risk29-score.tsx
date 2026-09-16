import { defineFrame } from "@zframes/core";
import {
  useRisk29History,
  useRisk29Snapshot,
} from "@zframes/core/risk29";
import type { Risk29State } from "@zframes/spec/risk29";
import type { z } from "zod";
import { CardHeader } from "./card-header";
import { DOWN_COLOR, UP_COLOR } from "./format";
import { risk29ScoreMeta } from "./schemas/risk29";
import { FrameStatus } from "./ui";

const schema = risk29ScoreMeta.schema;

const WATCH_COLOR = "#facc15";
const WARNING_COLOR = "#fb923c";

function stateColor(state: Risk29State): string {
  switch (state) {
    case "normal":
      return UP_COLOR;
    case "watch":
      return WATCH_COLOR;
    case "warning":
      return WARNING_COLOR;
    case "alert":
      return DOWN_COLOR;
    case "unavailable":
      return "currentColor";
  }
}

function prettyRegime(regime: string): string {
  return regime
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function bangkokTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function GlobalRisk29({ config }: { config: z.output<typeof schema> }) {
  const {
    snapshot,
    isLoading: snapshotLoading,
    error: snapshotError,
  } = useRisk29Snapshot(config.refreshMs);
  const { history, isLoading: historyLoading } = useRisk29History(
    Math.max(config.refreshMs, 5 * 60_000),
  );

  if (snapshotLoading)
    return <FrameStatus loading>loading Risk29 snapshot…</FrameStatus>;

  // Risk29 deliberately does not keep a stale last-good snapshot in the
  // provider after a failed refresh. If the service cannot validate a current
  // payload, make that failure visible rather than showing an old score as live.
  if (snapshotError)
    return <FrameStatus>Risk29 unavailable — current snapshot failed</FrameStatus>;

  if (!snapshot || snapshot.score === null)
    return <FrameStatus>no current Risk29 score</FrameStatus>;

  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const previous = history?.points
    .filter(
      (point) =>
        point.score !== null &&
        Number.isFinite(point.time) &&
        (!Number.isFinite(generatedAtMs) || point.time < generatedAtMs),
    )
    .at(-1);
  const scoreDelta =
    previous?.score === null || previous?.score === undefined
      ? null
      : snapshot.score - previous.score;

  const color = stateColor(snapshot.state);
  const stateLabel = snapshot.state.toUpperCase();
  const health = snapshot.health;
  const healthLabel = `${health.available}/${health.total} available`;
  const freshnessLabel =
    health.errored > 0
      ? `${health.errored} error${health.errored === 1 ? "" : "s"}`
      : health.stale > 0
        ? `${health.stale} stale`
        : "current";

  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-3">
      <CardHeader align="start">
        <CardHeader.Main>
          <CardHeader.Eyebrow>GLOBAL RISK29</CardHeader.Eyebrow>
          <CardHeader.Sub ink="normal">
            {prettyRegime(snapshot.regime)}
          </CardHeader.Sub>
        </CardHeader.Main>
        <CardHeader.Aside>
          <span
            className="caption rounded-full border px-2 py-0.5 font-bold tracking-[0.08em]"
            style={{ color, borderColor: `color-mix(in srgb, ${color} 42%, transparent)` }}
          >
            {stateLabel}
          </span>
        </CardHeader.Aside>
      </CardHeader>

      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div
            className="metric-xl leading-none tabular-nums"
            style={{ color, textShadow: `0 0 24px ${color}44` }}
          >
            {snapshot.score.toFixed(1)}
            <span className="body-sm text-soft ml-1 font-normal">/ 100</span>
          </div>
          <div className="caption text-soft mt-1">
            {scoreDelta === null ? (
              historyLoading ? (
                "loading prior run…"
              ) : (
                "no prior run"
              )
            ) : (
              <span style={{ color: scoreDelta > 0 ? DOWN_COLOR : scoreDelta < 0 ? UP_COLOR : "currentColor" }}>
                {scoreDelta > 0 ? "↑" : scoreDelta < 0 ? "↓" : "→"} {scoreDelta > 0 ? "+" : ""}
                {scoreDelta.toFixed(1)} vs prior
              </span>
            )}
          </div>
        </div>

        <div className="caption text-soft max-w-[46%] text-right leading-snug">
          <span className="text-normal">{healthLabel}</span>
          <br />
          {freshnessLabel}
        </div>
      </div>

      <div className="caption text-soft flex items-center justify-between gap-3 border-t border-white/[0.08] pt-2">
        <span className="truncate">model {snapshot.modelVersion}</span>
        <span className="shrink-0 tabular-nums">
          {bangkokTime(snapshot.generatedAt)} BKK
        </span>
      </div>
    </div>
  );
}

export const risk29ScoreFrame = defineFrame({
  ...risk29ScoreMeta,
  component: GlobalRisk29,
});
