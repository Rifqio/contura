import type { Preview, RowsSent, TableFit } from "../api/types";

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

/** The Core's label for a Sample rows item that found no table to read. */
export const ROWS_NO_TABLE = "Sample rows · no named table";

/** What the Core's Sample rows item says: on (and not locked), allowed (not locked), and whether no table was named. */
export function rowsState(preview: Preview | null): { on: boolean; allowed: boolean; none: boolean } {
  const item = preview?.items.find((i) => i.kind === "rows");
  const allowed = !!item && item.locked === null;
  return { on: allowed && !!item?.on, allowed, none: allowed && !!item?.on && item?.label === ROWS_NO_TABLE };
}

/** The line under the composer and in the inline box: what the sample rows of this Ask are (board 11.9). */
export function rowsLine(state: { on: boolean; none: boolean }, read: RowsSent | null): string {
  if (state.on && state.none) return "No sample rows are sent: no table is named";
  if (!state.on || !read || read.rows === 0) return "No sample rows are sent";
  const g = (v: number) => v.toLocaleString("en-US");
  return `Sends ${g(read.rows)} sample ${read.rows === 1 ? "row" : "rows"} from ${g(read.tables)} ${read.tables === 1 ? "table" : "tables"}, not kept`;
}

/** The inline box's state line (board 11.9), shown only while the switch is allowed. */
export function rowsStateLine(on: boolean): string {
  return on ? "Sample rows are on for this Ask only." : "Sample rows are off. They start off on every Ask.";
}
