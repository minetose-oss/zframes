import { defineFrame } from "@zframes/core";
import { useRisk29History, useRisk29Snapshot } from "@zframes/core/risk29";
import type { z } from "zod";
import {
  risk29MaterialStatus,
  risk29StateColor,
  risk29StateLabel,
  risk29TopDrivers,
} from "./risk29-shared";
import { risk29ChangesMeta } from "./schemas/risk29";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = risk29ChangesMeta.schema;

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function Risk29Changes({ config }: { config: z.output<typeof schema> }) {
  const { snapshot, isLoading, error } = useRisk29Snapshot(config.refreshMs);
  const { history, isLoading: historyLoading } = useRisk29History(
    Math.max(config.refreshMs, 5 * 60_000),
  );

  if (isLoading)
    return <FrameStatus loading>loading Risk29 decision radar…</FrameStatus>;
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

  const material = risk29MaterialStatus(snapshot, previous);
  const drivers = risk29TopDrivers(snapshot, Math.min(config.maxItems, 5));
  const strongestSignalChange = [...snapshot.changes].sort(
    (a, b) => Math.abs(b.scoreDelta ?? 0) - Math.abs(a.scoreDelta ?? 0),
  )[0];
  const strongestCategoryMove = material.categoryMoves[0];
  const snapshotAgeMs = Date.now() - generatedAtMs;
  const snapshotOutdated =
    !Number.isFinite(generatedAtMs) ||
    snapshotAgeMs < -5 * 60_000 ||
    snapshotAgeMs > 24 * 60 * 60_000;
  const needsReview = material.isMaterial || snapshotOutdated || (historyLoading && !previous);
  const reviewColor = risk29StateColor(needsReview ? "warning" : "normal");


  const reasonParts: string[] = [];
  if (material.overallStateChanged && previous)
    reasonParts.push(
      `overall ${risk29StateLabel(previous.state)} → ${risk29StateLabel(snapshot.state)}`,
    );
  if (material.overallDelta !== null && Math.abs(material.overallDelta) >= 5)
    reasonParts.push(`Risk29 ${signed(material.overallDelta)} pts`);
  if (material.signalChanges > 0)
    reasonParts.push(
      `${material.signalChanges} signal change${material.signalChanges === 1 ? "" : "s"}`,
    );
  if (strongestCategoryMove)
    reasonParts.push(
      `${strongestCategoryMove.label} ${signed(strongestCategoryMove.delta)} pts`,
    );
  if (material.dataIssues > 0)
    reasonParts.push(
      `${material.dataIssues} data issue${material.dataIssues === 1 ? "" : "s"}`,
    );
  if (snapshot.score === null || snapshot.state === "unavailable")
    reasonParts.push("overall score unavailable — review coverage");
  if (snapshotOutdated)
    reasonParts.push("snapshot is older than 24h or has invalid timestamp");
  if (historyLoading && !previous)
    reasonParts.push("waiting for previous snapshot comparison");

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${scrollAreaClass}`}>
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="caption text-soft font-bold tracking-[0.06em] uppercase">
              Material Change
            </div>
            <div className="body-sm text-strong mt-1 font-semibold">
              {needsReview ? "Review required" : "No material change"}
            </div>
          </div>
          <span
            className="caption shrink-0 rounded-full border px-2 py-0.5 font-bold tracking-[0.06em]"
            style={{
              color: reviewColor,
              borderColor: `color-mix(in srgb, ${reviewColor} 42%, transparent)`,
            }}
          >
            {needsReview ? "REVIEW" : "CLEAR"}
          </span>
        </div>

        <div className="caption text-soft mt-1.5 leading-snug">
          {historyLoading && !previous
            ? "Checking the prior run…"
            : reasonParts.length > 0
              ? reasonParts.join(" · ")
              : "No ≥5-point aggregate/category move, engine material signal change, or data-health issue."}
        </div>

        {strongestSignalChange && (
          <div className="caption text-soft mt-1.5 truncate">
            Strongest change:{" "}
            <span className="text-normal font-semibold">
              {strongestSignalChange.label}
            </span>
            {strongestSignalChange.scoreDelta !== null
              ? ` ${signed(strongestSignalChange.scoreDelta)}`
              : ""}
          </div>
        )}
      </div>

      <div className="caption text-soft flex items-center justify-between px-0.5 pt-0.5 font-bold tracking-[0.06em] uppercase">
        <span>Top Risk Drivers</span>
        <span>impact</span>
      </div>

      {drivers.length === 0 ? (
        <FrameStatus>no live Risk29 drivers</FrameStatus>
      ) : (
        drivers.map(({ signal, contribution }, index) => {
          const color = risk29StateColor(signal.state);
          return (
            <div
              key={signal.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="body-sm text-strong truncate font-semibold">
                    {index + 1}. {signal.label}
                  </div>
                  <div className="caption text-soft mt-0.5 truncate capitalize">
                    {signal.category} · risk{" "}
                    {signal.riskScore?.toFixed(0) ?? "—"} ·{" "}
                    <span style={{ color }}>
                      {risk29StateLabel(signal.state)}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className="body-sm font-bold tabular-nums"
                    style={{ color }}
                  >
                    +{contribution.toFixed(1)}
                  </div>
                  <div className="caption text-soft">pts</div>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export const risk29ChangesFrame = defineFrame({
  ...risk29ChangesMeta,
  component: Risk29Changes,
});
