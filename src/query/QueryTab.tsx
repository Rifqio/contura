import { useToast } from "../components/Toast";
import type { ExportOrigin } from "../jobs/exportText";
import { type MutableRefObject, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  cancelQuery,
  classifySql,
  closeConnection,
  closeQueryResult,
  closeQuerySession,
  confirmRun,
  DIALECT_LABEL,
  errorText,
  executeSql,
  restoreScriptSqlMode,
  explainStatement,
  fetchMoreRows,
  isCommandError,
  listDatabases,
  openConnection,
  openQuerySession,
  opensInFlight,
  prepareRun,
  saveSavedQuery,
} from "../api/client";
import type {
  ConnectionConfig,
  ConnectionId,
  DialectKind,
  Group,
  ObjectPath,
  QuerySessionId,
  SavedQuery,
  StatementClass,
} from "../api/types";
import InlineAsk from "../assistant/InlineAsk";
import { type AskKit, type AskSetup, tablesIn } from "../assistant/context";
import Icon from "../components/Icon";
import SafetyTag from "../components/SafetyTag";
import { durationText } from "../format/units";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import ConfirmRun from "./ConfirmRun";
import ClosedConnection, { type OpenFailure } from "./ClosedConnection";
import EditorHeader from "./EditorHeader";
import { formatSql } from "./format";
import { writeWithoutWhere } from "./noWhere";
import type { ConnectionOpenStatus } from "../sidebar/OneTree";
import ResultsPanel from "./ResultsPanel";
import { EMPTY_RUNNER, type Rerun, runnerReducer } from "./runner";
import SaveQueryDialog from "./SaveQueryDialog";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "./SqlEditor";
import { type Stmt, splitStatements } from "./statements";
import { useCommandKeys } from "../commands/useCommandKeys";
import QueryDiagramPane from "../querydiagram/QueryDiagramPane";
import { type RecentStepInput, useRecordStep } from "../assistant/recentSteps";

/** A query tab as the app keeps it, and as its draft is saved. */
export type QueryTabDoc = {
  id: string;
  name: string;
  text: string;
  connectionId: ConnectionId | null;
  database: string | null;
  /** The Saved Query this tab edits, if any, and its text as last saved. */
  savedId: string | null;
  savedText: string | null;
};

interface Props {
  tab: QueryTabDoc;
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  onChange(tab: QueryTabDoc): void;
  onSaved(q: SavedQuery): void;
  historyOpen: boolean;
  onToggleHistory(): void;
  /** The assistant panel is showing, and the button that toggles it. */
  assistantOpen?: boolean;
  onToggleAssistant?(): void;
  editorRef: MutableRefObject<SqlEditorApi | null>;
  /** Filled with this tab's runner for a statement from outside the editor (Query History's Run); the Production and Read-only checks apply as for any run. */
  runRef?: MutableRefObject<((sql: string) => Promise<RunOutcome>) | null>;
  /** A statement finished, so Query History has a new entry. */
  onRan?(): void;
  /** The language service and the schemas it knows; without them the editor is plain. */
  lang?: { client: LangClient; schemas: SchemaCache };
  /** Reveals a Saved Query in the sidebar (the toast's Show). */
  onShowSaved?(id: string): void;
  /** Go to definition on a table: show it in the Database Tree. */
  onShowInTree?(target: { connectionId: ConnectionId; database: string; schema: string | null; name: string }): void;
  /** Inline Ask on a selection, with Ctrl+I, and on a failed query; absent, neither shows. */
  ask?: AskKit;
  /** The tab is on screen: its status then shows in the window status bar (`#app-status-slot`) when there is one. */
  visible?: boolean;
  /** A dropped Connection was opened again from the error screen. */
  onConnectionOpened?(id: ConnectionId): void;
  /** This tab's open is in flight, failed, or over (null), so the tree row can say so. */
  onOpenStatus?(id: ConnectionId, status: ConnectionOpenStatus | null): void;
  /** Edit Connection... from a failed open: the app shows the Connection's form. */
  onEditConnection?(id: ConnectionId): void;
  /** Export... on a result (and Ctrl+E in the results): the app opens the Export dialog on this tab's Connection. */
  onExport?(origin: ExportOrigin): void;
  /** The Groups, so the confirm dialog shows the Connection's Group square. */
  groups?: Group[];
  /** The server's row estimate of a table, when the tree has it: the no-WHERE warning says "about N rows". */
  rowEstimate?(connectionId: ConnectionId, path: ObjectPath): number | null;
}

/** The database a MySQL `USE name` statement moves the session to, else null. */
export function usedDatabase(sql: string): string | null {
  const m = /^\s*use\s+(?:`((?:[^`]|``)+)`|([\p{L}\p{N}_$]+))\s*;?\s*$/iu.exec(sql);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/``/g, "`") : m[2];
}

/**
 * The table a statement names (`orders`, `sales.orders`, `"Sales"."Orders"`) as a path in `database`:
 * on MySQL a qualifier is the database, elsewhere the schema (PostgreSQL's default is `public`).
 */
export function tablePath(name: string, dialect: DialectKind, database: string): ObjectPath | null {
  const parts = name.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^.]+/g)?.map((p) =>
    /^["`[]/.test(p) ? p.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`") : p,
  );
  if (!parts || parts.length === 0 || parts.length > 2) return null;
  const [qualifier, table] = parts.length === 2 ? parts : [null, parts[0]];
  if (dialect === "mysql") return { database: qualifier ?? database, schema: null, name: table };
  if (dialect === "postgres") return { database, schema: qualifier ?? "public", name: table };
  return { database: qualifier ?? database, schema: null, name: table };
}

/** Statements that change what the schema holds, after any leading comments. */
const DDL = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT)\b/i;

/** How a run asked for from outside the editor ended: `ran` is false when it was declined, blocked, failed or never started. */
export interface RunOutcome {
  ran: boolean;
  /** Rows returned, or rows changed, by the last statement. */
  rows?: number;
  /** Only the first page of rows loaded: there are more than `rows` (R26). */
  more?: boolean;
}

const RESTARTED_MS = 5000;

/** Edits settle this long before a Read-only or Production Connection's statements are classified. */
const CLASSIFY_DELAY_MS = 200;
const CLASS_CACHE_MAX = 500;
const WRITES_NOTE = "Read-only Connection: this statement writes";
/** What an open that failed says: a sentence, and the server's own words. */
function openFailure(e: unknown, dialect: DialectKind): OpenFailure {
  if (!isCommandError(e)) return { reason: "The Connection did not open.", server: e instanceof Error ? e.message : String(e) };
  const reason =
    e.kind === "auth"
      ? "The server refused the sign-in."
      : e.kind === "connect"
        ? dialect === "sqlite"
          ? "Contura could not open the database file."
          : "Contura could not reach the server."
        : "The Connection did not open.";
  return { reason, server: typeof e.message === "string" ? e.message : null };
}

const READ_ONLY_TIP = "This Connection is Read-only";

/** On a Read-only or Production Connection: the current statement when it writes, and whether any statement does. */
type Safety = { current: Stmt | null; anyWrite: boolean };
const NO_WRITES: Safety = { current: null, anyWrite: false };

const noSubscribe = () => () => {};

const SPLIT_KEY = "dbview.queryEditorShare";
const DEFAULT_SHARE = 0.46;

function loadShare(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 0.2 && v <= 0.8 ? v : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

function saveShare(v: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(v));
  } catch {
    // Remembering the split is a convenience only.
  }
}

/** The offset of a 1-based line and column in `text`, clamped to the text. */
function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return Math.min(text.length, at + column - 1);
}

/** The word an error points at, so the underline covers it. */
function wordAt(text: string, at: number): { from: number; to: number } {
  const m = /^[\w$"`.]+/.exec(text.slice(at));
  return { from: at, to: at + (m ? m[0].length : 1) };
}

export default function QueryTab({
  tab,
  connections,
  openIds,
  onChange,
  onSaved,
  historyOpen,
  onToggleHistory,
  assistantOpen = false,
  onToggleAssistant,
  editorRef,
  runRef,
  onRan,
  lang,
  onShowInTree,
  onShowSaved,
  ask,
  visible = false,
  groups = [],
  onConnectionOpened,
  onOpenStatus,
  onEditConnection,
  rowEstimate,
  onExport,
}: Props) {
  const connection = connections.find((c) => c.id === tab.connectionId) ?? null;
  const isOpen = !!connection && openIds.has(connection.id);
  const dialect = connection?.dialect ?? "postgres";
  const [session, setSession] = useState<QuerySessionId | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(runnerReducer, EMPTY_RUNNER);
  const recordStep = useRecordStep();
  /** A run that ended, as a Recent step: the tab's title and place and the row count, never the SQL. */
  const ranStep = (count: number | null, extra: Partial<RecentStepInput> = {}) =>
    recordStep({
      verb: "runQuery",
      tab: "query",
      title: latest.current.name,
      connectionId: latest.current.connectionId,
      database: latest.current.database,
      schema: null,
      count,
      ...extra,
    });
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const { show } = useToast();
  const savedToast = (q: SavedQuery) =>
    show({
      kind: "success",
      text: (
        <>
          Saved <b>{q.name}</b>.
        </>
      ),
      action: onShowSaved ? { label: "Show", run: () => onShowSaved(q.id) } : undefined,
    });
  const [notice, setNotice] = useState<string | null>(null);
  // Opening the Connection from the result area, while it is closed (frame 10).
  const [opening, setOpening] = useState<{ s: "idle" } | { s: "connecting"; startedAt: number } | { s: "failed"; error: OpenFailure }>({ s: "idle" });
  const [openNow, setOpenNow] = useState(() => Date.now());
  const openToken = useRef(0);
  const inFlight = useRef<{ cancelled: boolean } | null>(null);
  /** A cancelled open has not settled yet: Open waits for it. */
  const [stopping, setStopping] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  // The query diagram beside the editor (B1), and its "3 tables, 2 Joins" for the status line.
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [diagramCount, setDiagramCount] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const toggleDiagram = () => setDiagramOpen((o) => !o);
  // Explain has no default key; the Command Palette runs it on the query tab on screen.
  useCommandKeys({ ...(lang ? { "diagram.toggle": toggleDiagram } : {}), "query.explain": () => explain() }, { region: root });
  const [share, setShare] = useState(loadShare);
  const [askSel, setAskSel] = useState<AskSelection | null>(null);
  // Bumped to open the tab's session again after a dropped Connection was reopened.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  /**
   * "Reconnect and run statement N", armed for the session open that the reconnect starts (`run`
   * counts the session effect's runs) on this Connection and database. Any other open drops it.
   */
  const rerun = useRef<{ run: number; connectionId: ConnectionId; database: string | null; stmt: Stmt; rerun: Rerun } | null>(null);
  const sessionRun = useRef(0);
  // Counts opened sessions: a reopened one can carry the same id as the one it replaces.
  const [sessionOpened, setSessionOpened] = useState(0);
  const confirmed = useRef<Stmt | null>(null);
  // Bumped by every new run and session, so a late answer from the Core is dropped.
  const prepared = useRef(0);
  const sessionNow = useRef<QuerySessionId | null>(null);
  sessionNow.current = session;
  // The run asked for from outside the editor that has not ended yet, its statements, and how far it got.
  const external = useRef<{
    stmts: Stmt[];
    resolve(o: RunOutcome): void;
    phase: "preparing" | "asking" | "confirming" | "running";
  } | null>(null);
  const settleExternal = (o: RunOutcome) => {
    const w = external.current;
    external.current = null;
    w?.resolve(o);
  };
  /** The outside run, when `list` holds its statements. */
  const externalIn = (list: Stmt[]) => {
    const w = external.current;
    return w && list.some((x) => w.stmts.includes(x)) ? w : null;
  };
  const openIdsNow = useRef(openIds);
  openIdsNow.current = openIds;
  const fetching = useRef(false);
  const latest = useRef(tab);
  latest.current = tab;
  const editorText = () => editorRef.current?.text() ?? latest.current.text;
  const work = useRef<HTMLDivElement>(null);

  // The schema index for this tab's Connection and database: SQLite has one database, `main`.
  const schemaDb = connection ? (connection.dialect === "sqlite" ? "main" : tab.database) : null;
  const schemaLoad = useSyncExternalStore(
    lang ? (l) => lang.schemas.subscribe(l) : noSubscribe,
    () => (lang && connection && schemaDb ? lang.schemas.state(connection.id, schemaDb) : null),
  );
  useEffect(() => {
    if (lang && connection && isOpen && schemaDb) void lang.schemas.ensure(connection.id, schemaDb);
  }, [lang, connection?.id, isOpen, schemaDb]);
  // A crashed language worker restarts at once; say so for a moment.
  const [restarted, setRestarted] = useState(false);
  useEffect(() => {
    if (!lang) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = lang.client.onRestart(() => {
      setRestarted(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRestarted(false), RESTARTED_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [lang?.client]);
  const live = !!connection && isOpen && !!schemaDb;
  const editorLang = lang && {
    client: lang.client,
    docId: tab.id,
    schemaKey: live ? schemaKey(connection.id, schemaDb) : null,
    schemaState: !live ? ("none" as const) : schemaLoad === "loaded" ? ("loaded" as const) : schemaLoad === "loading" ? ("loading" as const) : ("none" as const),
  };

  /** The database a MySQL `USE` moved this session to; null while it is still the tab's (Q43). */
  const [sessionDb, setSessionDb] = useState<string | null>(null);

  // One session per tab, opened on the tab's Connection and database.
  useEffect(() => {
    setSessionDb(null);
    if (!connection || !isOpen) {
      // No open follows from here, so a later open must not run the reconnect's statement.
      rerun.current = null;
      setSession(null);
      return;
    }
    let live = true;
    let opened: QuerySessionId | null = null;
    const runNo = ++sessionRun.current;
    // A re-run is only for the open its reconnect started.
    if (rerun.current && rerun.current.run !== runNo) rerun.current = null;
    setSessionError(null);
    openQuerySession(connection.id, connection.dialect === "sqlite" ? null : tab.database)
      .then((s) => {
        opened = s;
        if (live) {
          setSession(s);
          setSessionOpened((n) => n + 1);
        }
        else void closeQuerySession(s).catch(() => {});
      })
      .catch((e) => {
        // The open the re-run waited for failed: nothing runs later without Run being pressed.
        if (rerun.current?.run === runNo) rerun.current = null;
        if (live) setSessionError(errorText(e, connection.dialect));
      });
    return () => {
      live = false;
      setSession(null);
      // A run never carries on in another session, database or Connection.
      prepared.current += 1;
      settleExternal({ ran: false });
      dispatch({ type: "sessionChanged" });
      if (opened) void closeQuerySession(opened).catch(() => {});
    };
  }, [connection?.id, isOpen, tab.database, sessionEpoch]);

  useEffect(() => {
    if (!connection || !isOpen || connection.dialect === "sqlite") {
      setDatabases(null);
      return;
    }
    let live = true;
    listDatabases(connection.id)
      .then((d) => live && setDatabases(d))
      .catch(() => live && setDatabases(null));
    return () => {
      live = false;
    };
  }, [connection?.id, isOpen]);

  // Runs the queue one statement at a time; a missing WHERE asks first, unless the
  // Production dialog already showed the warning.
  useEffect(() => {
    if (!session) return;
    const running = state.items.some((i) => i.state.s === "running");
    if (running || state.confirm || state.ask || state.queue.length === 0) return;
    const stmt = state.queue[0];
    const missing = writeWithoutWhere(stmt.text);
    if (missing && state.pass === null && confirmed.current !== stmt) {
      dispatch({ type: "confirmNeeded", verb: missing.verb, table: missing.table });
      return;
    }
    confirmed.current = null;
    const id = state.nextId;
    const left = state.queue;
    const started = performance.now();
    dispatch({ type: "begin", now: started });
    executeSql(session, stmt.text, state.pass).then(
      (ex) => {
        const w = externalIn([stmt]);
        // An outside run has run when its last statement has; the count is that statement's.
        if (w && w.stmts[w.stmts.length - 1] === stmt) {
          const o = ex.outcome;
          settleExternal(o.t === "rows" ? { ran: true, rows: o.rows.length, ...(o.hasMore ? { more: true } : {}) } : { ran: true, rows: o.rows });
        }
        dispatch({ type: "done", id, outcome: ex.outcome, ms: ex.elapsedMs });
        const o = ex.outcome;
        ranStep(o.t === "rows" ? o.rows.length : o.rows, o.t === "rows" && o.hasMore ? { hasMore: true } : {});
        const used = connection?.dialect === "mysql" ? usedDatabase(stmt.text) : null;
        if (used) setSessionDb(used);
        if (DDL.test(stmt.text) && connection) lang?.schemas.invalidate(connection.id);
        onRan?.();
      },
      (error) => {
        if (isCommandError(error) && error.kind === "needsConfirmation") {
          // The pass ran out: nothing of this statement ran, so ask again for the rest.
          const w = externalIn([stmt]);
          if (w) w.phase = "preparing";
          dispatch({ type: "passExpired", id });
          void prepare(session, left, true);
          return;
        }
        if (externalIn([stmt])) settleExternal({ ran: false });
        // N3: a framed MySQL script (Compare or Transfer, Open in editor) stopped before the footer that puts the
        // tab's sql_mode back: the Core puts it back when the header changed it.
        if (connection?.dialect === "mysql" && left.slice(1).some((s) => /@OLD_SQL_MODE/i.test(s.text))) {
          void restoreScriptSqlMode(session).then(
            (put) => put && setNotice("The script stopped before its end; sql_mode was put back."),
            () => {},
          );
        }
        dispatch({ type: "failed", id, error, ms: performance.now() - started });
        ranStep(null, { failed: true });
        onRan?.();
      },
    );
  }, [state, session]);

  // A run from outside that waited for a dialog and was declined ends without having run.
  useEffect(() => {
    const w = external.current;
    if (!w) return;
    const idle = !state.confirm && state.queue.length === 0 && !state.items.some((i) => i.state.s === "running");
    if ((w.phase === "asking" && !state.ask) || (w.phase === "running" && !state.ask && idle)) settleExternal({ ran: false });
  }, [state]);

  // On a Read-only or Production Connection, once edits settle, ask the Core which statements write.
  const [safety, setSafety] = useState<Safety>(NO_WRITES);
  const classes = useRef(new Map<string, StatementClass>());
  const readOnly = !!connection?.readOnly;
  const production = !!connection?.production;
  useEffect(() => {
    if (!readOnly && !production) {
      setSafety(NO_WRITES);
      return;
    }
    let live = true;
    const d = dialect;
    const timer = setTimeout(() => {
      const cache = classes.current;
      const classOf = (sql: string): Promise<StatementClass> => {
        const key = `${d}\n${sql}`;
        const known = cache.get(key);
        if (known) return Promise.resolve(known);
        return classifySql(d, sql).then((c) => {
          if (cache.size > CLASS_CACHE_MAX) cache.clear();
          cache.set(key, c);
          return c;
        });
      };
      const target = editorRef.current?.runTarget() ?? null;
      const all = splitStatements(editorText(), d);
      Promise.all([target ? classOf(target.text) : Promise.resolve<StatementClass>("read"), ...all.map((s) => classOf(s.text))])
        .then(([cur, ...rest]) => {
          if (live) setSafety({ current: cur === "write" ? target : null, anyWrite: rest.includes("write") });
        })
        .catch(() => {
          // The Core still blocks any write when the run is asked for.
          if (live) setSafety(NO_WRITES);
        });
    }, CLASSIFY_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [readOnly, production, dialect, tab.text, position.line, position.column]);
  const blocked = readOnly && safety.current
    ? { from: safety.current.from, to: safety.current.to, message: WRITES_NOTE }
    : null;
  const runAllBlocked = readOnly && safety.anyWrite;
  // Read-only blocks the write outright, so the Production hazard only shows where the write can run.
  const writeHazard = production && !readOnly && safety.current
    ? { from: safety.current.from, to: safety.current.to, note: `Writes on ${connection!.name} (Production)` }
    : null;
  const group = connection?.groupId ? groups.find((g) => g.id === connection.groupId) ?? null : null;

  // Run stays in sight while the Connection is closed, and says why it waits.
  const closedTip = connection && !isOpen ? `Open ${connection.name} to run this query.` : null;
  const running = state.items.find((i) => i.state.s === "running");
  const canRun = !!session && !running;

  function run(stmts: (Stmt | null)[]): boolean {
    const list = stmts.filter((s): s is Stmt => !!s && s.text.trim() !== "");
    if (!canRun || !session || list.length === 0) return false;
    setNotice(null);
    void prepare(session, list);
    return true;
  }

  /**
   * Asks the Core whether the run may go ahead, needs the Production dialog, or is blocked.
   * `cont` carries on a run whose pass ran out, keeping the results it already has.
   */
  async function prepare(s: QuerySessionId, list: Stmt[], cont = false, rerunOf?: Rerun) {
    const token = ++prepared.current;
    const current = () => token === prepared.current && sessionNow.current === s;
    try {
      const verdict = await prepareRun(
        s,
        list.map((x) => x.text),
      );
      const w = externalIn(list);
      if (!current()) {
        if (w) settleExternal({ ran: false });
        return;
      }
      if (verdict.kind === "ok") {
        if (w) w.phase = "running";
        dispatch({ type: "start", stmts: list, continue: cont, rerun: rerunOf });
      } else if (verdict.kind === "readOnly") {
        if (w) settleExternal({ ran: false });
        setNotice(errorText({ kind: "readOnly", message: verdict.statement }));
      } else {
        if (w) w.phase = "asking";
        dispatch({ type: "ask", ask: { verdict, stmts: list, continue: cont, rerun: rerunOf } });
      }
    } catch (e) {
      if (externalIn(list)) settleExternal({ ran: false });
      if (current()) setNotice(errorText(e, dialect));
    }
  }

  /** Run on the Production dialog: get a pass for exactly these texts, then run them all with it. */
  async function confirmAsk() {
    const ask = state.ask;
    if (!ask || !session) return;
    const w = externalIn(ask.stmts);
    if (w) w.phase = "confirming";
    dispatch({ type: "askClosed" });
    const token = ++prepared.current;
    try {
      const pass = await confirmRun(
        session,
        ask.stmts.map((x) => x.text),
      );
      if (token !== prepared.current || sessionNow.current !== session) {
        if (externalIn(ask.stmts)) settleExternal({ ran: false });
        return;
      }
      const running = externalIn(ask.stmts);
      if (running) running.phase = "running";
      dispatch({ type: "start", stmts: ask.stmts, pass, continue: ask.continue, rerun: ask.rerun });
    } catch (e) {
      if (externalIn(ask.stmts)) settleExternal({ ran: false });
      if (token === prepared.current) setNotice(errorText(e, dialect));
    }
  }

  // The first UPDATE or DELETE without WHERE in the run waiting for the Production dialog.
  const askNoWhere = (() => {
    if (!state.ask) return null;
    for (let i = 0; i < state.ask.stmts.length; i++) {
      const missing = writeWithoutWhere(state.ask.stmts[i].text);
      if (missing) return { index: i, ...missing };
    }
    return null;
  })();

  /** Explain: the server's plan for the current statement. It is never run, so nothing asks or confirms. */
  function explain() {
    const target = editorRef.current?.runTarget() ?? null;
    if (!canRun || !session || !target || target.text.trim() === "") return;
    setNotice(null);
    const id = state.nextId;
    const started = performance.now();
    dispatch({ type: "explain", stmt: target, now: started });
    // An open result keeps rows, and on SQLite a read lock, on the server: let go of it first.
    const open = state.items.some((i) => i.state.s === "rows" && i.state.open);
    const ready = open ? closeQueryResult(session).catch(() => {}) : Promise.resolve();
    ready.then(() => explainStatement(session, target.text)).then(
      (plan) => dispatch({ type: "planned", id, plan, ms: performance.now() - started }),
      (error) => dispatch({ type: "failed", id, error, ms: performance.now() - started }),
    );
  }

  /**
   * The Connection dropped: open it again, then run exactly the failed statement N (R43). It keeps
   * its number, and the statements after it stay not run, with theirs.
   */
  async function reconnect() {
    const item = state.items[state.active];
    if (!connection || !item || item.state.s !== "error") return;
    const id = connection.id;
    const database = latest.current.database;
    const stmt = { from: item.from, to: item.to, text: item.sql };
    const plan: Rerun = { ran: (item.state.index ?? 1) - 1, after: item.state.notRun ?? [], drop: item.id };
    try {
      await openConnection(id);
      onConnectionOpened?.(id);
    } catch (e) {
      setNotice(errorText(e, dialect));
      return;
    }
    // Moved to another Connection or database meanwhile: the statement was for the old one.
    if (latest.current.connectionId !== id || latest.current.database !== database) return;
    rerun.current = { run: sessionRun.current + 1, connectionId: id, database, stmt, rerun: plan };
    setSessionEpoch((n) => n + 1);
  }
  useEffect(() => {
    const r = rerun.current;
    if (!session || !r) return;
    rerun.current = null;
    if (r.run !== sessionRun.current || r.connectionId !== latest.current.connectionId || r.database !== latest.current.database) return;
    if (!canRun) return;
    setNotice(null);
    void prepare(session, [r.stmt], false, r.rerun);
  }, [sessionOpened]);

  useEffect(() => {
    if (opening.s !== "connecting") return;
    const timer = window.setInterval(() => setOpenNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [opening.s]);
  // Another Connection, or this one open, ends whatever the result area said about opening.
  useEffect(() => {
    openToken.current += 1;
    setOpening({ s: "idle" });
  }, [connection?.id, isOpen]);

  async function beginOpen() {
    if (!connection || inFlight.current) return;
    const id = connection.id;
    const dialect = connection.dialect;
    const attempt = { cancelled: false };
    inFlight.current = attempt;
    const token = ++openToken.current;
    setOpenNow(Date.now());
    setOpening({ s: "connecting", startedAt: Date.now() });
    onOpenStatus?.(id, { s: "connecting" });
    try {
      await openConnection(id);
      if (attempt.cancelled) {
        // The person chose to stop: do not leave the Connection open behind their back. But when
        // another tab or the tree opened it meanwhile, or is opening it now, it is theirs: leave it.
        if (!openIdsNow.current.has(id) && opensInFlight(id) === 0) {
          await closeConnection(id).catch(() => {});
          onOpenStatus?.(id, null);
        }
        return;
      }
      onConnectionOpened?.(id);
      onOpenStatus?.(id, null);
      if (token === openToken.current) setOpening({ s: "idle" });
    } catch (e) {
      onOpenStatus?.(id, attempt.cancelled ? null : { s: "failed", error: errorText(e, dialect) });
      if (!attempt.cancelled && token === openToken.current) setOpening({ s: "failed", error: openFailure(e, dialect) });
    } finally {
      inFlight.current = null;
      setStopping(false);
    }
  }
  function cancelOpen() {
    openToken.current += 1;
    if (inFlight.current) {
      inFlight.current.cancelled = true;
      setStopping(true);
    }
    setOpening({ s: "idle" });
  }

  /** Q8: Run pressed during a run says so instead of doing nothing. */
  const alreadyAt = useRef(-Infinity);
  function runAgain(): boolean {
    if (!running) return false;
    // A held key repeats a few ms apart: the toast is said once, so it leaves after its own 4 s. A separate press
    // (more than 150 ms after the last) says it again, even if the toast was closed or replaced meanwhile.
    const now = Date.now();
    const repeat = now - alreadyAt.current < 150;
    alreadyAt.current = now;
    if (!repeat) show({ kind: "info", text: "Already running. Esc cancels it." });
    return true;
  }
  const runCurrent = () => runAgain() || run([editorRef.current?.runTarget() ?? null]);
  // Not in the editor, so it has no place in the text: Add WHERE and Go to find nothing to act on.
  // Split as Run all splits, so each statement gets its own no-WHERE check and result (an AI answer can hold several).
  if (runRef)
    runRef.current = (sql) =>
      new Promise<RunOutcome>((resolve) => {
        settleExternal({ ran: false });
        const stmts = splitStatements(sql, dialect).map((x) => ({ from: 0, to: 0, text: x.text }));
        external.current = { stmts, resolve, phase: "preparing" };
        if (!run(stmts)) settleExternal({ ran: false });
      });
  const runAll = () => runAgain() || run(splitStatements(editorText(), dialect));

  /** Adds WHERE after the statement, only if the editor still holds it where it was when the run was asked for. */
  function addWhere(stmt: Stmt) {
    if (editorText().slice(stmt.from, stmt.to) !== stmt.text) return;
    editorRef.current?.select(stmt.to, stmt.to);
    editorRef.current?.insert("\nWHERE ");
  }

  function cancel() {
    if (session && running) void cancelQuery(session).catch((e) => setNotice(errorText(e)));
  }

  function escape(): boolean {
    if (state.confirm) {
      dispatch({ type: "declined" });
      return true;
    }
    if (opening.s === "connecting") {
      cancelOpen();
      return true;
    }
    if (running) {
      cancel();
      return true;
    }
    return false;
  }

  async function fetchMore(id: number) {
    if (!session || fetching.current) return;
    fetching.current = true;
    try {
      const more = await fetchMoreRows(session);
      dispatch({ type: "more", id, rows: more.rows, hasMore: more.hasMore });
    } catch (e) {
      setNotice(errorText(e, dialect));
    } finally {
      fetching.current = false;
    }
  }

  async function save() {
    const t = latest.current;
    if (!t.savedId) {
      setSaving(true);
      return;
    }
    try {
      const q = await saveSavedQuery({ id: t.savedId, name: t.name, sql: t.text });
      onChange({ ...latest.current, savedText: q.sql });
      onSaved(q);
      savedToast(q);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  function startDrag(e: React.PointerEvent) {
    const box = work.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    const height = box.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => setShare(Math.max(0.2, Math.min(0.8, (ev.clientY - top) / height)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setShare((s) => {
        saveShare(s);
        return s;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }

  const askSchema = lang && connection && schemaDb ? lang.client.sqlSchemaFor(schemaKey(connection.id, schemaDb)) : null;
  const askConnection = connection
    ? { id: connection.id, name: connection.name, dialect: connection.dialect, database: schemaDb, access: connection.aiAccess }
    : null;
  const askSetup: AskSetup | undefined = ask && {
    ...ask,
    connection: askConnection,
    schema: askSchema,
    insertTarget: { editor: () => editorRef.current, name: tab.name },
  };

  const active = state.items[state.active];
  const errorMark = active?.state.s === "error" ? wordAt(tab.text, active.state.at) : null;
  const lineAt = (offset: number) => tab.text.slice(0, offset).split("\n").length;
  const columnAt = (offset: number) => offset - tab.text.lastIndexOf("\n", offset - 1);
  // Table and column names in the loaded tree, for the error's "Did you mean".
  const tableNames = askSchema
    ? [...new Set(askSchema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]))]
    : [];

  // R2: on screen, the status goes to the window status bar, which already names the Connection.
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setStatusSlot(visible ? document.getElementById("app-status-slot") : null);
  }, [visible]);
  const shown = active?.state;
  const ranText =
    shown && (shown.s === "rows" || shown.s === "affected")
      ? {
          rows:
            shown.s === "rows"
              ? `${shown.rows.length.toLocaleString("en-US")}${shown.hasMore ? "+" : ""} ${shown.rows.length === 1 && !shown.hasMore ? "row" : "rows"}`
              : `${shown.rows.toLocaleString("en-US")} ${shown.rows === 1 ? "row" : "rows"} affected`,
          time: durationText(shown.ms),
        }
      : null;
  const status = (
    <div className="query-status">
      {connection ? (
        <>
          {!statusSlot && (
            <>
              <span>{connection.name}</span>
              <SafetyTag connection={connection} small />
            </>
          )}
          {tab.database && connection.dialect !== "sqlite" && <span>{tab.database}</span>}
          {!statusSlot && <span>{DIALECT_LABEL[connection.dialect]}</span>}
          {connection.queryTimeoutSecs && <span>Timeout {connection.queryTimeoutSecs}s</span>}
          {/* On screen the window status bar already says Closed. */}
          {!isOpen && !statusSlot && <span>Closed</span>}
          {isOpen && schemaLoad === "loading" && <span>Loading schema</span>}
          {isOpen && schemaLoad === "failed" && <span>Schema not loaded</span>}
        </>
      ) : (
        <span>Not connected</span>
      )}
      {restarted && <span role="status">Language engine restarted. Typing works as plain text.</span>}
      {notice && (
        <span className="error-text" role="alert">
          {notice}
        </span>
      )}
      {statusSlot && ranText && <span>{ranText.rows}</span>}
      {statusSlot && ranText && <span>{ranText.time}</span>}
      <span className="query-position">
        Ln {position.line}, Col {position.column}
      </span>
      {diagramOpen && diagramCount && <span>{diagramCount}</span>}
    </div>
  );

  return (
    <section className={diagramOpen && lang ? "query-tab query-tab-with-diagram" : "query-tab"} aria-label={tab.name} ref={root}>
      <EditorHeader
        connection={connection}
        connections={connections}
        openIds={openIds}
        databases={databases}
        database={tab.database}
        production={production}
        running={!!running}
        writeHazard={!!writeHazard}
        canRun={canRun}
        blockedTip={blocked ? READ_ONLY_TIP : closedTip}
        runAllBlockedTip={runAllBlocked ? READ_ONLY_TIP : closedTip}
        stateWord={!connection || isOpen ? null : opening.s === "connecting" ? "connecting..." : opening.s === "failed" ? "failed" : "closed"}
        compact={assistantOpen}
        aiAccess={connection?.aiAccess ?? null}
        historyOpen={historyOpen}
        assistantOpen={assistantOpen}
        onPickConnection={(id) => {
          const c = connections.find((x) => x.id === id);
          onChange({ ...latest.current, connectionId: c?.id ?? null, database: c?.database ?? null });
        }}
        onPickDatabase={(d) => onChange({ ...latest.current, database: d || null })}
        onRun={runCurrent}
        onRunAll={runAll}
        onExplain={explain}
        onFormat={() => editorRef.current?.replaceAll(formatSql(editorText(), dialect))}
        onSave={() => void save()}
        onToggleHistory={onToggleHistory}
        onToggleAssistant={onToggleAssistant}
        onCancel={cancel}
        diagramOpen={diagramOpen}
        onToggleDiagram={lang ? toggleDiagram : undefined}
      />

      <div className="query-work" ref={work} style={{ gridTemplateRows: `${share}fr 6px ${1 - share}fr` }}>
        <div className={production ? "query-editor prod-wash" : "query-editor"} data-pane>
          <SqlEditor
            paletteCommands
            value={tab.text}
            dialect={dialect}
            editorRef={editorRef}
            onChange={(text) => onChange({ ...latest.current, text })}
            onRun={(kind) => (kind === "all" ? runAll() : runCurrent())}
            onFormat={() => editorRef.current?.replaceAll(formatSql(editorText(), dialect))}
            onSave={() => void save()}
            onEscape={escape}
            onPosition={(line, column) => setPosition({ line, column })}
            markRunning={running ? { from: running.from, to: running.to } : null}
            markError={errorMark}
            blocked={blocked}
            writeHazard={writeHazard}
            lang={editorLang || undefined}
            onAsk={ask ? setAskSel : undefined}
            askButton={ask?.inlineAsk}
            onShowInTree={(t) => {
              if (connection && schemaDb)
                onShowInTree?.({
                  connectionId: connection.id,
                  database: schemaDb,
                  // MySQL and SQLite report the database as the schema; their tree has no schema level.
                  schema: connection.dialect === "postgres" ? t.schema : null,
                  name: t.name,
                });
            }}
          />
          {ask && askSel && (
            <InlineAsk
              context={{
                kind: "sql",
                connection: askConnection,
                sql: askSel.sql,
                lines: askSel.lines,
                tables: tablesIn(askSel.sql, askSchema),
                label: tab.name,
              }}
              schema={askSchema}
              groupId={ask.groupId}
              onOpenInChat={ask.onOpenInChat}
              onOpenSettings={ask.onOpenSettings}
              insertTarget={{ editor: () => editorRef.current, name: tab.name }}
              onOpenInNewTab={ask.onOpenInNewTab}
              onClose={() => {
                setAskSel(null);
                editorRef.current?.focus();
              }}
            />
          )}
          {state.confirm && (
            <div className="query-confirm" role="alertdialog" aria-label={`Confirm ${state.confirm.verb} without WHERE`}>
              <Icon name="warning" />
              <p>
                <strong>
                  {state.confirm.verb} without WHERE changes every row in <code>{state.confirm.table}</code>.
                </strong>{" "}
                Run it anyway?
              </p>
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  const c = state.confirm!;
                  dispatch({ type: "declined" });
                  addWhere(c.stmt);
                }}
              >
                Add WHERE
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => dispatch({ type: "declined" })}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-small button-danger-fill"
                onClick={() => {
                  confirmed.current = state.confirm!.stmt;
                  dispatch({ type: "confirmed" });
                }}
              >
                Run {state.confirm.verb}
              </button>
            </div>
          )}
        </div>
        <div
          className="query-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor and results"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          onPointerDown={startDrag}
          onDoubleClick={() => {
            // Q7: as in the Visual Query panel, a double-click puts the split back.
            setShare(DEFAULT_SHARE);
            saveShare(DEFAULT_SHARE);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const next = Math.max(0.2, Math.min(0.8, share + (e.key === "ArrowUp" ? -0.05 : 0.05)));
            setShare(next);
            saveShare(next);
          }}
        />
        {!connection ? (
          <div className="result-state">
            <h3>Choose a Connection to run this query</h3>
            <p className="muted">
              You can type without one. Running needs a Connection; pick one in the toolbar.
            </p>
          </div>
        ) : !isOpen ? (
          <ClosedConnection
            state={opening.s === "idle" ? "closed" : opening.s}
            connection={connection}
            elapsedMs={opening.s === "connecting" ? Math.max(0, openNow - opening.startedAt) : 0}
            error={opening.s === "failed" ? opening.error : null}
            production={production}
            stopping={stopping}
            onOpen={() => void beginOpen()}
            onCancel={cancelOpen}
            onEdit={() => onEditConnection?.(connection.id)}
          />
        ) : sessionError ? (
          <div className={production ? "result-state result-state-error prod-wash" : "result-state result-state-error"} role="alert">
            <h3>
              <Icon name="error" />
              {sessionError}
            </h3>
          </div>
        ) : (
          <ResultsPanel
            state={state}
            production={production}
            timeoutSecs={connection.queryTimeoutSecs}
            lineAt={lineAt}
            columnAt={columnAt}
            dialect={dialect}
            connectionName={connection.name}
            names={tableNames}
            tableNames={askSchema ? [...new Set(askSchema.tables.map((t) => t.name))] : undefined}
            scope={
              dialect === "postgres" && tab.database && askSchema?.searchPath[0]
                ? `${tab.database}.${askSchema.searchPath[0]}`
                : dialect === "mysql"
                  ? tab.database
                  : null
            }
            onReconnect={() => void reconnect()}
            onSelect={(index) => dispatch({ type: "select", index })}
            onPin={(id) => dispatch({ type: "pin", id })}
            onClose={(id) => {
              const it = state.items.find((i) => i.id === id);
              if (it?.state.s === "rows" && it.state.open && session) void closeQueryResult(session).catch(() => {});
              dispatch({ type: "closeItem", id });
            }}
            onCloseUnpinned={() => {
              // An open result keeps rows, and on SQLite a read lock, on the server.
              const open = state.items.some((i) => !i.pinned && i.state.s === "rows" && i.state.open);
              if (open && session) void closeQueryResult(session).catch(() => {});
              dispatch({ type: "closeUnpinned" });
            }}
            onFetchMore={(id) => void fetchMore(id)}
            onCancel={cancel}
            onRunAgain={(id) => {
              const item = state.items.find((i) => i.id === id);
              if (item) run([{ from: item.from, to: item.to, text: item.sql }]);
            }}
            onGoTo={(from, to) => editorRef.current?.select(from, to)}
            ask={askSetup}
            database={dialect === "sqlite" ? null : (sessionDb ?? tab.database)}
            onExport={onExport}
          />
        )}
      </div>

      {statusSlot ? createPortal(status, statusSlot) : status}

      {diagramOpen && lang && (
        <QueryDiagramPane
          source={{ kind: "editor", docId: tab.id, text: tab.text, pos: offsetOf(tab.text, position.line, position.column) }}
          dialect={dialect}
          schemaKey={editorLang ? editorLang.schemaKey : null}
          schemaState={editorLang ? editorLang.schemaState : "none"}
          schemas={live && connection ? { cache: lang.schemas, connectionId: connection.id, database: schemaDb } : null}
          lang={lang}
          visible={visible}
          onBand={(ranges) => editorRef.current?.band(ranges)}
          onStatus={setDiagramCount}
          onClose={() => {
            setDiagramOpen(false);
            editorRef.current?.focus();
          }}
        />
      )}

      {state.ask && (
        <ConfirmRun
          verdict={state.ask.verdict}
          dialect={dialect}
          group={group}
          noWhere={askNoWhere}
          rowEstimate={(() => {
            if (!askNoWhere || !connection || !rowEstimate) return null;
            const db = state.ask.verdict.database ?? tab.database ?? connection.database;
            const path = db ? tablePath(askNoWhere.table, dialect, db) : null;
            return path ? rowEstimate(connection.id, path) : null;
          })()}
          onRun={() => void confirmAsk()}
          onCancel={() => dispatch({ type: "askClosed" })}
          onAddWhere={() => {
            const stmt = state.ask!.stmts[askNoWhere!.index];
            dispatch({ type: "askClosed" });
            addWhere(stmt);
          }}
        />
      )}
      {saving && (
        <SaveQueryDialog
          sql={tab.text}
          connections={connections}
          connectionId={tab.connectionId}
          onCancel={() => setSaving(false)}
          onSaved={(q) => {
            setSaving(false);
            onChange({ ...latest.current, name: q.name, savedId: q.id, savedText: q.sql });
            onSaved(q);
            savedToast(q);
          }}
        />
      )}
    </section>
  );
}
