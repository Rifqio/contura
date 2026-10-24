// UX step 8: Back and Forward over followed Foreign Keys (Edge, DataGrip Ctrl+Alt+Left). Browser semantics: a new
// jump drops the Forward list, and Back returns to the tab and cell you left, opening the tab again when it was
// closed. One history per window, at most NAV_LIMIT places each way.
import type { SortSpec } from "../api/types";
import type { Selection } from "../shell/tabs";
import type { RowFilter } from "./rowFilters";

export const NAV_LIMIT = 50;

/** A place in a table tab: the tab, how to open it again, its filters, page and active cell. */
export interface NavSpot {
  key: string;
  selection: Selection;
  preview: boolean;
  filters: RowFilter[];
  /** The WHERE the filters make, as the grid worked it out. */
  where: string | null;
  page: number;
  sort: SortSpec | null;
  /** The active cell: the row on its page, its primary key (null without one) and the column by name. */
  cell: { row: number; column: string; key?: string | null } | null;
}

export interface NavHistory {
  /** Older places, the last one nearest. */
  back: NavSpot[];
  /** Places Back left, the last one nearest. */
  forward: NavSpot[];
}

export const emptyNav: NavHistory = { back: [], forward: [] };

const bounded = (list: NavSpot[]) => (list.length > NAV_LIMIT ? list.slice(list.length - NAV_LIMIT) : list);

/** A jump from `from`: it goes on the Back list and the Forward list is dropped. */
export function navPush(h: NavHistory, from: NavSpot): NavHistory {
  return { back: bounded([...h.back, from]), forward: [] };
}

/** Back from `here` (null when no table tab is shown); null when there is nothing to go back to. */
export function navBack(h: NavHistory, here: NavSpot | null): { history: NavHistory; to: NavSpot } | null {
  const to = h.back[h.back.length - 1];
  if (!to) return null;
  return { to, history: { back: h.back.slice(0, -1), forward: here ? bounded([...h.forward, here]) : h.forward } };
}

export function navForward(h: NavHistory, here: NavSpot | null): { history: NavHistory; to: NavSpot } | null {
  const to = h.forward[h.forward.length - 1];
  if (!to) return null;
  return { to, history: { forward: h.forward.slice(0, -1), back: here ? bounded([...h.back, here]) : h.back } };
}
