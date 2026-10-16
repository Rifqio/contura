import { type MutableRefObject, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import {
  cancelQuery,
  closeQueryResult,
  closeQuerySession,
  DIALECT_LABEL,
  errorText,
  executeSql,
  fetchMoreRows,
  listDatabases,
  openQuerySession,
  saveSavedQuery,
} from "../api/client";
import type { ConnectionConfig, ConnectionId, QuerySessionId, SavedQuery } from "../api/types";
import InlineAsk from "../assistant/InlineAsk";
import { type AskKit, type AskSetup, tablesIn } from "../assistant/context";
import Icon from "../components/Icon";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import { formatSql } from "./format";
import { writeWithoutWhere } from "./noWhere";
import ResultsPanel from "./ResultsPanel";
import { EMPTY_RUNNER, runnerReducer } from "./runner";
import SaveQueryDialog from "./SaveQueryDialog";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "./SqlEditor";
import { type Stmt, splitStatements } from "./statements";

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
  /** A statement finished, so Query History has a new entry. */
  onRan?(): void;
  /** The language service and the schemas it knows; without them the editor is plain. */
  lang?: { client: LangClient; schemas: SchemaCache };
  /** Go to definition on a table: show it in the Database Tree. */
  onShowInTree?(target: { connectionId: ConnectionId; database: string; schema: string | null; name: string }): void;
  /** Inline Ask on a selection, with Ctrl+I, and on a failed query; absent, neither shows. */
  ask?: AskKit;
}

/** Statements that change what the schema holds, after any leading comments. */
const DDL = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT)\b/i;

const RESTARTED_MS = 5000;

const noSubscribe = () => () => {};

const SPLIT_KEY = "dbview.queryEditorShare";

function loadShare(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 0.2 && v <= 0.8 ? v : 0.46;
  } catch {
    return 0.46;
  }
}

function saveShare(v: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(v));
  } catch {
    // Remembering the split is a convenience only.
  }
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
  onRan,
  lang,
  onShowInTree,
  ask,
}: Props) {
  const connection = connections.find((c) => c.id === tab.connectionId) ?? null;
  const isOpen = !!connection && openIds.has(connection.id);
  const dialect = connection?.dialect ?? "postgres";
  const [session, setSession] = useState<QuerySessionId | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(runnerReducer, EMPTY_RUNNER);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [share, setShare] = useState(loadShare);
  const [askSel, setAskSel] = useState<AskSelection | null>(null);
  const confirmed = useRef<Stmt | null>(null);
  const fetching = useRef(false);
  const latest = useRef(tab);
  latest.current = tab;
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

  // One session per tab, opened on the tab's Connection and database.
  useEffect(() => {
    if (!connection || !isOpen) {
      setSession(null);
      return;
    }
    let live = true;
    let opened: QuerySessionId | null = null;
    setSessionError(null);
    openQuerySession(connection.id, connection.dialect === "sqlite" ? null : tab.database)
      .then((s) => {
        opened = s;
        if (live) setSession(s);
        else void closeQuerySession(s).catch(() => {});
      })
      .catch((e) => live && setSessionError(errorText(e, connection.dialect)));
    return () => {
      live = false;
      setSession(null);
      // A run never carries on in another session, database or Connection.
      dispatch({ type: "sessionChanged" });
      if (opened) void closeQuerySession(opened).catch(() => {});
    };
  }, [connection?.id, isOpen, tab.database]);

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

  // Runs the queue one statement at a time; a missing WHERE asks first.
  useEffect(() => {
    if (!session) return;
    const running = state.items.some((i) => i.state.s === "running");
    if (running || state.confirm || state.queue.length === 0) return;
    const stmt = state.queue[0];
    const missing = writeWithoutWhere(stmt.text);
    if (missing && confirmed.current !== stmt) {
      dispatch({ type: "confirmNeeded", verb: missing.verb, table: missing.table });
      return;
    }
    confirmed.current = null;
    const id = state.nextId;
    const started = performance.now();
    dispatch({ type: "begin", now: started });
    executeSql(session, stmt.text).then(
      (ex) => {
        dispatch({ type: "done", id, outcome: ex.outcome, ms: ex.elapsedMs });
        if (DDL.test(stmt.text) && connection) lang?.schemas.invalidate(connection.id);
        onRan?.();
      },
      (error) => {
        dispatch({ type: "failed", id, error, ms: performance.now() - started });
        onRan?.();
      },
    );
  }, [state, session]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const running = state.items.find((i) => i.state.s === "running");
  const canRun = !!session && !running;

  function run(stmts: (Stmt | null)[]) {
    const list = stmts.filter((s): s is Stmt => !!s && s.text.trim() !== "");
    if (!canRun || list.length === 0) return;
    setNotice(null);
    dispatch({ type: "start", stmts: list });
  }

  const runCurrent = () => run([editorRef.current?.runTarget() ?? null]);
  const editorText = () => editorRef.current?.text() ?? latest.current.text;
  const runAll = () => run(splitStatements(editorText(), dialect));

  function cancel() {
    if (session && running) void cancelQuery(session).catch((e) => setNotice(errorText(e)));
  }

  function escape(): boolean {
    if (state.confirm) {
      dispatch({ type: "declined" });
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
      setToast(`Saved "${q.name}"`);
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
  const askSetup: AskSetup | undefined = ask && { ...ask, connection: askConnection, schema: askSchema };

  const active = state.items[state.active];
  const errorMark = active?.state.s === "error" ? wordAt(tab.text, active.state.at) : null;
  const lineAt = (offset: number) => tab.text.slice(0, offset).split("\n").length;

  return (
    <section className="query-tab" aria-label={tab.name}>
      <div className="toolbar query-toolbar">
        <h2 className="toolbar-title">
          {tab.name}
          {tab.savedId && <span className="muted"> Saved Query</span>}
        </h2>
        <label className="query-pick">
          <span className="visually-hidden">Connection</span>
          <select
            className="input input-small"
            disabled={!!running}
            value={tab.connectionId ?? ""}
            onChange={(e) => {
              const c = connections.find((x) => x.id === e.target.value);
              onChange({ ...latest.current, connectionId: c?.id ?? null, database: c?.database ?? null });
            }}
          >
            <option value="">Choose a Connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {openIds.has(c.id) ? "" : " (not open)"}
              </option>
            ))}
          </select>
        </label>
        {databases && (
          <label className="query-pick">
            <span className="visually-hidden">Database</span>
            <select
              className="input input-small"
              disabled={!!running}
              value={tab.database ?? ""}
              onChange={(e) => onChange({ ...latest.current, database: e.target.value || null })}
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {running ? (
          <button type="button" className="button button-small button-danger-fill" onClick={cancel}>
            <Icon name="stop" />
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className="button button-small button-primary" disabled={!canRun} onClick={runCurrent}>
              <Icon name="play" />
              Run <kbd>Ctrl Enter</kbd>
            </button>
            <button type="button" className="button button-small" disabled={!canRun} onClick={runAll}>
              <Icon name="playAll" />
              Run all
            </button>
          </>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="Format SQL"
          title="Format SQL (Shift+Alt+F)"
          onClick={() => editorRef.current?.replaceAll(formatSql(editorText(), dialect))}
        >
          <Icon name="format" />
        </button>
        <button type="button" className="icon-button" aria-label="Save query" title="Save query (Ctrl+S)" onClick={() => void save()}>
          <Icon name="save" />
        </button>
        <button
          type="button"
          className={historyOpen ? "icon-button icon-button-on" : "icon-button"}
          aria-label="Query History"
          aria-pressed={historyOpen}
          title="Query History"
          onClick={onToggleHistory}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className={assistantOpen ? "icon-button icon-button-on" : "icon-button"}
          aria-label="Ask AI"
          aria-pressed={assistantOpen}
          title="Ask AI (Ctrl+Alt+I)"
          onClick={onToggleAssistant}
        >
          <Icon name="sparkle" />
        </button>
      </div>

      <div className="query-work" ref={work} style={{ gridTemplateRows: `${share}fr 6px ${1 - share}fr` }}>
        <div className="query-editor">
          <SqlEditor
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
                  editorRef.current?.select(c.stmt.to, c.stmt.to);
                  editorRef.current?.insert("\nWHERE ");
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
          <div className="result-state">
            <h3>Open the Connection to run this query.</h3>
            <p className="muted">{connection.name} is not open. Open it in the Connections list.</p>
          </div>
        ) : sessionError ? (
          <div className="result-state result-state-error" role="alert">
            <h3>
              <Icon name="error" />
              {sessionError}
            </h3>
          </div>
        ) : (
          <ResultsPanel
            state={state}
            timeoutSecs={connection.queryTimeoutSecs}
            lineAt={lineAt}
            onSelect={(index) => dispatch({ type: "select", index })}
            onPin={(id) => dispatch({ type: "pin", id })}
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
          />
        )}
      </div>

      <div className="query-status">
        {connection ? (
          <>
            <span>{connection.name}</span>
            {tab.database && connection.dialect !== "sqlite" && <span>{tab.database}</span>}
            <span>{DIALECT_LABEL[connection.dialect]}</span>
            {connection.queryTimeoutSecs && <span>Timeout {connection.queryTimeoutSecs} s</span>}
            {!isOpen && <span>Not connected</span>}
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
        <span className="spacer" />
        <span className="query-position">
          Ln {position.line}, Col {position.column}
        </span>
      </div>

      {saving && (
        <SaveQueryDialog
          sql={tab.text}
          onCancel={() => setSaving(false)}
          onSaved={(q) => {
            setSaving(false);
            onChange({ ...latest.current, name: q.name, savedId: q.id, savedText: q.sql });
            onSaved(q);
            setToast(`Saved "${q.name}"`);
          }}
        />
      )}
      {toast && (
        <p className="toast" role="status">
          {toast}
        </p>
      )}
    </section>
  );
}
