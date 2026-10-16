// The run state of one query tab: its result tabs, the statements still to run,
// and a pending confirmation. Pure, so the rules are tested without a server.
import { isCommandError } from "../api/client";
import type { Cell, ExecOutcome, ResultColumn } from "../api/types";
import type { Stmt } from "./statements";

export type RunState =
  | { s: "running" }
  | { s: "rows"; columns: ResultColumn[]; rows: Cell[][]; hasMore: boolean; open: boolean; ms: number }
  | { s: "affected"; rows: number; ms: number }
  /** `at` is where the error points, as an offset into the editor text. */
  | { s: "error"; message: string; at: number }
  | { s: "cancelled"; ms: number }
  | { s: "timedOut"; secs: number };

export interface ResultItem {
  id: number;
  sql: string;
  from: number;
  to: number;
  pinned: boolean;
  startedAt: number;
  state: RunState;
}

export interface RunnerState {
  items: ResultItem[];
  active: number;
  queue: Stmt[];
  confirm: { stmt: Stmt; verb: "UPDATE" | "DELETE"; table: string } | null;
  nextId: number;
}

export const EMPTY_RUNNER: RunnerState = { items: [], active: 0, queue: [], confirm: null, nextId: 1 };

export type RunnerAction =
  | { type: "start"; stmts: Stmt[] }
  /** Takes the first queued statement and marks it running. */
  | { type: "begin"; now: number }
  | { type: "done"; id: number; outcome: ExecOutcome; ms: number }
  | { type: "failed"; id: number; error: unknown; ms?: number }
  | { type: "confirmNeeded"; verb: "UPDATE" | "DELETE"; table: string }
  | { type: "confirmed" }
  | { type: "declined" }
  | { type: "more"; id: number; rows: Cell[][]; hasMore: boolean }
  | { type: "select"; index: number }
  | { type: "pin"; id: number }
  | { type: "closeUnpinned" }
  | { type: "closeItem"; id: number }
  /** The tab's session closed or changed: nothing more runs, and no result can fetch more. */
  | { type: "sessionChanged" };

const POSITION = / \(position (\d+)\)$/;

/** The server's message and the offset it points at, from a Postgres "(position N)" suffix. */
function errorState(error: unknown, item: ResultItem): RunState {
  if (isCommandError(error)) {
    if (error.kind === "cancelled") return { s: "cancelled", ms: 0 };
    if (error.kind === "timedOut") return { s: "timedOut", secs: error.message };
    if (typeof error.message === "string") {
      const m = POSITION.exec(error.message);
      const at = m ? item.from + Number(m[1]) - 1 : item.from;
      return { s: "error", message: error.message.replace(POSITION, ""), at };
    }
    return { s: "error", message: error.kind, at: item.from };
  }
  return { s: "error", message: error instanceof Error ? error.message : String(error), at: item.from };
}

function update(state: RunnerState, id: number, f: (i: ResultItem) => ResultItem): RunnerState {
  return { ...state, items: state.items.map((i) => (i.id === id ? f(i) : i)) };
}

/** Only one result per session can still fetch rows: the newest. */
const closeOpen = (items: ResultItem[]) =>
  items.map((i) => (i.state.s === "rows" && i.state.open ? { ...i, state: { ...i.state, open: false } } : i));

export function runnerReducer(state: RunnerState, action: RunnerAction): RunnerState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        items: closeOpen(state.items.filter((i) => i.pinned)),
        active: 0,
        queue: action.stmts,
        confirm: null,
      };
    case "begin": {
      const [stmt, ...rest] = state.queue;
      if (!stmt) return state;
      const item: ResultItem = {
        id: state.nextId,
        sql: stmt.text,
        from: stmt.from,
        to: stmt.to,
        pinned: false,
        startedAt: action.now,
        state: { s: "running" },
      };
      const items = [...closeOpen(state.items), item];
      return { ...state, items, active: items.length - 1, queue: rest, confirm: null, nextId: state.nextId + 1 };
    }
    case "done": {
      const { outcome, ms } = action;
      return update(state, action.id, (i) => ({
        ...i,
        state:
          outcome.t === "rows"
            ? { s: "rows", columns: outcome.columns, rows: outcome.rows, hasMore: outcome.hasMore, open: outcome.hasMore, ms }
            : { s: "affected", rows: outcome.rows, ms },
      }));
    }
    case "failed": {
      const next = update(state, action.id, (i) => {
        const st = errorState(action.error, i);
        return { ...i, state: st.s === "cancelled" ? { s: "cancelled", ms: action.ms ?? 0 } : st };
      });
      // Run all stops at the first failure.
      return { ...next, queue: [] };
    }
    case "confirmNeeded": {
      const stmt = state.queue[0];
      return stmt ? { ...state, confirm: { stmt, verb: action.verb, table: action.table } } : state;
    }
    case "confirmed":
      return { ...state, confirm: null };
    case "declined":
      return { ...state, confirm: null, queue: [] };
    case "more":
      return update(state, action.id, (i) =>
        i.state.s === "rows"
          ? {
              ...i,
              state: {
                ...i.state,
                rows: [...i.state.rows, ...action.rows],
                hasMore: action.hasMore,
                open: i.state.open && action.hasMore,
              },
            }
          : i,
      );
    case "select":
      return { ...state, active: Math.max(0, Math.min(action.index, state.items.length - 1)) };
    case "pin":
      return update(state, action.id, (i) => ({ ...i, pinned: !i.pinned }));
    case "closeUnpinned":
      return { ...state, items: state.items.filter((i) => i.pinned || i.state.s === "running"), active: 0 };
    case "sessionChanged":
      return { ...state, items: closeOpen(state.items), queue: [], confirm: null };
    case "closeItem": {
      const items = state.items.filter((i) => i.id !== action.id);
      return { ...state, items, active: Math.min(state.active, Math.max(0, items.length - 1)) };
    }
  }
}
