// The Visual Query tab (frame 6.1): toolbar, the canvas of cards, the panel and the SQL pane.
import type { Edge, EdgeTypes, Node, NodeTypes, ReactFlowInstance } from "@xyflow/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DIALECT_LABEL,
  cancelQuery,
  closeQueryResult,
  closeQuerySession,
  errorText,
  fetchMoreRows,
  isCommandError,
  openConnection,
  openQuerySession,
  runVisualQuery,
  saveSavedQuery,
  visualQuerySql,
} from "../api/client";
import type {
  ConnectionConfig,
  ConnectionId,
  DialectKind,
  Group,
  ObjectPath,
  QuerySessionId,
  SavedQuery,
  SqlPart,
  VisualQuery,
  VqPreview,
  VqTable,
} from "../api/types";
import { keysFromEvent } from "../commands/keys";
import { hintFor, keysFor } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Menu, { MenuList } from "../components/Menu";
import SafetyTag from "../components/SafetyTag";
import Select from "../components/Select";
import { useToast } from "../components/Toast";
import DiagramCanvas, { type DragOverPorts } from "../diagram/DiagramCanvas";
import { CARD_WIDTH } from "../diagram/metrics";
import { durationText } from "../format/units";
import type { LangClient } from "../lang/client";
import { type SchemaCache, schemaKey } from "../lang/sql/schemaCache";
import ResultsPanel from "../query/ResultsPanel";
import { EMPTY_RUNNER, runnerReducer } from "../query/runner";
import { serverError } from "../query/serverError";
import { type Selection, type VisualTabDoc, sameModel } from "../shell/tabs";
import { OBJECT_DRAG_TYPE } from "../sidebar/OneTree";
import ColumnsPanel from "./ColumnsPanel";
import CrossJoinDialog from "./CrossJoinDialog";
import { NEW_VISUAL_NAME } from "./drafts";
import FilterPanel from "./FilterPanel";
import Finder, { type FinderTable } from "./Finder";
import JoinEdge, { JoinActionsContext, type JoinEdgeData, conditionText, isMadeHere, keyFor } from "./JoinEdge";
import JoinPopover from "./JoinPopover";
import {
  type VqSchema,
  addTable,
  aliasFor,
  baseType,
  columnTypes,
  connectColumns,
  countLine,
  crossGroups,
  crossTables,
  joinCandidates,
  loadingTables,
  mergeSchemas,
  missing,
  moveTable,
  pendingTables,
  pickForeignKey,
  removeCondition,
  removeJoin,
  removeTable,
  setAlias,
  setJoinKind,
  setRoot,
  swapSides,
  toggleColumn,
} from "./model";
import { nounFor } from "./nouns";
import PickPopover, { type PickChoice } from "./PickPopover";
import SaveDialog, { nameProblem } from "./SaveDialog";
import QueryCard, {
  type CardActions,
  CardActionsContext,
  type CardColumn,
  type DropTarget,
  DropTargetContext,
  type QueryCardData,
  queryCardHeight,
} from "./QueryCard";
import SqlPane, { type SqlBand } from "./SqlPane";
import QueryDiagramPane from "../querydiagram/QueryDiagramPane";

/** What the App can ask of an open tab: add a table from the tree's row menu, save for the close ask. */
export interface VisualTabControl {
  add(s: Selection): void;
  /** Overwrites the Saved Query; false when it is not saved yet or the save failed (the toast says why). */
  save(): Promise<boolean>;
}

export interface VisualQueryTabProps {
  doc: VisualTabDoc;
  /** Null when the tab's Connection was removed (P10). */
  connection: ConnectionConfig | null;
  open: boolean;
  group: Group | null;
  visible: boolean;
  lang: { client: LangClient; schemas: SchemaCache };
  rowEstimate(path: ObjectPath): number | null;
  onChange(doc: VisualTabDoc): void;
  onOpenInEditor(sql: string): void;
  onSaved(q: SavedQuery): void;
  /** Opens the tab's Connection, or `id` when Open here just rebound the tab to it. */
  onOpenConnection(id?: ConnectionId): void;
  /** Reconnect opened the dropped Connection again: the App counts it open. */
  onConnectionOpened?(id: ConnectionId): void;
  onRan?(): void;
  /** The place's Connections: a removed Connection is replaced by one of the model's Dialect. */
  connections?: ConnectionConfig[];
  controlRef?: MutableRefObject<VisualTabControl | null>;
  onDuplicate?(): void;
  onClose?(): void;
  /** The databases the Connection reaches, from the tree; the finder lists the tables of each (V6). */
  databases?: string[];
  /**
   * Every Saved Query: the others' names for the first save's name check (one name space, ignoring
   * case), and this one's stored SQL, kept when no SQL can be written now.
   */
  savedQueries?: SavedQuery[];
}

/** MySQL's own databases: reached, but never what a Visual Query reads, and heavy to load. */
const MYSQL_SYSTEM = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

/** The SQL pane refreshes this long after the last change. */
export const PREVIEW_MS = 120;
/** Where the first card goes, and the gap to the next one. */
const START = 48;
const GAP = 64;
const NODE_TYPES: NodeTypes = { vqCard: QueryCard as NodeTypes[string] };
const EDGE_TYPES: EdgeTypes = { join: JoinEdge };


/** A value for a `[name="..."]` selector. */
const attr = (v: string) => v.replace(/["\\]/g, "\\$&");

/** "stores is left out until you pick a Foreign Key." for the tables behind a pending pick. */
export function pendingLine(names: string[]): string {
  if (names.length === 0) return "";
  return `${listText(names)} ${names.length === 1 ? "is" : "are"} left out until you pick a Foreign Key.`;
}

/** "a", "a and b", "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Where a tree object sits in the model's addressing (D6). */
export function vqAddress(dialect: DialectKind, tabDb: string | null, path: ObjectPath): { schema: string | null; name: string } {
  if (dialect === "postgres") return { schema: path.schema, name: path.name };
  const home = dialect === "sqlite" ? (tabDb ?? "main") : tabDb;
  return { schema: path.database === home ? null : path.database, name: path.name };
}

/** The tree's path of a card's table, for its row estimate. */
export function objectPathOf(dialect: DialectKind, tabDb: string | null, t: { schema: string | null; name: string }): ObjectPath {
  if (dialect === "postgres") return { database: tabDb ?? "", schema: t.schema, name: t.name };
  return { database: t.schema ?? tabDb ?? "main", schema: null, name: t.name };
}

/**
 * "every order pairs with every menu item"; when either name has no singular of its own, the whole
 * sentence reads by rows: "every row of orders pairs with every row of data".
 */
export function pairsSentence(root: string, table: string): string {
  const a = nounFor(root);
  const b = nounFor(table);
  if (a.one === a.many || b.one === b.many) return `every row of ${root} pairs with every row of ${table}`;
  return `every ${a.one} pairs with every ${b.one}`;
}

/** The Core's warnings in words, with table names for its ids. */
export function warningLines(preview: VqPreview | null, model: VisualQuery): string[] {
  const name = (id: string) => model.tables.find((t) => t.id === id)?.name ?? id;
  const root = model.tables[0]?.name ?? "";
  return (preview?.query?.warnings ?? []).map((w) => {
    switch (w.kind) {
      case "crossJoin":
        return `${name(w.table)} has no Join, so ${pairsSentence(root, name(w.table))}.`;
      case "pendingPick":
        return `${name(w.table)} is left out until you pick a Foreign Key.`;
      case "leftOut":
        return `${listText(w.columns)} of ${name(w.table)} ${w.columns.length === 1 ? "is" : "are"} left out with it.`;
    }
  });
}

/**
 * The card each Join line brings in, as the Core wrote it: reading the lines in order, the side not
 * yet written. Right after a swap (a Left Join reached from its right side) that is the Join's left.
 */
export function joinBrings(parts: SqlPart[], model: VisualQuery): Map<string, string> {
  const seen = new Set<string>();
  const out = new Map<string, string>();
  for (const p of [...parts].sort((a, b) => a.fromLine - b.fromLine)) {
    if (p.part.kind === "from") seen.add(p.part.table);
    else if (p.part.kind === "join") {
      const joinId = p.part.join;
      const j = model.joins.find((x) => x.id === joinId);
      if (!j) continue;
      const brought = seen.has(j.right) && !seen.has(j.left) ? j.left : j.right;
      out.set(joinId, brought);
      seen.add(j.left);
      seen.add(j.right);
    }
  }
  return out;
}

/** Lines a card wrote: its FROM line, else the Join line that brings it in. */
function partsOfCard(parts: SqlPart[], brings: Map<string, string>, id: string): SqlPart[] {
  const from = parts.filter((p) => p.part.kind === "from" && p.part.table === id);
  if (from.length > 0) return from;
  return parts.filter((p) => p.part.kind === "join" && brings.get(p.part.join) === id);
}

const snap = (n: number) => Math.round(n / 16) * 16;

/** The model as far as the SQL goes: where a card sits on the canvas is not a change to the query. */
export function queryKeyOf(q: VisualQuery): string {
  return JSON.stringify({ ...q, tables: q.tables.map((t) => ({ id: t.id, schema: t.schema, name: t.name, alias: t.alias })) });
}

/** "Remove or replace 1 missing table to run.", or the first problem that stops the SQL; null when Run may go. */
export function runBlock(p: {
  connection: string | null;
  open: boolean;
  missing: number;
  sql: string | null;
  problems: string[];
  /** The tab's Query Session did not open: said on Run, not only in the Results tab. */
  sessionError?: string | null;
}): string | null {
  if (p.connection === null) return "This Visual Query's Connection was removed.";
  if (!p.open) return `${p.connection} is not open`;
  if (p.sessionError) return p.sessionError;
  if (p.missing > 0) return `Remove or replace ${p.missing} missing ${p.missing === 1 ? "table" : "tables"} to run.`;
  if (p.sql === null) return p.problems[0] ?? "Add a table to run.";
  return null;
}

/** The next free spot, right of the cards already there. */
function nextSpot(q: VisualQuery): { x: number; y: number } {
  if (q.tables.length === 0) return { x: START, y: START };
  const right = Math.max(...q.tables.map((t) => t.x));
  return { x: snap(right + CARD_WIDTH + GAP), y: START };
}

function findTable(schema: VqSchema, t: VqTable) {
  return schema.tables.find((s) => (s.schema ?? null) === (t.schema ?? null) && s.name === t.name);
}

type PanelTab = "columns" | "filter" | "results";

export default function VisualQueryTab(props: VisualQueryTabProps) {
  const { doc, connection, open, visible, lang, rowEstimate, onChange, onOpenInEditor, databases } = props;
  const model = doc.model;
  const dialect: DialectKind = model.dialect ?? connection?.dialect ?? "mysql";
  const tabDb = dialect === "sqlite" ? (doc.database ?? "main") : doc.database;
  const cid = connection?.id ?? null;
  const production = connection?.production ?? false;
  const { map } = useKeymap();
  const toast = useToast();

  // Every change builds on the latest doc, so two in one event (a multi-card drag) both hold.
  const latest = useRef(doc);
  latest.current = doc;
  const changeModel = useCallback(
    (f: (q: VisualQuery) => VisualQuery) => {
      const d = latest.current;
      const next = f(d.model);
      if (next === d.model) return;
      latest.current = { ...d, model: next };
      onChange(latest.current);
    },
    [onChange],
  );

  // ---- The finder's state, read by the schema loading below ----
  const empty = model.tables.length === 0;
  const [finderOpen, setFinderOpen] = useState(false);
  const finderShown = visible && (empty || finderOpen);

  // ---- The schema: the tab's database, and (MySQL, SQLite) every other database a card names ----
  const [stamp, setStamp] = useState(0);
  useEffect(() => lang.schemas.subscribe(() => setStamp((n) => n + 1)), [lang.schemas]);
  const others = dialect === "postgres" ? [] : [...new Set(model.tables.flatMap((t) => (t.schema && t.schema !== tabDb ? [t.schema] : [])))];
  const wanted = [...(tabDb ? [tabDb] : []), ...others];
  const wantedKey = wanted.join("\u0000");
  // V6: every database the Connection reaches (PostgreSQL reads only its own); loaded while the finder shows.
  const reached =
    dialect === "postgres" ? [] : (databases ?? []).filter((d) => d !== tabDb && !(dialect === "mysql" && MYSQL_SYSTEM.has(d.toLowerCase())));
  const reachedKey = reached.join("\u0000");
  useEffect(() => {
    if (!cid || !open) return;
    for (const db of wantedKey.split("\u0000")) if (db) void lang.schemas.ensure(cid, db);
  }, [cid, open, wantedKey, lang.schemas]);
  useEffect(() => {
    if (!cid || !open || !finderShown) return;
    for (const db of reachedKey.split("\u0000")) if (db) void lang.schemas.ensure(cid, db);
  }, [cid, open, finderShown, reachedKey, lang.schemas]);
  const loadState = useCallback(
    (db: string | null) => (cid && db ? lang.schemas.state(cid, db) : null),
    // `stamp` is the schema cache's change count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cid, lang.schemas, stamp],
  );
  const schema = useMemo(() => {
    const byDatabase = new Map<string, NonNullable<ReturnType<LangClient["sqlSchemaFor"]>>>();
    if (cid) {
      for (const db of new Set([...wantedKey.split("\u0000"), ...reachedKey.split("\u0000")])) {
        const s = db ? lang.client.sqlSchemaFor(schemaKey(cid, db)) : null;
        if (s) byDatabase.set(db, s);
      }
    }
    return mergeSchemas(dialect, tabDb, byDatabase, wantedKey.split("\u0000").filter((d) => d && d !== tabDb));
    // `stamp` is the schema cache's change count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, cid, wantedKey, reachedKey, dialect, tabDb, lang.client]);
  /** Reached databases whose tables are still on the way, for the finder's note. */
  const reachedLoading = reached.filter((db) => loadState(db) === "loading").length;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  // ---- The SQL, 120ms after the last change ----
  const types = useMemo(() => columnTypes(model, schema), [model, schema]);
  const typesKey = JSON.stringify(types);
  const [preview, setPreview] = useState<VqPreview | null>(null);
  /** The latest preview and the query key it was made for, together: a run of that model can use its text and parts. */
  const previewFor = useRef<{ key: string; query: VqPreview["query"] } | null>(null);
  useEffect(() => {
    if (!cid || model.tables.length === 0) {
      previewFor.current = null;
      setPreview(null);
      return;
    }
    let live = true;
    const key = `${queryKeyOf(model)}\u0000${typesKey}`;
    const timer = setTimeout(() => {
      visualQuerySql(cid, model, types).then(
        (p) => {
          if (!live) return;
          previewFor.current = { key, query: p.query };
          setPreview(p);
        },
        (e) => {
          if (!live) return;
          previewFor.current = null;
          setPreview({ query: null, problems: [{ target: { kind: "query" }, message: errorText(e) }] });
        },
      );
    }, PREVIEW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `types` is read through its key, so a new object with the same types sends nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, model, typesKey]);

  // ---- The run state: the tab's Query Session, its results, and what the last run left behind ----
  const [session, setSession] = useState<QuerySessionId | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [runner, dispatch] = useReducer(runnerReducer, EMPTY_RUNNER);
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  /** Bumped when a run may no longer report: another run, or the session went. */
  const runToken = useRef(0);
  const queryKey = useMemo(() => queryKeyOf(model), [model]);
  /** The query key of the last run and its table count, for "Changed since the last run" and the status line. */
  const [lastRun, setLastRun] = useState<{ key: string; tables: number } | null>(null);
  const changed = lastRun !== null && lastRun.key !== queryKey;
  /**
   * Where the last run's server error points: a line of the SQL that ran and, when that line is a
   * Join's, the Join. `shown` drops to false on the next change, which clears the marks.
   */
  const [errorMark, setErrorMark] = useState<{
    key: string;
    line: number;
    column: number;
    join: string | null;
    /** The server's words, the Join badge's tooltip. */
    message: string;
    shown: boolean;
  } | null>(null);
  const queryKeyNow = useRef(queryKey);
  queryKeyNow.current = queryKey;
  useEffect(() => {
    setErrorMark((m) => (m && m.shown && m.key !== queryKey ? { ...m, shown: false } : m));
  }, [queryKey]);
  const mark = errorMark?.shown ? errorMark : null;
  const markJoin = mark?.join ? model.joins.find((j) => j.id === mark.join) : undefined;

  // A run opens its session on the model's database: MySQL tables are written without it.
  const runDb = dialect === "sqlite" ? null : (model.database ?? doc.database);
  /** A run still going when its session went: settled by the next session effect, which knows why. */
  const stoppedRun = useRef<{ id: number; startedAt: number; cid: string | null } | null>(null);
  /** Bumped to open the session again: Reconnect after a dropped Connection, or Try again after a failed open. */
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const epochNow = useRef(sessionEpoch);
  epochNow.current = sessionEpoch;
  // Counts opened sessions: a reopened one can carry the same id as the one it replaces.
  const [sessionOpened, setSessionOpened] = useState(0);
  /** Reconnect's run, armed for the session open of this epoch on this Connection and database. */
  const rerun = useRef<{ epoch: number; cid: string; db: string | null } | null>(null);
  useEffect(() => {
    const stopped = stoppedRun.current;
    if (stopped) {
      stoppedRun.current = null;
      const why = !cid || !open ? `${connection?.name ?? "the Connection"} closed` : stopped.cid !== cid ? "the Connection changed" : "the database changed";
      // A stop, not a failure: Run comes back, and the late answer stays ignored (its token is stale).
      dispatch({ type: "stopped", id: stopped.id, why: `The run stopped because ${why}.`, ms: performance.now() - stopped.startedAt });
    }
    // A re-run is only for the open its Reconnect started.
    if (rerun.current && (rerun.current.epoch !== sessionEpoch || rerun.current.cid !== cid || rerun.current.db !== runDb)) rerun.current = null;
    if (!cid || !open) {
      rerun.current = null;
      setSession(null);
      return;
    }
    let live = true;
    let opened: QuerySessionId | null = null;
    setSessionError(null);
    openQuerySession(cid, runDb).then(
      (s) => {
        opened = s;
        if (live) {
          setSession(s);
          setSessionOpened((n) => n + 1);
        } else void closeQuerySession(s).catch(() => {});
      },
      (e) => {
        if (!live) return;
        rerun.current = null;
        setSessionError(errorText(e, dialect));
      },
    );
    return () => {
      live = false;
      setSession(null);
      // A run never reports into another session, database or Connection.
      runToken.current += 1;
      const going = runnerRef.current.items.find((i) => i.state.s === "running");
      if (going) stoppedRun.current = { id: going.id, startedAt: going.startedAt, cid };
      dispatch({ type: "sessionChanged" });
      // Marks from a session that is gone point at nothing.
      setErrorMark(null);
      if (opened) void closeQuerySession(opened).catch(() => {});
    };
    // The Dialect only words the error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, open, runDb, sessionEpoch]);

  // ---- Cards ----
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  const flow = useRef<ReactFlowInstance | null>(null);

  const loading = useMemo(() => new Set(loadingTables(model, schema)), [model, schema]);
  const gone = useMemo(() => new Set(missing(model, schema).tables), [model, schema]);
  const lone = useMemo(() => new Set(crossGroups(model).flatMap((g) => (g.length === 1 ? g : []))), [model]);
  /** The database a card's schema comes from. */
  const dbOf = (t: VqTable) => (dialect === "postgres" ? tabDb : (t.schema ?? tabDb));
  /** V6: a card not found yet waits, says its schema failed (Try again), or says the Connection is closed; never loads forever. */
  const cardState = (t: VqTable): QueryCardData["state"] => {
    // A closed Connection fades every card, even one whose schema is still known from before.
    if (!cid || !open) return "closed";
    if (!loading.has(t.id)) return gone.has(t.id) ? "missing" : "ok";
    if (loadState(tabDb) === "failed" || loadState(dbOf(t)) === "failed") return "failed";
    return "loading";
  };

  const nodes = useMemo<Node[]>(() => {
    return model.tables.map((t, i) => {
      const found = findTable(schema, t);
      const ticked: Record<string, QueryCardData["ticked"][string]> = {};
      for (const c of model.columns) if (c.table === t.id && !(c.column in ticked)) ticked[c.column] = c.aggregate;
      const joined = new Set<string>();
      for (const j of model.joins) {
        for (const p of j.on) {
          if (j.left === t.id) joined.add(p.leftColumn);
          if (j.right === t.id) joined.add(p.rightColumn);
        }
      }
      const columns: CardColumn[] = found
        ? found.columns.map((c) => ({ name: c.name, type: c.typeName, pk: c.pk }))
        : [...new Set([...Object.keys(ticked), ...joined])].map((name) => ({ name, type: null, pk: false }));
      const data: QueryCardData = {
        table: t,
        kind: found?.kind ?? "table",
        columns,
        ticked,
        joined: [...joined],
        state: cardState(t),
        lone: lone.has(t.id),
        home: (dialect === "postgres" ? tabDb : (t.schema ?? tabDb)) ?? "",
        problems: (preview?.problems ?? []).flatMap((p) => (p.target.kind === "table" && p.target.id === t.id ? [p.message] : [])),
        expanded: expanded.has(t.id),
        root: i === 0,
        dangerColumns: markJoin
          ? [
              ...(markJoin.left === t.id ? markJoin.on.map((p) => p.leftColumn) : []),
              ...(markJoin.right === t.id ? markJoin.on.map((p) => p.rightColumn) : []),
            ]
          : undefined,
      };
      return {
        id: t.id,
        type: "vqCard",
        position: { x: t.x, y: t.y },
        initialWidth: CARD_WIDTH,
        initialHeight: queryCardHeight(data),
        data,
      };
    });
    // `cardState` reads the load states, which change with `schema`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, schema, loading, gone, lone, preview, expanded, dialect, tabDb, open, connection, markJoin]);

  // ---- Joins: the edges, their popovers, the drag chip and J ----
  const [openJoin, setOpenJoin] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [openPick, setOpenPick] = useState<{ id: string; anchor: DOMRect | null } | null>(null);
  const tableOf = useCallback((id: string) => model.tables.find((t) => t.id === id), [model.tables]);
  const joinProblem = useCallback(
    (id: string) => (preview?.problems ?? []).find((p) => p.target.kind === "join" && p.target.id === id)?.message ?? null,
    [preview],
  );
  /** The badge's danger: the Core's problem, else the server's error in the Join's lines. */
  const joinDanger = useCallback(
    (id: string) => joinProblem(id) ?? (mark?.join === id ? mark.message : null),
    [joinProblem, mark],
  );

  const edges = useMemo<Edge[]>(
    () =>
      model.joins.map((j) => {
        const p = j.pending == null ? j.on[0] : undefined;
        const left = tableOf(j.left);
        const right = tableOf(j.right);
        const data: JoinEdgeData = {
          join: j,
          madeHere: isMadeHere(schema, j, left, right),
          selected: openJoin?.id === j.id || openPick?.id === j.id,
          danger: joinDanger(j.id),
          title: `Join ${left?.name ?? ""} to ${right?.name ?? ""}`,
        };
        return {
          id: j.id,
          source: j.left,
          target: j.right,
          sourceHandle: p ? `${p.leftColumn}:s` : null,
          targetHandle: p ? `${p.rightColumn}:t` : null,
          type: "join",
          data,
        };
      }),
    [model.joins, schema, openJoin, openPick, tableOf, joinDanger],
  );

  /** The rects of a Join's two cards, which its popover keeps clear of. */
  const cardRects = (j: { left: string; right: string }) =>
    [j.left, j.right].flatMap((id) => {
      const el = canvasBox.current?.querySelector(`.react-flow__node[data-id="${attr(id)}"]`);
      return el ? [el.getBoundingClientRect()] : [];
    });

  const joinActions = useMemo(
    () => ({
      open: (id: string, anchor: DOMRect) => {
        const j = latest.current.model.joins.find((x) => x.id === id);
        if (!j) return;
        if (j.pending != null) {
          setOpenJoin(null);
          setOpenPick((o) => (o?.id === id ? null : { id, anchor }));
        } else {
          setOpenPick(null);
          setOpenJoin((o) => (o?.id === id ? null : { id, anchor }));
        }
      },
    }),
    [],
  );

  // A pending Join opens its Pick popover by itself the first time it appears; one restored with
  // the tab waits for its badge.
  const seenPending = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = model.joins.filter((j) => j.pending != null && j.pending.length > 0).map((j) => j.id);
    if (seenPending.current === null) {
      seenPending.current = new Set(ids);
      return;
    }
    const seen = seenPending.current;
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length > 0) {
      setOpenJoin(null);
      setOpenPick({ id: fresh[0], anchor: null });
    }
  }, [model.joins]);
  // A popover whose Join is gone, or no longer of its sort, closes.
  useEffect(() => {
    if (openJoin && !model.joins.some((j) => j.id === openJoin.id && j.pending == null)) setOpenJoin(null);
    if (openPick && !model.joins.some((j) => j.id === openPick.id && j.pending != null)) setOpenPick(null);
  }, [model.joins, openJoin, openPick]);
  // The Pick popover that opened by itself moves beside its badge once the badge is drawn.
  useLayoutEffect(() => {
    if (!openPick || openPick.anchor) return;
    const r = document.querySelector(`.vq-join-badge[data-join="${attr(openPick.id)}"]`)?.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) setOpenPick({ id: openPick.id, anchor: r });
  }, [openPick, edges]);

  // The column drag: what it is over, Shift, and which side it started from.
  const [drag, setDrag] = useState<DragOverPorts | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const fromLeftDot = useRef(false);
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    const onPointer = (e: MouseEvent) => setShiftHeld(e.shiftKey);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("mousemove", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("mousemove", onPointer);
      setShiftHeld(false);
    };
  }, [dragging]);
  const onCanvasDown = (e: ReactMouseEvent) => {
    const id = (e.target as HTMLElement).closest?.(".react-flow__handle")?.getAttribute("data-handleid") ?? "";
    fromLeftDot.current = id.endsWith(":t");
  };

  /** What a drop would do: the words, the condition as the Core writes it, and a type warning. */
  const dropPlan = useMemo(() => {
    if (!drag?.over || drag.over.nodeId === drag.from.nodeId) return null;
    // A drag from a left-hand dot drops as if made the other way round (the canvas swaps the ends).
    const [a, b] = fromLeftDot.current ? [drag.over, drag.from] : [drag.from, drag.over];
    const from = { table: a.nodeId, column: a.column };
    const to = { table: b.nodeId, column: b.column };
    const between = (x: { left: string; right: string }) =>
      (x.left === from.table && x.right === to.table) || (x.left === to.table && x.right === from.table);
    const existing = model.joins.some(between);
    const after = connectColumns(model, from, to, shiftHeld, () => "\u0000drag");
    const j = after.joins.find(between);
    const pair = j?.on[j.on.length - 1];
    const l = j && tableOf(j.left);
    const r = j && tableOf(j.right);
    const condition = pair && l && r ? conditionText(pair, l.alias, r.alias) : "";
    const tFrom = types[drag.from.nodeId]?.[drag.from.column];
    const tOver = types[drag.over.nodeId]?.[drag.over.column];
    const differ = !!tFrom && !!tOver && baseType(tFrom) !== baseType(tOver);
    const text = !existing ? "Drop to add a Join" : shiftHeld ? "Drop to add a condition" : "Drop to change the Join";
    return { text, condition, types: differ ? `Types differ: ${tFrom} and ${tOver}. The server may refuse it.` : null };
  }, [drag, model, shiftHeld, types, tableOf]);
  const dropTarget = useMemo<DropTarget | null>(
    () => (drag?.over && dropPlan ? { table: drag.over.nodeId, column: drag.over.column, warn: dropPlan.types !== null } : null),
    [drag, dropPlan],
  );
  const [chipAt, setChipAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!dropTarget) return setChipAt(null);
    const row = canvasBox.current?.querySelector(
      `.react-flow__node[data-id="${attr(dropTarget.table)}"] li[data-column="${attr(dropTarget.column)}"]`,
    );
    const r = row?.getBoundingClientRect();
    setChipAt(r ? { left: r.left, top: r.top } : null);
  }, [dropTarget]);

  // J on a column row: the other cards' columns, the same type first; Enter makes the Join.
  const [jMenu, setJMenu] = useState<{ table: string; column: string; at: { x: number; y: number } } | null>(null);
  const jRow = useRef<HTMLElement | null>(null);
  const jOpen = jMenu !== null;
  useEffect(() => {
    if (!jOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".vq-join-menu")) setJMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [jOpen]);

  /** Try again on a card: loads its database, and the tab's, again where they failed. */
  const retryCard = useRef<(id: string) => void>(() => {});
  retryCard.current = (id) => {
    const t = latest.current.model.tables.find((x) => x.id === id);
    if (!t || !cid || !open) return;
    for (const db of new Set([tabDb, dbOf(t)])) if (db && loadState(db) === "failed") void lang.schemas.ensure(cid, db);
  };
  const actions = useMemo<CardActions>(
    () => ({
      toggle: (id, column) => changeModel((q) => toggleColumn(q, id, column)),
      remove: (id) => changeModel((q) => removeTable(q, id)),
      rename: (id, alias) => changeModel((q) => setAlias(q, id, alias)),
      setRoot: (id) => changeModel((q) => setRoot(q, id)),
      expand: (id) => setExpanded((s) => new Set([...s, id])),
      retry: (id) => retryCard.current(id),
      joinFrom: (id, column, anchor) => {
        jRow.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setJMenu({ table: id, column, at: { x: anchor.left, y: anchor.bottom } });
      },
    }),
    [changeModel],
  );

  // ---- Adding tables ----
  const addCard = useCallback(
    (t: { schema: string | null; name: string }, at?: { x: number; y: number }) => {
      const d = latest.current;
      // A drop without a usable point (no pointer position) goes where a found table would.
      const spot = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: snap(at.x), y: snap(at.y) } : nextSpot(d.model);
      const added = addTable(d.model, t, schemaRef.current, spot);
      changeModel(() => added.query);
      if (added.joinedTo.length > 0) {
        toast.show({ kind: "info", text: `Joined ${t.name} to ${listText(added.joinedTo)} from their Foreign Keys.` });
      }
    },
    [changeModel, toast],
  );

  /** A table or view from the tree (row menu or drop); another Connection's is refused (D15). */
  const addSelection = useCallback(
    (s: Selection, at?: { x: number; y: number }) => {
      if (s.connectionId !== cid) {
        toast.show({ kind: "info", text: "Visual Queries use one Connection. Data Transfer copies between Connections." });
        return;
      }
      if (s.kind !== "table" && s.kind !== "view") return;
      addCard(vqAddress(dialect, tabDb, s.path), at);
    },
    [addCard, cid, dialect, tabDb, toast],
  );
  const { controlRef } = props;
  /** The close ask's save; set below, where the SQL is known. */
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { add: (s) => addSelection(s), save: () => saveRef.current() };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, addSelection]);

  function onDropObject(data: DataTransfer, at: { x: number; y: number }) {
    const raw = data.getData(OBJECT_DRAG_TYPE);
    if (!raw) return;
    let s: Selection;
    try {
      s = JSON.parse(raw) as Selection;
    } catch {
      return;
    }
    addSelection(s, at);
  }

  // ---- The finder ----
  const canvasBox = useRef<HTMLDivElement>(null);
  const inlineInput = useRef<HTMLInputElement>(null);
  const finderTables = useMemo<FinderTable[]>(
    () =>
      schema.tables.map((t) => ({
        schema: t.schema ?? null,
        name: t.name,
        kind: t.kind,
        rows: t.kind === "table" ? rowEstimate(objectPathOf(dialect, tabDb, { schema: t.schema ?? null, name: t.name })) : null,
      })),
    [schema, rowEstimate, dialect, tabDb],
  );
  const floatingInput = useRef<HTMLInputElement>(null);
  const loadingNote =
    reachedLoading > 0 ? `Loading the tables of ${reachedLoading} more ${reachedLoading === 1 ? "database" : "databases"}.` : null;
  /** The canvas takes focus back when the finder adds its first card or closes. */
  const focusCanvas = useCallback(() => canvasBox.current?.querySelector<HTMLElement>(".diagram-canvas")?.focus(), []);
  const openFinder = () => {
    if (empty) inlineInput.current?.focus();
    else if (finderOpen) floatingInput.current?.focus();
    else setFinderOpen(true);
  };
  const closeFinder = useCallback(() => {
    setFinderOpen(false);
    focusCanvas();
  }, [focusCanvas]);
  // I2: the floating finder lives in document.body, outside the hidden pane: it closes when the tab hides,
  // and focus never stays in a hidden tab, so its keys cannot reach it.
  useEffect(() => {
    if (visible) return;
    setFinderOpen(false);
    const el = document.activeElement;
    if (el instanceof HTMLElement && canvasBox.current?.closest(".vq-tab")?.contains(el)) el.blur();
  }, [visible]);

  // ---- SQL pane ----
  const sql = preview?.query?.sql ?? null;
  const parts = useMemo(() => preview?.query?.parts ?? [], [preview]);
  const brings = useMemo(() => joinBrings(parts, model), [parts, model]);
  // A selected card bands the lines it wrote; a Join with its popover open bands its own.
  const selectedJoin = openJoin?.id ?? openPick?.id ?? null;
  const bands = useMemo<SqlBand[]>(
    () => [
      // The server's error line, until the next change; first, so it wins over a selection.
      ...(mark ? [{ from: mark.line, to: mark.line, kind: "danger" as const }] : []),
      ...[
        ...selected.flatMap((id) => partsOfCard(parts, brings, id)),
        ...parts.filter((p) => p.part.kind === "join" && p.part.join === selectedJoin),
      ].map((p): SqlBand => ({ from: p.fromLine, to: p.toLine, kind: "select" })),
    ],
    [selected, parts, brings, selectedJoin, mark],
  );
  const selectCard = (id: string) => {
    flow.current?.setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setSelected([id]);
  };

  // ---- Show diagram (B1): the query diagram of the generated SQL, beside the canvas ----
  const [diagramOpen, setDiagramOpen] = useState(false);
  const diagramSql = useRef<string | null>(null);
  if (sql !== null) diagramSql.current = sql;
  // The key and the button agree: it opens only while there is SQL to draw.
  const toggleDiagram = () => setDiagramOpen((o) => !o && sql !== null);
  const diagramLoad = loadState(tabDb);
  const onLine = (line: number) => {
    const part = parts.find((p) => line >= p.fromLine && line <= p.toLine && (p.part.kind === "from" || p.part.kind === "join"));
    if (!part) return;
    if (part.part.kind === "from") selectCard(part.part.table);
    else if (part.part.kind === "join") {
      const brought = brings.get(part.part.join);
      if (brought) selectCard(brought);
    }
  };
  /**
   * The Core's query for the model as it is now: the shown preview when it is this model's, else
   * written again and put in the pane at once, so the pane never lags behind what runs or opens.
   */
  const queryNow = useCallback(
    async (q: VisualQuery, t: ReturnType<typeof columnTypes>): Promise<VqPreview["query"]> => {
      const key = `${queryKeyOf(q)}\u0000${JSON.stringify(t)}`;
      const fresh = previewFor.current;
      if (fresh && fresh.key === key) return fresh.query;
      if (!cid) return null;
      let p: VqPreview;
      try {
        p = await visualQuerySql(cid, q, t);
      } catch {
        return null;
      }
      // A change made meanwhile has its own preview on the way.
      if (latest.current.model === q) {
        previewFor.current = { key, query: p.query };
        setPreview(p);
      }
      return p.query;
    },
    [cid],
  );
  /** Runs `f` with the SQL of the model as it is now, not a preview still on its 120ms way. */
  const withSqlNow = (f: (sql: string) => void) => {
    const q = latest.current.model;
    void queryNow(q, columnTypes(q, schemaRef.current)).then((query) => {
      if (query) f(query.sql);
    });
  };
  const openInEditor = () => {
    if (sql !== null) withSqlNow(onOpenInEditor);
  };
  const copy = () => {
    if (sql !== null) withSqlNow((text) => void navigator.clipboard?.writeText(text).catch(() => {}));
  };
  const emptyLines = empty
    ? ["The SQL appears here once a table is on the canvas."]
    : sql === null
      ? (preview?.problems ?? []).filter((p) => p.target.kind !== "table").map((p) => p.message)
      : [];

  // ---- Run (Ctrl+Enter or the Run button) ----
  const [panel, setPanel] = useState<PanelTab>("columns");
  const running = runner.items.some((i) => i.state.s === "running");
  const block = runBlock({
    connection: connection?.name ?? null,
    open,
    missing: gone.size,
    sql,
    problems: (preview?.problems ?? []).map((p) => p.message),
    sessionError,
  });
  const canRun = block === null && session !== null && !running;
  /** D16: each set of CROSS JOIN tables this tab already asked about, in memory only. */
  const askedCross = useRef(new Set<string>());
  const [crossAsk, setCrossAsk] = useState<{ key: string } | null>(null);

  function requestRun() {
    if (!canRun) return;
    const cross = crossTables(latest.current.model);
    const key = [...cross].sort().join("\u0000");
    if (cross.length > 0 && !askedCross.current.has(key)) {
      setCrossAsk({ key });
      return;
    }
    void startRun();
  }

  async function startRun() {
    const s = session;
    if (!s || !cid || runnerRef.current.items.some((i) => i.state.s === "running")) return;
    const token = ++runToken.current;
    const q = latest.current.model;
    const t = columnTypes(q, schemaRef.current);
    const key = queryKeyOf(q);
    // The text and parts the run's error is read against: the shown preview when it is this model's,
    // else written now and shown in the pane before the run starts.
    const fresh = previewFor.current;
    let shown = fresh && fresh.key === `${key}\u0000${JSON.stringify(t)}` ? fresh.query : null;
    if (!shown) {
      shown = await queryNow(q, t);
      if (token !== runToken.current) return;
    }
    const text = shown?.sql ?? "";
    const runParts = shown?.parts ?? [];
    setPanel("results");
    setErrorMark(null);
    setLastRun({ key, tables: q.tables.length });
    const id = runnerRef.current.nextId;
    const started = performance.now();
    dispatch({ type: "start", stmts: [{ from: 0, to: text.length, text }] });
    dispatch({ type: "begin", now: started });
    // D12: the editor's 5a path with no pass; a generated query only reads, so nothing asks.
    runVisualQuery(s, q, t, null).then(
      (r) => {
        if (token !== runToken.current) return;
        dispatch({ type: "done", id, outcome: r.execution.outcome, ms: r.execution.elapsedMs, sql: r.sql });
        props.onRan?.();
      },
      (error) => {
        if (token !== runToken.current) return;
        dispatch({ type: "failed", id, error, ms: performance.now() - started });
        if (isCommandError(error) && error.kind === "query" && typeof error.message === "string") {
          const said = serverError(error.message, dialect, text);
          if (said.position) {
            const line = said.position.line;
            const part = runParts.find((p) => line >= p.fromLine && line <= p.toLine);
            setErrorMark({
              key,
              line,
              column: said.position.column ?? 1,
              join: part?.part.kind === "join" ? part.part.join : null,
              message: said.text,
              shown: key === queryKeyNow.current,
            });
          }
        }
        props.onRan?.();
      },
    );
  }

  function cancelRun() {
    if (session && running) void cancelQuery(session).catch((e) => toast.show({ kind: "error", text: errorText(e, dialect) }));
  }

  /** "Reconnect and run": opens the dropped Connection again, then a new session, then runs on it. */
  async function reconnect() {
    if (!cid) return;
    const id = cid;
    const db = runDb;
    try {
      await openConnection(id);
      props.onConnectionOpened?.(id);
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e, dialect) });
      return;
    }
    // Moved to another Connection or database meanwhile: the run was for the old one.
    if (latest.current.connectionId !== id) return;
    const next = epochNow.current + 1;
    rerun.current = { epoch: next, cid: id, db };
    setSessionEpoch(next);
  }
  // The session Reconnect asked for is open: run on it.
  useEffect(() => {
    const r = rerun.current;
    if (!session || !r || r.epoch !== sessionEpoch) return;
    rerun.current = null;
    requestRun();
    // Only a new session starts the re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOpened]);

  const fetching = useRef(false);
  async function fetchMore(id: number) {
    if (!session || fetching.current) return;
    fetching.current = true;
    try {
      const more = await fetchMoreRows(session);
      dispatch({ type: "more", id, rows: more.rows, hasMore: more.hasMore });
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e, dialect) });
    } finally {
      fetching.current = false;
    }
  }

  /** Add a Join on the CROSS JOIN ask: the lone card takes focus, ready for a column drag or J. */
  function addJoinInstead() {
    setCrossAsk(null);
    const first = crossGroups(latest.current.model)[0]?.[0];
    if (!first) return;
    selectCard(first);
    requestAnimationFrame(() => canvasBox.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${attr(first)}"]`)?.focus());
  }

  /** "Show the Join" on a server error in a Join's lines: its popover, beside its badge. */
  function showErrorJoin() {
    const id = mark?.join;
    if (!id) return;
    const r = document.querySelector(`.vq-join-badge[data-join="${attr(id)}"]`)?.getBoundingClientRect();
    setOpenPick(null);
    setOpenJoin({ id, anchor: r ?? new DOMRect() });
  }

  const runKeys = keysFor(map, "query.run");
  const onTabKey = (e: ReactKeyboardEvent) => {
    // Keys in a dialog or popover (portalled, so they bubble here) are theirs: Esc closes it, Ctrl+Enter runs nothing.
    if (e.defaultPrevented || (e.target as Element).closest?.('[role="dialog"]')) return;
    const keys = keysFromEvent(e.nativeEvent);
    if (keys && runKeys.includes(keys)) {
      e.preventDefault();
      requestRun();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      cancelRun();
    }
  };

  // ---- Keys (D9): the focused tab wins ----
  const root = useRef<HTMLDivElement>(null);
  useCommandKeys(
    visible
      ? {
          "visualQuery.addTable": openFinder,
          "visualQuery.openInEditor": openInEditor,
          "query.save": requestSave,
          "diagram.toggle": toggleDiagram,
        }
      : {},
    { region: root },
  );

  // ---- Save (Ctrl+S): the first save asks for a name, later ones overwrite ----
  const [naming, setNaming] = useState(false);
  /** The last SQL the Core wrote here: a saved row keeps it, so search and Open in editor need no regeneration. */
  const lastSql = useRef<string | null>(null);
  if (sql !== null) lastSql.current = sql;

  /** A save on the way: another Ctrl+S or Save waits for it rather than asking or saving twice. */
  const saving = useRef(false);

  async function saveAs(name: string): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true;
    try {
      return await saveNow(name);
    } finally {
      saving.current = false;
    }
  }

  async function saveNow(name: string): Promise<boolean> {
    const d = latest.current;
    const q = d.model;
    const visualJson = JSON.stringify(q);
    // Only an open Connection writes SQL with the column types; otherwise the stored SQL stays
    // (a closed or removed Connection never empties it or swaps it for untyped SQL).
    let fresh: string | null = null;
    if (cid && open) {
      try {
        fresh = (await visualQuerySql(cid, q, columnTypes(q, schemaRef.current))).query?.sql ?? null;
      } catch {
        fresh = null;
      }
    }
    // The stored SQL is this model's only while the model is the saved one; after an edit, the
    // last preview is closer to it (N1). Either beats an empty text.
    const stored = d.savedId ? (props.savedQueries?.find((x) => x.id === d.savedId)?.sql ?? null) : null;
    const text = fresh ?? (sameModel(q, d.savedJson) ? (stored ?? lastSql.current) : (lastSql.current ?? stored)) ?? "";
    try {
      // A removed Connection sends none, so the stored "opens on" is kept and no dead id is written.
      const saved = await saveSavedQuery({ id: d.savedId, name, sql: text, kind: "visual", visualJson, connectionId: connection?.id ?? null });
      latest.current = { ...latest.current, name: saved.name, savedId: saved.id, savedJson: visualJson };
      onChange(latest.current);
      props.onSaved(saved);
      toast.show({ kind: "success", text: `Saved. ${saved.name} is in Saved Queries.` });
      return true;
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e, dialect) });
      return false;
    }
  }

  function requestSave() {
    if (latest.current.model.tables.length === 0 || saving.current) return;
    if (latest.current.savedId === null) setNaming(true);
    else void saveAs(latest.current.name);
  }
  saveRef.current = () => (latest.current.savedId === null ? Promise.resolve(false) : saveAs(latest.current.name));

  // ---- Tidy ----
  function tidy() {
    const req = {
      nodes: nodes.map((n) => ({ id: n.id, w: CARD_WIDTH, h: n.initialHeight ?? 0 })),
      edges: model.joins.map((j) => ({ from: j.left, to: j.right })),
      existing: {},
      rankdir: "LR" as const,
    };
    void lang.client.layout(req).then(
      (at) => changeModel((q) => q.tables.reduce((m, t) => (at[t.id] ? moveTable(m, t.id, at[t.id]) : m), q)),
      () => {},
    );
  }

  // ---- More: Rename, Duplicate, Close ----
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const closeRename = () => {
    setRenaming(null);
    setRenameError(null);
  };
  /**
   * A saved Visual Query's new name is saved at once, with the stored SQL and model: an unsaved edit
   * stays unsaved. A tab not saved yet only changes its name.
   */
  async function rename(raw: string) {
    const name = raw.trim();
    const d = latest.current;
    if (!name || name === d.name) return closeRename();
    if (d.savedId === null) {
      closeRename();
      latest.current = { ...d, name };
      onChange(latest.current);
      return;
    }
    const others = (props.savedQueries ?? []).filter((x) => x.id !== d.savedId);
    const problem = nameProblem(
      name,
      others.map((x) => x.name),
      others.filter((x) => x.kind !== "visual").map((x) => x.name),
    );
    if (problem) return setRenameError(problem);
    const stored = props.savedQueries?.find((x) => x.id === d.savedId);
    closeRename();
    try {
      const saved = await saveSavedQuery({
        id: d.savedId,
        name,
        sql: stored?.sql ?? lastSql.current ?? "",
        kind: "visual",
        visualJson: stored?.visualJson ?? d.savedJson ?? JSON.stringify(d.model),
        connectionId: stored ? (stored.connectionId ?? null) : (connection?.id ?? null),
      });
      latest.current = { ...latest.current, name: saved.name };
      onChange(latest.current);
      props.onSaved(saved);
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e, dialect) });
    }
  }

  // ---- A removed Connection (P10): one of the model's Dialect takes over ----
  const choices = (props.connections ?? []).filter((c) => c.dialect === dialect);
  const [pick, setPick] = useState<string>("");
  const picked = choices.some((c) => c.id === pick) ? pick : (choices[0]?.id ?? "");
  /** The Connection Open here just rebound the tab to, until its databases are known. */
  const reboundTo = useRef<ConnectionId | null>(null);
  // M5: once open, a picked Connection that does not reach the tab's database takes its own default
  // database, where the missing check says "Not found in {database}" for the tables it lacks.
  useEffect(() => {
    const want = reboundTo.current;
    if (!want || cid !== want || !open || !databases || dialect === "sqlite") return;
    reboundTo.current = null;
    const d = latest.current;
    const db = d.model.database ?? d.database;
    const home = connection?.database ?? null;
    if ((db && databases.includes(db)) || !home || home === db) return;
    latest.current = { ...d, database: home, model: { ...d.model, database: home } };
    onChange(latest.current);
    // Runs when the rebound Connection opens and its databases arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, open, databases]);

  // The LIMIT as typed, here so a text that is not sent (5.5) and its problem outlive a tab switch.
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const runKey = hintFor(map, "query.run");
  const saveKey = hintFor(map, "query.save");
  const addKey = hintFor(map, "visualQuery.addTable");
  const diagramKey = hintFor(map, "diagram.toggle");
  const wash = production ? " prod-wash" : "";

  // ---- The panel: the Core's output names and each card's columns ----
  const outputs = preview?.query?.outputs ?? [];
  const tableColumns = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const n of nodes) out[n.id] = (n.data as QueryCardData).columns.map((c) => c.name);
    return out;
  }, [nodes]);
  const problems = preview?.problems ?? [];

  // ---- The status line: a table left out behind a pending pick ----
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setStatusSlot(visible ? document.getElementById("app-status-slot") : null);
  }, [visible]);
  const statusText = pendingLine(pendingTables(model).flatMap((id) => (tableOf(id) ? [tableOf(id)!.name] : [])));
  // After a run: "3 tables", "10 rows", "38ms", as the editor's status line says them.
  const shownRun = runner.items[runner.active]?.state;
  const ranLine =
    lastRun && shownRun?.s === "rows"
      ? [
          `${lastRun.tables} ${lastRun.tables === 1 ? "table" : "tables"}`,
          `${shownRun.rows.length.toLocaleString("en-US")}${shownRun.hasMore ? "+" : ""} ${shownRun.rows.length === 1 && !shownRun.hasMore ? "row" : "rows"}`,
          durationText(shownRun.ms),
        ]
      : [];
  const status = (
    <>
      {ranLine.map((t) => (
        <span key={t} className="vq-status-ran">
          {t}
        </span>
      ))}
      {changed && (
        <span className="vq-changed">
          <Icon name="alert" size={14} />
          Changed since the last run
        </span>
      )}
      <span className="vq-status" role="status" aria-label="Visual Query status">
        {statusText}
      </span>
    </>
  );

  // ---- The open popovers ----
  const popJoin = openJoin ? model.joins.find((j) => j.id === openJoin.id && j.pending == null) : undefined;
  const pickJoin = openPick ? model.joins.find((j) => j.id === openPick.id && j.pending != null) : undefined;
  const pickChoices = useMemo<PickChoice[]>(() => {
    if (!pickJoin?.pending) return [];
    const l = tableOf(pickJoin.left);
    const r = tableOf(pickJoin.right);
    return pickJoin.pending.map((c) => ({ ...c, keyName: l && r ? (keyFor(schema, l, r, c.on)?.name ?? null) : null }));
  }, [pickJoin, schema, tableOf]);
  const closeJoin = () => setOpenJoin(null);
  /** Focus after a popover closes, when what had it is gone: the Join's badge, else the canvas. */
  const focusAfter = (joinId: string) => () =>
    document.querySelector<HTMLElement>(`.vq-join-badge[data-join="${attr(joinId)}"]`) ??
    canvasBox.current?.querySelector<HTMLElement>(".diagram-canvas") ??
    null;
  const onJoin = (f: (q: VisualQuery, id: string) => VisualQuery) => {
    if (popJoin) changeModel((q) => f(q, popJoin.id));
  };
  const candidates = jMenu ? joinCandidates(model, { table: jMenu.table, column: jMenu.column }, schema) : [];
  const closeJMenu = () => {
    setJMenu(null);
    jRow.current?.focus();
  };

  return (
    <div className="vq-tab" ref={root} onKeyDown={onTabKey}>
      <div className="vq-toolbar" role="toolbar" aria-label="Visual Query">
        <button
          type="button"
          className="button button-small button-quiet vq-connection"
          title={connection ? (open ? connection.name : `Open ${connection.name}`) : "Connection removed"}
          onClick={() => connection && !open && props.onOpenConnection()}
        >
          {connection && <DbMark dialect={connection.dialect} open={open} size={14} label={null} />}
          <span className="editor-header-name">{connection ? connection.name : "Connection removed"}</span>
        </button>
        {connection && <SafetyTag connection={connection} small />}
        <span className="editor-header-divider" aria-hidden="true" />
        <button type="button" className="button button-small button-quiet" onClick={openFinder}>
          <Icon name="plus" size={14} />
          Add table
          {addKey && <Kbd keys={addKey} />}
        </button>
        <button type="button" className="button button-small button-quiet" disabled={model.tables.length < 2} onClick={tidy}>
          <Icon name="arrange" size={14} />
          Tidy
        </button>
        <span className="editor-header-divider" aria-hidden="true" />
        <span className="vq-count">{countLine(model)}</span>
        <span className="spacer" />
        <button
          type="button"
          className={diagramOpen ? "button button-small button-quiet button-on" : "button button-small button-quiet"}
          aria-pressed={diagramOpen}
          disabled={sql === null && !diagramOpen}
          onClick={toggleDiagram}
        >
          <Icon name="flow" size={14} />
          Show diagram
          {diagramKey && <Kbd keys={diagramKey} />}
        </button>
        {/* Production keeps the plain primary "Run": a Visual Query only reads (DESIGN-NEXT 10.5). */}
        <button
          type="button"
          className="button button-small button-primary"
          disabled={!canRun}
          title={block ?? undefined}
          onClick={() => {
            requestRun();
            // The button turns off while the run goes: the canvas keeps Esc and Ctrl+Enter.
            focusCanvas();
          }}
        >
          <Icon name="play" size={14} />
          Run
          {runKey && <Kbd keys={runKey} />}
        </button>
        <button type="button" className="button button-small" disabled={empty} onClick={requestSave}>
          <Icon name="save" size={14} />
          Save
          {saveKey && <Kbd keys={saveKey} />}
        </button>
        <Menu
          label="More"
          align="end"
          compact
          trigger={(p) => (
            <button type="button" {...p} className="icon-button" aria-label="More" title="More">
              <Icon name="moreHorizontal" size={14} />
            </button>
          )}
          items={[
            { key: "rename", label: "Rename...", icon: <Icon name="edit" />, onSelect: () => setRenaming(doc.name) },
            { key: "duplicate", label: "Duplicate", icon: <Icon name="duplicate" />, disabled: !props.onDuplicate, onSelect: () => props.onDuplicate?.() },
            { key: "close", label: "Close", icon: <Icon name="close" />, disabled: !props.onClose, onSelect: () => props.onClose?.() },
          ]}
        />
      </div>

      {!connection && (
        <div className="vq-banner" role="status">
          <Icon name="alert" size={14} />
          <p>This Visual Query's Connection was removed.</p>
          {choices.length > 0 ? (
            <>
              <Select
                label="Connection"
                value={picked}
                options={choices.map((c) => ({ value: c.id as string, label: c.name }))}
                onChange={setPick}
              />
              <button
                type="button"
                className="button button-small"
                disabled={!picked}
                onClick={() => {
                  reboundTo.current = picked;
                  latest.current = { ...latest.current, connectionId: picked };
                  onChange(latest.current);
                  // The missing check runs there once its schema loads.
                  props.onOpenConnection(picked);
                }}
              >
                Open here
              </button>
            </>
          ) : (
            <span className="muted">Add a {DIALECT_LABEL[dialect]} Connection to open it.</span>
          )}
        </div>
      )}

      {connection && !open && (
        <div className="vq-banner" role="status">
          <Icon name="alert" size={14} />
          <p>{connection.name} is not open</p>
          <button type="button" className="button button-small" onClick={() => props.onOpenConnection()}>
            Open {connection.name}
          </button>
        </div>
      )}

      <div
        className={`vq-canvas${wash}${dragging ? " vq-joining" : ""}${!connection || !open ? " vq-canvas-closed" : ""}`}
        data-part="canvas"
        ref={canvasBox}
        onMouseDownCapture={onCanvasDown}
        // A wheel pans or zooms the canvas, which would leave an open popover away from its badge.
        onWheelCapture={() => {
          setOpenJoin(null);
          setOpenPick(null);
        }}
      >
        <CardActionsContext.Provider value={actions}>
          <DropTargetContext.Provider value={dropTarget}>
            <JoinActionsContext.Provider value={joinActions}>
              <DiagramCanvas
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                connectionMode="loose"
                onDragOver={setDrag}
                onDragCancel={() => setDrag(null)}
                onConnectPorts={(from, to, shift) =>
                  changeModel((q) => connectColumns(q, { table: from.node, column: from.port }, { table: to.node, column: to.port }, shift))
                }
                onMove={(id, x, y) => changeModel((q) => moveTable(q, id, { x, y }))}
                // The canvas reports the selection on every draw; an equal one keeps the state, so nothing loops.
                onSelect={(ids) => setSelected((prev) => (prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids))}
                onDropObject={onDropObject}
                onInit={(i) => {
                  flow.current = i;
                }}
              >
                {empty ? (
                  <div className="vq-empty nodrag nopan">
                    <h2 className="vq-empty-title">Add tables to start</h2>
                    <p className="vq-empty-text">Drag tables from the tree onto the canvas, or find one here. Joins fill in from Foreign Keys.</p>
                    <Finder
                      inline
                      tables={finderTables}
                      home={tabDb}
                      inputRef={inlineInput}
                      loadingNote={loadingNote}
                      onAdd={(t) => {
                        addCard(t);
                        // The empty state (and its finder) goes: the canvas keeps the keys.
                        focusCanvas();
                      }}
                      onClose={() => {}}
                    />
                  </div>
                ) : (
                  <p className="vq-hint">
                    <span>Drag a column onto another to join them.</span>
                    <span>
                      <Kbd keys="Shift" /> adds a condition
                    </span>
                    <span>
                      <Kbd keys="Space" /> tick the column
                    </span>
                  </p>
                )}
              </DiagramCanvas>
            </JoinActionsContext.Provider>
          </DropTargetContext.Provider>
        </CardActionsContext.Provider>
        {finderOpen && visible && !empty && (
          <Finder
            tables={finderTables}
            home={tabDb}
            anchor={canvasBox.current?.getBoundingClientRect() ?? null}
            inputRef={floatingInput}
            loadingNote={loadingNote}
            onAdd={(t) => addCard(t)}
            onClose={closeFinder}
          />
        )}
        {diagramOpen && diagramSql.current !== null && (
          <QueryDiagramPane
            source={{ kind: "visual", docId: `vq:${doc.id}`, text: diagramSql.current }}
            dialect={dialect}
            schemaKey={cid && tabDb ? schemaKey(cid, tabDb) : null}
            schemaState={diagramLoad === "loaded" ? "loaded" : diagramLoad === "loading" ? "loading" : "none"}
            lang={lang}
            schemas={cid && open ? { cache: lang.schemas, connectionId: cid, database: tabDb } : null}
            visible={visible}
            // The SQL pane bands what the selected Visual Query card wrote.
            onBand={() => {}}
            onSelectTable={(alias) => {
              const t = model.tables.find((x) => x.alias === alias);
              if (t) selectCard(t.id);
            }}
            onClose={() => {
              setDiagramOpen(false);
              focusCanvas();
            }}
          />
        )}
      </div>

      <div className="vq-bottom">
        <section className={`vq-panel${wash}`} data-part="panel" aria-label="Query panel">
          <div className="vq-panel-head">
            <div className="vq-panel-tabs" role="tablist" aria-label="Query panel">
              {(
                [
                  ["columns", `Columns ${model.columns.length}`],
                  ["filter", `Filter and sort ${model.filters.length + model.orderBy.length}`],
                  ["results", "Results"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`${doc.id}-panel-${key}`}
                  aria-selected={panel === key}
                  aria-controls={`${doc.id}-panel-${key}-body`}
                  className={panel === key ? "vq-panel-tab vq-panel-tab-on" : "vq-panel-tab"}
                  onClick={() => setPanel(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {changed && (
              <span className="vq-changed vq-panel-changed">
                <Icon name="alert" size={14} />
                Changed since the last run
              </span>
            )}
          </div>
          <div className="vq-panel-body" role="tabpanel" id={`${doc.id}-panel-${panel}-body`} aria-labelledby={`${doc.id}-panel-${panel}`}>
            {panel === "columns" && (
              <ColumnsPanel model={model} outputs={outputs} problems={problems} tableColumns={tableColumns} onChange={changeModel} />
            )}
            {panel === "filter" && (
              <FilterPanel
                model={model}
                outputs={outputs}
                problems={problems}
                tableColumns={tableColumns}
                onChange={changeModel}
                limitDraft={limitDraft}
                onLimitDraft={setLimitDraft}
              />
            )}
            {panel === "results" &&
              (sessionError ? (
                <div className="result-state result-state-error" role="alert">
                  <h3>
                    <Icon name="error" />
                    {sessionError}
                  </h3>
                  <div className="result-actions">
                    <button type="button" className="button" onClick={() => setSessionEpoch((n) => n + 1)}>
                      Try again
                    </button>
                  </div>
                </div>
              ) : (
                <ResultsPanel
                  state={runner}
                  // The panel already carries the Production wash.
                  production={false}
                  timeoutSecs={connection?.queryTimeoutSecs ?? null}
                  // The run's error position, read from the server's message against the SQL that ran.
                  lineAt={() => errorMark?.line ?? 1}
                  columnAt={() => errorMark?.column ?? 1}
                  dialect={dialect}
                  connectionName={connection?.name}
                  onSelect={(index) => dispatch({ type: "select", index })}
                  onPin={(id) => dispatch({ type: "pin", id })}
                  onClose={(id) => {
                    const it = runner.items.find((i) => i.id === id);
                    if (it?.state.s === "rows" && it.state.open && session) void closeQueryResult(session).catch(() => {});
                    dispatch({ type: "closeItem", id });
                  }}
                  onCloseUnpinned={() => {
                    // An open result keeps rows, and on SQLite a read lock, on the server.
                    const held = runner.items.some((i) => !i.pinned && i.state.s === "rows" && i.state.open);
                    if (held && session) void closeQueryResult(session).catch(() => {});
                    dispatch({ type: "closeUnpinned" });
                  }}
                  onFetchMore={(id) => void fetchMore(id)}
                  onCancel={cancelRun}
                  onRunAgain={requestRun}
                  onReconnect={() => void reconnect()}
                  // The line the error box names: the error's, else line 1, as `lineAt` says.
                  onGoTo={() => onLine(errorMark?.line ?? 1)}
                  errorAction={
                    mark?.join && markJoin ? (
                      <button type="button" className="button" onClick={showErrorJoin}>
                        <Icon name="link" size={14} />
                        Show the Join
                      </button>
                    ) : undefined
                  }
                />
              ))}
          </div>
        </section>
        <SqlPane
          dialect={dialect}
          preview={empty ? null : preview}
          production={production}
          bands={bands}
          warnings={warningLines(preview, model)}
          empty={emptyLines}
          onCopy={copy}
          onOpenInEditor={openInEditor}
          onLine={onLine}
        />
      </div>

      {statusSlot ? createPortal(status, statusSlot) : <div className="vq-status-line">{status}</div>}

      {popJoin && openJoin && (
        <JoinPopover
          join={popJoin}
          left={tableOf(popJoin.left)?.name ?? ""}
          right={tableOf(popJoin.right)?.name ?? ""}
          leftAlias={tableOf(popJoin.left)?.alias}
          rightAlias={tableOf(popJoin.right)?.alias}
          dialect={dialect}
          anchor={openJoin.anchor}
          avoid={cardRects(popJoin)}
          problem={joinProblem(popJoin.id)}
          returnFocus={focusAfter(popJoin.id)}
          onKind={(k) => onJoin((q, id) => setJoinKind(q, id, k))}
          onRemoveCondition={(i) => onJoin((q, id) => removeCondition(q, id, i))}
          onSwap={() => onJoin((q, id) => swapSides(q, id))}
          onRemove={() => {
            onJoin((q, id) => removeJoin(q, id));
            closeJoin();
          }}
          onClose={closeJoin}
        />
      )}

      {pickJoin && openPick && (
        <PickPopover
          left={tableOf(pickJoin.left)?.name ?? ""}
          right={tableOf(pickJoin.right)?.name ?? ""}
          choices={pickChoices}
          alias2={aliasFor(tableOf(pickJoin.right)?.name ?? "", new Set(model.tables.map((t) => t.alias)))}
          anchor={openPick.anchor}
          avoid={cardRects(pickJoin)}
          problem={joinProblem(pickJoin.id)}
          returnFocus={focusAfter(pickJoin.id)}
          onPick={(choice) => {
            const id = pickJoin.id;
            setOpenPick(null);
            changeModel((q) => pickForeignKey(q, id, choice, schemaRef.current));
          }}
          onClose={() => setOpenPick(null)}
        />
      )}

      {dropPlan &&
        chipAt &&
        createPortal(
          <div className={dropPlan.types ? "vq-drop-chip vq-drop-chip-warn" : "vq-drop-chip"} style={{ left: chipAt.left, top: chipAt.top }} role="status">
            <span className="vq-drop-chip-text">{dropPlan.text}</span>
            {dropPlan.condition && <span className="vq-drop-chip-condition">{dropPlan.condition}</span>}
            {dropPlan.types && <span className="vq-drop-chip-types">{dropPlan.types}</span>}
          </div>,
          document.body,
        )}

      {jMenu &&
        createPortal(
          <div className="tree-menu vq-join-menu" style={{ left: jMenu.at.x, top: jMenu.at.y }}>
            <MenuList
              label={`Join ${tableOf(jMenu.table)?.alias ?? ""}.${jMenu.column} to`}
              compact
              onClose={closeJMenu}
              items={
                candidates.length > 0
                  ? candidates.map((c) => ({
                      key: `${c.table}.${c.column}`,
                      label: `${tableOf(c.table)?.alias ?? ""}.${c.column}`,
                      hint: types[c.table]?.[c.column],
                      onSelect: () => {
                        const from = { table: jMenu.table, column: jMenu.column };
                        changeModel((q) => connectColumns(q, from, c, false));
                      },
                    }))
                  : [{ key: "none", label: "No other card has columns to join to", disabled: true }]
              }
            />
          </div>,
          document.body,
        )}

      {crossAsk && (
        <CrossJoinDialog
          tables={crossGroups(model).map((g) => {
            // D17: the tree's estimates. V7: a group joined among itself is counted by its largest table, always "about".
            let counted: { name: string; rows: number } | null = null;
            for (const id of g) {
              const t = tableOf(id);
              const rows = t ? rowEstimate(objectPathOf(dialect, tabDb, t)) : null;
              if (t && rows !== null && (counted === null || rows > counted.rows)) counted = { name: t.name, rows };
            }
            const first = tableOf(g[0])?.name ?? g[0];
            return { name: first, rows: counted?.rows ?? null, estimated: true, ...(counted && counted.name !== first && { counted: counted.name }) };
          })}
          root={(() => {
            const r = model.tables[0];
            return { name: r?.name ?? "", rows: r ? rowEstimate(objectPathOf(dialect, tabDb, r)) : null, estimated: true };
          })()}
          onAddJoin={addJoinInstead}
          onCancel={() => setCrossAsk(null)}
          onRun={() => {
            askedCross.current.add(crossAsk.key);
            setCrossAsk(null);
            void startRun();
          }}
        />
      )}

      {renaming !== null && (
        <Dialog title="Rename Visual Query" size="form" onClose={closeRename}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void rename(renaming);
            }}
          >
            <div className="dialog-body">
              <div className="field">
                <label htmlFor={`${doc.id}-rename`}>Name</label>
                <input
                  id={`${doc.id}-rename`}
                  className={renameError ? "input input-error" : "input"}
                  aria-invalid={renameError ? true : undefined}
                  value={renaming}
                  autoFocus
                  autoComplete="off"
                  onChange={(e) => {
                    setRenaming(e.target.value);
                    setRenameError(null);
                  }}
                />
                {renameError && (
                  <p className="field-error" role="alert">
                    <Icon name="alert" size={14} />
                    {renameError}
                  </p>
                )}
              </div>
            </div>
            <footer className="dialog-footer">
              <span className="spacer" />
              <button type="button" className="button" onClick={closeRename}>
                Cancel
              </button>
              <button type="submit" className="button button-primary">
                Rename
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {naming && (
        <SaveDialog
          initial={doc.name === NEW_VISUAL_NAME ? "" : doc.name}
          existing={(props.savedQueries ?? []).filter((x) => x.id !== doc.savedId).map((x) => x.name)}
          sqlNames={(props.savedQueries ?? []).filter((x) => x.id !== doc.savedId && x.kind !== "visual").map((x) => x.name)}
          onCancel={() => setNaming(false)}
          onSave={(name) => {
            setNaming(false);
            void saveAs(name);
          }}
        />
      )}
    </div>
  );
}
