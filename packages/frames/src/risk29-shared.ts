import type {
  Risk29Direction,
  Risk29Freshness,
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

export function risk29DirectionLabel(direction?: Risk29Direction): string {
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

export function risk29DirectionColor(direction?: Risk29Direction): string {
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

export function formatRisk29Value(
  value: number | null,
  unit: string,
): string {
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
