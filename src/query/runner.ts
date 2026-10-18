// The run state of one query tab: its result tabs, the statements still to run,
// and a pending confirmation. Pure, so the rules are tested without a server.
import { errorText, isCommandError } from "../api/client";
import type { Cell, ExecOutcome, PassId, Plan, ResultColumn, RunVerdict } from "../api/types";
import type { Stmt } from "./statements";

/** A run on a Production Connection waiting for its confirmation dialog. */
export interface RunAsk {
  verdict: Extract<RunVerdict, { kind: "needsConfirmation" }>;
  stmts: Stmt[];
  /** The rest of a run whose pass ran out: its earlier results stay. */
  continue?: boolean;
  /** A reconnect's re-run of one statement: see `Rerun`. */
  rerun?: Rerun;
}

/**
 * "Reconnect and run statement N" (R43): only statement N runs, keeping its number; the lost
 * result `drop` gives way to it, and the statements after it stay not run, with their numbers.
 */
export interface Rerun {
  /** Statements of the run before this one, so it is numbered N. */
  ran: number;
  /** The statements after it that did not run. */
  after: Stmt[];
  /** The lost result the re-run replaces. */
  drop: number;
}

export type RunState =
  | { s: "running" }
  | { s: "rows"; columns: ResultColumn[]; rows: Cell[][]; hasMore: boolean; open: boolean; ms: number }
  | { s: "affected"; rows: number; ms: number }
  /** An Explain answer, shown in its own Plan tab. */
  | { s: "plan"; plan: Plan; ms: number }
  /**
   * `at` is where the error points, as an offset into the editor text. `index` is the statement's place in its
   * run, `notRun` the statements after it that did not run, `lost` a dropped connection, `own` a message said by
   * Contura rather than the server.
   */
  | {
      s: "error";
      message: string;
      at: number;
      refused?: boolean;
      own?: boolean;
      lost?: boolean;
      index?: number;
      notRun?: Stmt[];
      /** How long the failed statement took. */
      ms?: number;
    }
  | { s: "cancelled"; ms: number }
  | { s: "timedOut"; secs: number }
  /** Stopped by Contura, not by the server or the statement: its session went. `why` says so in a sentence. */
  | { s: "stopped"; why: string; ms: number };

export interface ResultItem {
  id: number;
  sql: string;
  from: number;
  to: number;
  pinned: boolean;
  startedAt: number;
  /** Its place in the run, from 1; an Explain has none. */
  index?: number;
  /** Statements after this one that were left not run (a reconnect's re-run of one statement). */
  after?: Stmt[];
  state: RunState;
}

export interface RunnerState {
  items: ResultItem[];
  active: number;
  queue: Stmt[];
  confirm: { stmt: Stmt; verb: "UPDATE" | "DELETE"; table: string } | null;
  /** The whole run waits here until the Production dialog is answered. */
  ask: RunAsk | null;
  /** The confirm pass every statement of the queue runs with, once confirmed. */
  pass: PassId | null;
  nextId: number;
  /** Statements begun in the current run, so each knows its number. */
  ran: number;
  /** Statements left not run after the last queued one (a reconnect's re-run). */
  after: Stmt[];
}

export const EMPTY_RUNNER: RunnerState = { items: [], active: 0, queue: [], confirm: null, ask: null, pass: null, nextId: 1, ran: 0, after: [] };

export type RunnerAction =
  /** `continue` carries on the same run, keeping the results it already has. */
  | { type: "start"; stmts: Stmt[]; pass?: PassId | null; continue?: boolean; rerun?: Rerun }
  | { type: "ask"; ask: RunAsk }
  | { type: "askClosed" }
  /** The pass ran out before this statement ran: it is dropped and nothing more runs. */
  | { type: "passExpired"; id: number }
  /** Takes the first queued statement and marks it running. */
  | { type: "begin"; now: number }
  /** Explain: a Plan tab joins the results without asking and without touching the run queue. */
  | { type: "explain"; stmt: Stmt; now: number }
  | { type: "planned"; id: number; plan: Plan; ms: number }
  /** `sql`: the text that ran, when the caller learns it only with the answer (a Visual Query run). */
  | { type: "done"; id: number; outcome: ExecOutcome; ms: number; sql?: string }
  | { type: "failed"; id: number; error: unknown; ms?: number }
  /** A run whose session went while it was going (a Visual Query): a stop, not a failure. */
  | { type: "stopped"; id: number; why: string; ms: number }
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
    // Safety errors are said in Contura's words; a refusal is the server's, from its read-only session.
    if (error.kind === "readOnly" || error.kind === "needsConfirmation" || error.kind === "readOnlyRefused")
      return { s: "error", message: errorText(error), at: item.from, own: true, refused: error.kind === "readOnlyRefused" };
    if (error.kind === "connect" || (error.kind === "notFound" && error.message === "connection not open"))
      return { s: "error", message: errorText(error), at: item.from, own: true, lost: true };
    if (error.kind === "invalidInput" || error.kind === "notFound")
      return { s: "error", message: errorText(error), at: item.from, own: true };
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
    case "start": {
      if (action.rerun) {
        const { ran, after, drop } = action.rerun;
        const items = closeOpen(state.items.filter((i) => i.id !== drop));
        return {
          ...state,
          items,
          active: Math.max(0, items.length - 1),
          queue: action.stmts,
          confirm: null,
          ask: null,
          pass: action.pass ?? null,
          ran,
          after,
        };
      }
      return {
        ...state,
        items: closeOpen(action.continue ? state.items : state.items.filter((i) => i.pinned)),
        active: action.continue ? state.active : 0,
        queue: action.stmts,
        confirm: null,
        ask: null,
        pass: action.pass ?? null,
        ran: action.continue ? state.ran : 0,
        after: action.continue ? state.after : [],
      };
    }
    case "ask":
      return { ...state, ask: action.ask, queue: [], confirm: null };
    case "askClosed":
      return { ...state, ask: null };
    case "passExpired": {
      const items = state.items.filter((i) => i.id !== action.id);
      // The dropped statement runs again in the rest of the run, so it carries its not-run tail back.
      const after = state.items.find((i) => i.id === action.id)?.after ?? state.after;
      return { ...state, items, active: Math.max(0, items.length - 1), queue: [], pass: null, ran: Math.max(0, state.ran - 1), after };
    }
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
        index: state.ran + 1,
        state: { s: "running" },
      };
      // The last queued statement carries the ones left not run after it.
      const last = rest.length === 0 && state.after.length > 0;
      if (last) item.after = state.after;
      const items = [...closeOpen(state.items), item];
      return {
        ...state,
        items,
        active: items.length - 1,
        queue: rest,
        confirm: null,
        nextId: state.nextId + 1,
        ran: state.ran + 1,
        after: last ? [] : state.after,
      };
    }
    case "explain": {
      const item: ResultItem = {
        id: state.nextId,
        sql: action.stmt.text,
        from: action.stmt.from,
        to: action.stmt.to,
        pinned: false,
        startedAt: action.now,
        state: { s: "running" },
      };
      const items = [...closeOpen(state.items), item];
      return { ...state, items, active: items.length - 1, nextId: state.nextId + 1 };
    }
    case "planned":
      return update(state, action.id, (i) => ({ ...i, state: { s: "plan", plan: action.plan, ms: action.ms } }));
    case "done": {
      const { outcome, ms } = action;
      return update(state, action.id, (i) => ({
        ...i,
        ...(action.sql !== undefined && { sql: action.sql, to: i.from + action.sql.length }),
        state:
          outcome.t === "rows"
            ? { s: "rows", columns: outcome.columns, rows: outcome.rows, hasMore: outcome.hasMore, open: outcome.hasMore, ms }
            : { s: "affected", rows: outcome.rows, ms },
      }));
    }
    case "failed": {
      const next = update(state, action.id, (i) => {
        const st = errorState(action.error, i);
        if (st.s === "error") {
          st.index = i.index;
          st.notRun = i.index === undefined ? [] : [...state.queue, ...(i.after ?? [])];
          if (action.ms !== undefined) st.ms = action.ms;
        }
        return { ...i, state: st.s === "cancelled" ? { s: "cancelled", ms: action.ms ?? 0 } : st };
      });
      // Run all stops at the first failure.
      return { ...next, queue: [] };
    }
    case "stopped":
      return { ...update(state, action.id, (i) => ({ ...i, state: { s: "stopped", why: action.why, ms: action.ms } })), queue: [] };
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
      return { ...state, items: closeOpen(state.items), queue: [], confirm: null, ask: null, pass: null };
    case "closeItem": {
      const items = state.items.filter((i) => i.id !== action.id);
      return { ...state, items, active: Math.min(state.active, Math.max(0, items.length - 1)) };
    }
  }
}
