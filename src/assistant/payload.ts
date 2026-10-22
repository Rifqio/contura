import type { TableFit } from "../api/types";

export { actionsFor } from "./context";
export type { AskContext } from "./context";

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** A preview size in compact units: 900 B, 2.3 KB, 1.5 MB. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${n(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${n(bytes / 1024)} KB`;
  return `${n(bytes)} B`;
}

/** The Core's token estimate, in words. */
export function tokensText(tokens: number): string {
  return `about ${n(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
}

/** "N full, M names only, K left out", only when the budget demoted any table. */
export function tablesLine(fit: TableFit): string | null {
  if (fit.namesOnly.length === 0 && fit.leftOut.length === 0) return null;
  return `${n(fit.full.length)} full, ${n(fit.namesOnly.length)} names only, ${n(fit.leftOut.length)} left out`;
}
