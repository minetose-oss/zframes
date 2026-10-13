import type {
  Risk29Direction,
  Risk29Freshness,
  Risk29HistoryPoint,
  Risk29Signal,
  Risk29Snapshot,
  Risk29State,
} from "@zframes/spec/risk29";
import { DOWN_COLOR, UP_COLOR } from "./format";

/** Dashboard accent expressed through zframes' existing theme variables. */
export const RISK29_ACCENT =
  "hsl(var(--zf-accent-hue, 242) var(--zf-accent-sat, 90%) 72%)";

/** Quiet text colour that follows dark/light surface mode. */
export const RISK29_MUTED = "hsl(0 0% var(--zf-ink-l, 100%) / 0.46)";

/**
 * Risk29 state colour is presentation only. The engine supplies the state;
 * frames never derive a state from score thresholds.
 */
export function risk29StateColor(state: Risk29State): string {
  switch (state) {
    case "normal":
      return UP_COLOR;
    case "watch":
      return RISK29_ACCENT;
    case "warning":
      return `color-mix(in srgb, ${DOWN_COLOR} 55%, ${RISK29_ACCENT})`;
    case "alert":
      return DOWN_COLOR;
    case "unavailable":
      return RISK29_MUTED;
  }
}

export function risk29StateLabel(state: Risk29State): string {
  return state === "unavailable" ? "NO DATA" : state.toUpperCase();
}

export function risk29DirectionLabel(
  direction?: Risk29Direction | null,
): string {
  switch (direction) {
    case "improving":
      return "↓ improving";
    case "worsening":
      return "↑ worsening";
    case "flat":
      return "→ flat";
    default:
      return "—";
  }
}

export function risk29DirectionColor(
  direction?: Risk29Direction | null,
): string {
  switch (direction) {
    case "improving":
      return UP_COLOR;
    case "worsening":
      return DOWN_COLOR;
    default:
      return RISK29_MUTED;
  }
}

export function risk29FreshnessColor(freshness: Risk29Freshness): string {
  switch (freshness) {
    case "fresh":
      return UP_COLOR;
    case "delayed":
      return RISK29_ACCENT;
    case "stale":
      return `color-mix(in srgb, ${DOWN_COLOR} 55%, ${RISK29_ACCENT})`;
    case "error":
      return DOWN_COLOR;
  }
}

export function formatRisk29Value(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";

  const magnitude = Math.abs(value);
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: magnitude < 10 ? 2 : magnitude < 100 ? 1 : 0,
    maximumFractionDigits: magnitude < 10 ? 2 : magnitude < 100 ? 1 : 0,
  });

  switch (unit) {
    case "percent":
      return `${formatted}%`;
    case "pct-points":
      return `${formatted} pp`;
    case "usd/oz":
      return `$${formatted}/oz`;
    case "index":
      return formatted;
    default:
      return unit ? `${formatted} ${unit}` : formatted;
  }
}

export type Risk29Driver = {
  signal: Risk29Signal;
  contribution: number;
};

export type Risk29CategoryMove = {
  id: string;
  label: string;
  delta: number;
};

export type Risk29MaterialStatus = {
  isMaterial: boolean;
  overallDelta: number | null;
  overallStateChanged: boolean;
  categoryMoves: Risk29CategoryMove[];
  signalChanges: number;
  dataIssues: number;
};

/**
 * Rank the current live signals by their estimated contribution to the
 * aggregate Risk29 score. Categories are equal-weight averages of their usable
 * signals upstream, so each signal receives an equal share of its category
 * weight. Active weight mirrors the engine's normalization when a whole
 * category is unavailable.
 */
export function risk29TopDrivers(
  snapshot: Risk29Snapshot,
  limit = 5,
): Risk29Driver[] {
  if (limit <= 0) return [];

  const activeCategories = snapshot.categories.filter(
    (category) => category.score !== null && category.weight > 0,
  );
  const activeWeight = activeCategories.reduce(
    (sum, category) => sum + category.weight,
    0,
  );
  if (activeWeight <= 0) return [];

  const byId = new Map(
    activeCategories.map((category) => [category.id, category]),
  );

  return snapshot.signals
    .filter(
      (signal) =>
        signal.riskScore !== null &&
        signal.state !== "unavailable" &&
        signal.freshness !== "error",
    )
    .map((signal) => {
      const category = byId.get(signal.category);
      const divisor = category?.availableSignals ?? 0;
      const contribution =
        category && divisor > 0 && signal.riskScore !== null
          ? (signal.riskScore * category.weight) / divisor / activeWeight
          : 0;
      return { signal, contribution };
    })
    .filter((item) => item.contribution > 0)
    .sort(
      (a, b) =>
        b.contribution - a.contribution ||
        (b.signal.riskScore ?? 0) - (a.signal.riskScore ?? 0),
    )
    .slice(0, limit);
}

/**
 * Decide whether the latest run deserves attention without inventing a second
 * set of signal thresholds in the UI. Signal-level materiality comes directly
 * from snapshot.changes (engine rule: state transition or >=5 score points).
 * The productivity layer adds aggregate/category movement and data-health
 * checks so the operator can see meaningful changes at a glance.
 */
export function risk29MaterialStatus(
  snapshot: Risk29Snapshot,
  previous?: Risk29HistoryPoint | null,
): Risk29MaterialStatus {
  const overallDelta =
    previous?.score === null ||
    previous?.score === undefined ||
    snapshot.score === null
      ? null
      : snapshot.score - previous.score;

  const overallStateChanged =
    previous !== null &&
    previous !== undefined &&
    previous.state !== snapshot.state;

  const categoryMoves = snapshot.categories
    .flatMap((category) => {
      const prior = previous?.categoryScores[category.id];
      if (
        prior === undefined ||
        category.score === null ||
        !Number.isFinite(prior)
      )
        return [];
      const delta = category.score - prior;
      return Math.abs(delta) >= 5
        ? [{ id: category.id, label: category.label, delta }]
        : [];
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // A failed-closed aggregate must never be displayed as "CLEAR".
  // Delayed sources are visible for operator review, but are not escalated
  // until the engine marks them stale/error or coverage becomes unavailable.
  const unavailableSignals = snapshot.signals.filter(
    (signal) => signal.state === "unavailable",
  ).length;
  const dataIssues =
    snapshot.health.stale +
    snapshot.health.errored +
    Math.max(0, unavailableSignals - snapshot.health.errored);
  const isMaterial =
    snapshot.changes.length > 0 ||
    overallStateChanged ||
    (overallDelta !== null && Math.abs(overallDelta) >= 5) ||
    categoryMoves.length > 0 ||
    dataIssues > 0 ||
    snapshot.score === null ||
    snapshot.state === "unavailable";

  return {
    isMaterial,
    overallDelta,
    overallStateChanged,
    categoryMoves,
    signalChanges: snapshot.changes.length,
    dataIssues,
  };
}
