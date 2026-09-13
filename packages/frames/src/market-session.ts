import type { MarketSnapshot } from "@zframes/spec";
import { ABSENT } from "./format";

/**
 * Shared wording for a venue snapshot's session state and timestamp, so the
 * index board and the breadth card say the same thing the same way.
 */
const SESSION_LABELS: Record<MarketSnapshot["status"], string> = {
  open: "Open",
  closed: "Closed",
  "pre-open": "Pre-open",
  unknown: "Status unknown",
};

export function sessionLabel(status: MarketSnapshot["status"]): string {
  return SESSION_LABELS[status];
}

/**
 * The exchange's own clock, not the reader's: a Thai venue stamps its board in
 * Bangkok time, and re-rendering that in the viewer's zone would make the same
 * session look like it closed at different hours on different boards. Thailand
 * has never observed DST, so the zone abbreviation is a constant.
 */
const ICT_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function asOfIct(time: number): string {
  if (!Number.isFinite(time)) return ABSENT;
  return `${ICT_STAMP.format(new Date(time)).replace(",", "")} ICT`;
}
