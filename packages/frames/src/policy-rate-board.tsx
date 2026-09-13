import { defineFrame, usePolicyRates } from "@zframes/core";
import type { z } from "zod";
import { changeColor, formatPct } from "./format";
import { MetricRow } from "./metric-row";
import { policyRateBoardMeta } from "./schemas";
import { FrameStatus, scrollAreaClass } from "./ui";

const schema = policyRateBoardMeta.schema;

/**
 * How far the rate moved, and when. In BASIS POINTS: a cut from 1.25 to 1.00 is
 * 25 bp, and calling it "-20%" would state a different quantity entirely.
 */
function moveNote(rate: number, prev: number, changedOn?: string): string {
  const bps = Math.round((rate - prev) * 100);
  const since = changedOn ? ` since ${changedOn.slice(0, 7)}` : "";
  return `${bps >= 0 ? "+" : ""}${bps} bp${since}`;
}

function PolicyRateBoard({ config }: { config: z.output<typeof schema> }) {
  const { rates, isLoading } = usePolicyRates(config.countries);

  if (isLoading && rates.length === 0)
    return <FrameStatus loading>loading policy rates…</FrameStatus>;
  if (rates.length === 0) return <FrameStatus>no policy rates yet</FrameStatus>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={scrollAreaClass}>
        {rates.map((rate) => {
          const prev = config.showChange ? rate.prev : undefined;
          return (
            <MetricRow
              key={rate.country}
              label={rate.bank}
              meta={
                prev === undefined ? (
                  rate.country
                ) : (
                  <span style={{ color: changeColor(rate.rate - prev) }}>
                    {rate.country} · {moveNote(rate.rate, prev, rate.changedOn)}
                  </span>
                )
              }
              value={
                <span className="tabular-nums">{formatPct(rate.rate)}</span>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

export const policyRateBoardFrame = defineFrame({
  ...policyRateBoardMeta,
  component: PolicyRateBoard,
});
