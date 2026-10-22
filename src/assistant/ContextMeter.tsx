import { formatWindow } from "../settings/ai/providers";

export interface MeterPart {
  label: string;
  tokens: number;
}

interface Props {
  used: number;
  window: number;
  parts: MeterPart[];
  /** True once the provider reported the count; before that it is the preview's estimate. */
  exact: boolean;
}

/** A token count in compact units: 412, 9K, 18.4K, 1.3M. */
export function formatTokens(n: number): string {
  const short = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  // 999,960 rounds to 1,000K, so it reads 1M.
  if (n >= 999_950) return `${short(n / 1_000_000)}M`;
  if (n >= 1000) return `${short(n / 1000)}K`;
  return n.toLocaleString("en-US");
}

/** The share of the window in use, in percent with one decimal. */
export const meterPercent = (used: number, window: number) =>
  window > 0 ? Math.round((used / window) * 1000) / 10 : 0;

/** Amber from 75%, red from 90%. */
export const meterTone = (pct: number) => (pct >= 90 ? "bad" : pct >= 75 ? "warn" : "");

export const meterTitle = (used: number, window: number, exact: boolean) =>
  `${exact ? "" : "About "}${used.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens in use`;

/** "schema 9.1K, current statement 2.4K" */
export const partsText = (parts: MeterPart[]) => parts.map((p) => `${p.label} ${formatTokens(p.tokens)}`).join(", ");

/** The fill of a meter bar, at least a sliver so an empty window still shows the bar. */
export function MeterFill({ used, window }: { used: number; window: number }) {
  const pct = meterPercent(used, window);
  // The tone reads the unrounded share, so 74.96% stays plain.
  const tone = meterTone(window > 0 ? (used / window) * 100 : 0);
  return <span className={tone ? `meter-fill ${tone}` : "meter-fill"} style={{ width: `${Math.min(100, Math.max(1, pct))}%` }} />;
}

/** The band on top of the composer box: "Context", the bar and "18.4K / 1M" (board 11.1). */
export default function ContextMeter({ used, window, parts, exact }: Props) {
  const pct = meterPercent(used, window);
  const short = `${formatTokens(used)} / ${formatWindow(window)}`;
  return (
    <div className="comp-meter" title={meterTitle(used, window, exact)}>
      <span>Context</span>
      <span
        className="meter-bar"
        role="meter"
        aria-label="Context window in use"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={parts.length > 0 ? `${short}: ${partsText(parts)}` : short}
      >
        <MeterFill used={used} window={window} />
      </span>
      <span className="meter-n">{short}</span>
    </div>
  );
}
