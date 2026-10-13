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
  const dataIssues = snapshot.signals.filter(
    (signal) =>
      signal.state === "unavailable" ||
      signal.freshness === "stale" ||
      signal.freshness === "error",
  ).length;
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


export type Risk29DecisionPosture =
  | "RISK-ON"
  | "SELECTIVE"
  | "DE-RISK"
  | "DEFENSIVE"
  | "REVIEW DATA";

export type Risk29DecisionBrief = {
  posture: Risk29DecisionPosture;
  headline: string;
  whatChanged: string;
  why: string;
  today: string;
  confidence: "normal" | "degraded";
};

export type Risk29ActionBias =
  | "ADD"
  | "HOLD"
  | "FAVOR"
  | "SELECTIVE"
  | "TRIM"
  | "REDUCE"
  | "RAISE"
  | "DEFEND"
  | "REVIEW";

export type Risk29ActionItem = {
  bucket: string;
  bias: Risk29ActionBias;
  rationale: string;
};

function topCategoryLabels(snapshot: Risk29Snapshot, limit = 2): string[] {
  return [...snapshot.categories]
    .filter((category) => category.score !== null)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, limit)
    .map((category) => `${category.label} ${category.score?.toFixed(0) ?? "—"}`);
}

/**
 * Produce a deterministic operator brief from the Risk29 snapshot. This is an
 * execution overlay, not a second model: posture comes only from the engine's
 * state and the explanation cites engine scores, changes and weighted drivers.
 */
export function risk29DecisionBrief(
  snapshot: Risk29Snapshot,
  previous?: Risk29HistoryPoint | null,
): Risk29DecisionBrief {
  const material = risk29MaterialStatus(snapshot, previous);
  const confidence =
    material.dataIssues > 0 || snapshot.score === null || snapshot.state === "unavailable"
      ? "degraded"
      : "normal";

  if (snapshot.score === null || snapshot.state === "unavailable") {
    return {
      posture: "REVIEW DATA",
      headline: "Risk29 cannot validate the current aggregate",
      whatChanged:
        material.dataIssues > 0
          ? `${material.dataIssues} data issue${material.dataIssues === 1 ? "" : "s"} require review`
          : "Current aggregate score is unavailable",
      why: "Missing inputs are not treated as low risk.",
      today: "Pause risk-budget changes that depend on Risk29 until data coverage is restored.",
      confidence: "degraded",
    };
  }

  const postureByState: Record<Risk29State, Risk29DecisionPosture> = {
    normal: "RISK-ON",
    watch: "SELECTIVE",
    warning: "DE-RISK",
    alert: "DEFENSIVE",
    unavailable: "REVIEW DATA",
  };
  const actionByState: Record<Risk29State, string> = {
    normal:
      "Keep the normal risk budget; add exposure only where conviction and trend already support it.",
    watch:
      "Keep risk selective: avoid chasing high beta, trim weak-conviction positions and preserve dry powder.",
    warning:
      "Reduce portfolio beta, favor quality/liquidity and raise a cash or short-duration buffer.",
    alert:
      "Prioritize capital preservation: cut fragile beta, protect liquidity and keep hedges active.",
    unavailable:
      "Pause Risk29-driven allocation changes until current data is validated.",
  };

  const categoryLabels = topCategoryLabels(snapshot, 2);
  const drivers = risk29TopDrivers(snapshot, 2);
  const driverLabels = drivers.map(
    ({ signal }) => `${signal.label} (${signal.riskScore?.toFixed(0) ?? "—"})`,
  );

  let whatChanged = "No material move versus the prior validated run.";
  if (material.overallStateChanged && previous) {
    whatChanged = `Overall state changed ${risk29StateLabel(previous.state)} → ${risk29StateLabel(snapshot.state)}.`;
  } else if (material.overallDelta !== null && Math.abs(material.overallDelta) >= 1) {
    const direction = material.overallDelta > 0 ? "rose" : "fell";
    whatChanged = `Risk29 ${direction} ${Math.abs(material.overallDelta).toFixed(1)} points versus the prior run.`;
  } else if (snapshot.changes.length > 0) {
    whatChanged = `${snapshot.changes.length} engine material signal change${snapshot.changes.length === 1 ? "" : "s"} detected.`;
  }

  const whyParts = [];
  if (categoryLabels.length > 0)
    whyParts.push(`highest categories: ${categoryLabels.join(", ")}`);
  if (driverLabels.length > 0)
    whyParts.push(`top drivers: ${driverLabels.join(", ")}`);
  if (material.dataIssues > 0)
    whyParts.push(`${material.dataIssues} data issue${material.dataIssues === 1 ? "" : "s"}`);

  return {
    posture: postureByState[snapshot.state],
    headline: `${risk29StateLabel(snapshot.state)} ${snapshot.score.toFixed(1)} · ${postureByState[snapshot.state]}`,
    whatChanged,
    why: whyParts.length > 0 ? whyParts.join(" · ") : "No live driver detail available.",
    today: actionByState[snapshot.state],
    confidence,
  };
}

/**
 * Convert the engine state into a small risk-budget playbook. These are
 * portfolio-control actions, not return forecasts for any asset class.
 */
export function risk29PortfolioActionMap(
  snapshot: Risk29Snapshot,
): Risk29ActionItem[] {
  if (snapshot.score === null || snapshot.state === "unavailable") {
    return [
      {
        bucket: "Risk budget",
        bias: "REVIEW",
        rationale: "Do not change exposure from an unvalidated aggregate.",
      },
      {
        bucket: "High beta / thematic",
        bias: "REVIEW",
        rationale: "Wait for valid risk coverage before adding or cutting from Risk29.",
      },
      {
        bucket: "Quality / defensive",
        bias: "HOLD",
        rationale: "Keep existing protection while data quality is checked.",
      },
      {
        bucket: "Cash / short duration",
        bias: "HOLD",
        rationale: "Maintain liquidity; avoid interpreting missing data as safety.",
      },
      {
        bucket: "Hedges",
        bias: "HOLD",
        rationale: "Do not remove protection solely because the model is unavailable.",
      },
    ];
  }

  const maps: Record<Exclude<Risk29State, "unavailable">, Risk29ActionItem[]> = {
    normal: [
      {
        bucket: "Risk budget",
        bias: "ADD",
        rationale: "Risk29 is normal; deploy selectively within existing mandate limits.",
      },
      {
        bucket: "High beta / thematic",
        bias: "SELECTIVE",
        rationale: "Can participate, but require supportive trend and position sizing.",
      },
      {
        bucket: "Quality / defensive",
        bias: "HOLD",
        rationale: "Keep core quality exposure rather than abandoning defense completely.",
      },
      {
        bucket: "Cash / short duration",
        bias: "HOLD",
        rationale: "Normal operating liquidity is sufficient.",
      },
      {
        bucket: "Hedges",
        bias: "HOLD",
        rationale: "Keep light structural hedges; no need to add from Risk29 alone.",
      },
    ],
    watch: [
      {
        bucket: "Risk budget",
        bias: "HOLD",
        rationale: "Keep gross exposure stable until the watch regime resolves.",
      },
      {
        bucket: "High beta / thematic",
        bias: "SELECTIVE",
        rationale: "Avoid chasing; trim weak-conviction names first.",
      },
      {
        bucket: "Quality / defensive",
        bias: "FAVOR",
        rationale: "Tilt incremental capital toward stronger balance sheets and liquidity.",
      },
      {
        bucket: "Cash / short duration",
        bias: "RAISE",
        rationale: "Build modest dry powder for volatility or better entry points.",
      },
      {
        bucket: "Hedges",
        bias: "HOLD",
        rationale: "Keep protection in place while material changes are monitored.",
      },
    ],
    warning: [
      {
        bucket: "Risk budget",
        bias: "TRIM",
        rationale: "Lower portfolio beta and reduce concentration.",
      },
      {
        bucket: "High beta / thematic",
        bias: "REDUCE",
        rationale: "Cut the weakest and least liquid exposures first.",
      },
      {
        bucket: "Quality / defensive",
        bias: "FAVOR",
        rationale: "Prefer resilience, liquidity and earnings visibility.",
      },
      {
        bucket: "Cash / short duration",
        bias: "RAISE",
        rationale: "Increase liquidity buffer and optionality.",
      },
      {
        bucket: "Hedges",
        bias: "ADD",
        rationale: "Add protection where cost and mandate permit.",
      },
    ],
    alert: [
      {
        bucket: "Risk budget",
        bias: "DEFEND",
        rationale: "Capital preservation takes priority over upside capture.",
      },
      {
        bucket: "High beta / thematic",
        bias: "REDUCE",
        rationale: "Aggressively reduce fragile, crowded or illiquid risk.",
      },
      {
        bucket: "Quality / defensive",
        bias: "FAVOR",
        rationale: "Concentrate remaining risk in resilient exposures.",
      },
      {
        bucket: "Cash / short duration",
        bias: "RAISE",
        rationale: "Keep a high liquidity buffer for drawdowns and dislocations.",
      },
      {
        bucket: "Hedges",
        bias: "ADD",
        rationale: "Keep active protection until the regime improves.",
      },
    ],
  };

  return maps[snapshot.state];
}
