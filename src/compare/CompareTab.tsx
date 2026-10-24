import { framedScript } from "../api/scriptFrame";
import { save } from "@tauri-apps/plugin-dialog";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, fileName, isCommandError, listDatabases, listSchemas, openConnection, writeTextFile } from "../api/client";
import { applySync, compareDdl, compareSchemas, confirmSync, planSync } from "../api/compare";
import { newJobId } from "../api/jobs";
import type {
  AskDiffLine,
  CompareDatabase,
  CompareRequest,
  CompareResult,
  ConnectionConfig,
  DdlPair,
  DialectKind,
  DiffItem,
  Group,
  ItemId,
  JobId,
  ObjectPath,
  PassId,
  SyncPlan,
} from "../api/types";
import { type TabAskFields, usePublishTabAsk } from "../assistant/tabAsk";
import { type RecentStepInput, useRecordStep } from "../assistant/recentSteps";
import { alsoOf } from "../assistant/context";
import DbMark from "../components/DbMark";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import Segmented from "../components/Segmented";
import Select, { type SelectOption } from "../components/Select";
import SqlBlock, { type SqlMark } from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";
import { useJobs } from "../jobs/useJobs";
import ConfirmRun from "../query/ConfirmRun";
import type { CompareSeed } from "../shell/tabs";
import {
  MODEL_ONLY_SOURCE,
  NOTHING_TO_APPLY,
  READ_ONLY_TARGET,
  SAME_SIDE,
  type DiffFilter,
  buildTree,
  comparedAgo,
  compareTitle,
  confirmLossSentence,
  confirmModeNote,
  dialectRefusal,
  dropsDataCount,
  filterCounts,
  firstSelectable,
  footerLine,
  lossBanner,
  lossChip,
  matchText,
  notComparedTotal,
  notComparedSentence,
  num,
  progressText,
  readOnlyApply,
  scriptText,
  tickRefusal,
  toggleTick,
  treeFootText,
} from "./compareModel";
import DdlPanes from "./DdlPanes";
import DiffTree, { MarkIcon } from "./DiffTree";
import SyncList, { ScriptPane } from "./SyncList";

/** Ticks wait this long before the Core plans the script again. */
export const REPLAN_DEBOUNCE_MS = 150;

type ModelSource = Extract<CompareSeed["source"], { kind: "model" }>;

/** One item as the Ask gets it: names and types only, never the detail text, which can carry a value. */
function diffLine(i: DiffItem): AskDiffLine {
  const type = i.changes.find((c) => c.kind === "type");
  return {
    kind: i.kind,
    object: i.object,
    table: i.path.table ?? i.path.name,
    name: i.path.name,
    fromType: type?.kind === "type" ? type.from : null,
    toType: type?.kind === "type" ? type.to : null,
    losesData: i.losesData,
    losesRows: i.dataLoss?.rows ?? null,
  };
}

/** The sync script the Ask gets: twice the Core's 16 KB cap at most, cut at a line end. */
const SCRIPT_MAX = 32 * 1024;

/**
 * What a Schema Compare tab tells the Ask (spec 4.6): both sides, the items in tree order (cut at twice the Core's
 * 300 lines), the counts and the ticked script. The Ask goes to the target; a database source, or a Schema Model
 * made from a Connection, is the other Connection, so every item goes at the lower access of the two.
 */
type CompareSource = { kind: "database"; side: CompareDatabase | null } | { kind: "model"; file: string; connectionId: string | null };

/** The Ask's place for a compare: the target; the source's Connection goes beside it. */
function compareSides(source: CompareSource, target: CompareDatabase | null): Required<Pick<TabAskFields, "also" | "where">> {
  return {
    also: source.kind === "database" ? (source.side ? [source.side.connectionId] : []) : source.connectionId ? [source.connectionId] : [],
    where: { connectionId: target?.connectionId ?? null, database: target?.database ?? null, schema: target?.schema ?? null },
  };
}

/**
 * A compare's Recent step: on the target, as the Ask is, naming the source database or model file. The source's
 * Connection goes with a compare when it is another, so the Core gives the source name at the lower access.
 */
export function compareStep(source: CompareSource, target: CompareDatabase | null, verb: "compared" | "syncApplied", count: number | null, failed = false): RecentStepInput {
  const { also, where } = compareSides(source, target);
  const other = verb === "compared" ? alsoOf(where.connectionId, also)[0] : undefined;
  const name = source.kind === "model" ? source.file : (source.side?.database ?? null);
  return {
    verb,
    tab: "compare",
    title: null,
    connectionId: where.connectionId,
    database: where.database,
    schema: where.schema,
    ...(verb === "compared" && name && { names: [name] }),
    count,
    ...(failed && { failed: true }),
    ...(other !== undefined && { sourceConnectionId: other }),
  };
}

export function compareTabAsk(p: {
  source: CompareSource;
  target: CompareDatabase | null;
  items: DiffItem[];
  notCompared: number;
  ticked: number;
  script: string | null;
  /** A result is in; until then no counts or items are claimed. */
  compared?: boolean;
}): TabAskFields {
  const count = (k: DiffItem["kind"]) => p.items.filter((i) => i.kind === k).length;
  const script = p.script && p.script.length > SCRIPT_MAX ? p.script.slice(0, Math.max(0, p.script.lastIndexOf("\n", SCRIPT_MAX))) : p.script;
  return {
    tab: {
      kind: "compare",
      source: p.source.kind === "model" ? { kind: "model", file: p.source.file } : { kind: "database", database: p.source.side?.database ?? "" },
      targetDatabase: p.target?.database ?? "",
      items: p.items.slice(0, 600).map(diffLine),
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      notCompared: p.notCompared,
      ticked: p.ticked,
      compared: p.compared ?? true,
    },
    sql: script || undefined,
    ...compareSides(p.source, p.target),
  };
}

export interface CompareTabProps {
  seed: CompareSeed;
  /** The tab's key: the tab publishes what the Ask may know of it (`tabAsk.ts`). */
  askKey?: string | null;
  /** Every Connection, across Groups: a compare may span two. */
  connections: ConnectionConfig[];
  groups: Group[];
  /** Whether the tab is on top; "Compared 12s ago" only ticks while it is. */
  visible: boolean;
  /** The tab's title ("freight-staging to freight-prod") and its target, for the PROD chip. */
  onMeta(title: string, connectionId: string | null): void;
  /** Open in editor: a new query tab on the target with the script. */
  onOpenInEditor?(target: CompareDatabase, sql: string): void;
  /**
   * Apply changed the target: its tree, the completion schemas and the open tabs of `tables` load
   * again; the tabs of `dropped` tables close.
   */
  onApplied?(target: CompareDatabase, tables: ObjectPath[], dropped: ObjectPath[]): void;
  /** The Apply job while it runs, so closing the tab can ask first; null once it ended. */
  onJob?(id: JobId | null): void;
}

interface Run {
  id: JobId;
  total: number;
  done: number;
}

/** PostgreSQL compares a schema, so a side is complete with a database and, there, a schema. */
function complete(side: CompareDatabase | null, connections: ConnectionConfig[]): side is CompareDatabase {
  if (!side?.database) return false;
  const c = connections.find((x) => x.id === side.connectionId);
  return !!c && (c.dialect !== "postgres" || !!side.schema);
}

function sideFor(c: ConnectionConfig): CompareDatabase {
  return { connectionId: c.id, database: c.dialect === "sqlite" ? "main" : c.database || "", schema: c.dialect === "postgres" ? "public" : null };
}

/** The databases of a Connection and, on PostgreSQL, the schemas of the chosen database. */
function useScopes(connection: ConnectionConfig | null, database: string) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const id = connection?.id ?? null;
  const pg = connection?.dialect === "postgres";
  const sqlite = connection?.dialect === "sqlite";
  useEffect(() => {
    setDatabases([]);
    if (!id || sqlite) return;
    let live = true;
    listDatabases(id).then(
      (list) => live && setDatabases(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, sqlite]);
  useEffect(() => {
    setSchemas([]);
    if (!id || !pg || !database) return;
    let live = true;
    listSchemas(id, database).then(
      (list) => live && setSchemas(list.filter((s) => !s.isSystem).map((s) => s.name)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, pg, database]);
  return { databases, schemas };
}

interface PickerProps {
  role: "Source" | "Target";
  connections: ConnectionConfig[];
  side: CompareDatabase | null;
  /** A model source: only Connections of its Dialect, and Read-only ones disabled. */
  onlyDialect: DialectKind | null;
  onChange(side: CompareDatabase): void;
}

/** Item 44: what a code pane names beside its Connection: the database, and the schema on PostgreSQL. SQLite names none. */
export function scopeOf(side: CompareDatabase | null, connection: ConnectionConfig | null): string[] | undefined {
  if (!side || !connection || connection.dialect === "sqlite" || !side.database) return undefined;
  return connection.dialect === "postgres" && side.schema ? [side.database, side.schema] : [side.database];
}

/** A side's Connection, database and (PostgreSQL) schema. */
function SidePicker({ role, connections, side, onlyDialect, onChange }: PickerProps) {
  const connection = connections.find((c) => c.id === side?.connectionId) ?? null;
  const { databases, schemas } = useScopes(connection, side?.database ?? "");
  const listed = (list: string[], current: string | null) => (current && !list.includes(current) ? [...list, current] : list);
  const shown = onlyDialect ? connections.filter((c) => c.dialect === onlyDialect) : connections;
  const options: SelectOption<string>[] = [
    { value: "", label: "Pick a Connection", disabled: true },
    ...shown.map((c) => ({
      value: c.id,
      label: c.name,
      lead: <DbMark dialect={c.dialect} open size={14} label={null} />,
      hint: onlyDialect && c.readOnly ? READ_ONLY_TARGET : c.production ? "Production" : undefined,
      disabled: !!onlyDialect && c.readOnly,
    })),
  ];
  return (
    <span className="compare-picker">
      <Select
        label={`${role} Connection`}
        value={side?.connectionId ?? ""}
        options={options}
        onChange={(id) => {
          const c = connections.find((x) => x.id === id);
          if (c) onChange(sideFor(c));
        }}
      />
      {connection && <SafetyTag connection={connection} small />}
      {connection && side && connection.dialect !== "sqlite" && (
        <Select
          label={`${role} database`}
          mono
          value={side.database}
          options={[{ value: "", label: "Database", disabled: true }, ...listed(databases, side.database || null).map((d) => ({ value: d, label: d }))]}
          onChange={(d) => onChange({ ...side, database: d, schema: connection.dialect === "postgres" ? "public" : null })}
        />
      )}
      {connection && side && connection.dialect === "postgres" && side.database && (
        <Select
          label={`${role} schema`}
          mono
          value={side.schema ?? ""}
          options={[{ value: "", label: "Schema", disabled: true }, ...listed(schemas, side.schema).map((s) => ({ value: s, label: s }))]}
          onChange={(s) => onChange({ ...side, schema: s })}
        />
      )}
    </span>
  );
}

/** The Schema Compare tab (frame 10.1): Differences and the Sync Script; Apply runs exactly the shown script. */
export default function CompareTab({ seed, askKey = null, connections, groups, visible, onMeta, onOpenInEditor, onApplied, onJob }: CompareTabProps) {
  const jobs = useJobs();
  const root = useRef<HTMLDivElement>(null);
  const model: ModelSource | null = seed.source.kind === "model" ? seed.source : null;
  const [kind, setKind] = useState<"database" | "model">(seed.source.kind);
  const [dbSource, setDbSource] = useState<CompareDatabase | null>(() => {
    const s = seed.source;
    return s.kind === "database" ? { connectionId: s.connectionId, database: s.database, schema: s.schema } : null;
  });
  const [target, setTarget] = useState<CompareDatabase | null>(seed.target);
  const [seq, setSeq] = useState(0);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "sync">("diff");
  const [filter, setFilter] = useState<DiffFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [ticked, setTicked] = useState<Set<ItemId>>(new Set());
  const [planPending, setPlanPending] = useState(false);
  const [syncSelected, setSyncSelected] = useState<ItemId | null>(null);
  const [ddl, setDdl] = useState<{ table: string; pair: DdlPair } | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const replanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Counts plan requests: only the latest one's answer is shown, so the ticks, the script and the
   * hash on screen always come from one Core response.
   */
  const planSeq = useRef(0);
  const planRef = useRef<SyncPlan | null>(null);
  planRef.current = plan;
  /** The request the shown result belongs to; another pair clears it at once. */
  const shownKey = useRef<string | null>(null);
  /** After Apply the next compare starts from the default ticks; Compare again keeps the user's. */
  const freshTicks = useRef(true);
  /** A changed plan on Production reopens the dialog once the new script is in. */
  const reopenConfirm = useRef(false);
  /**
   * The compare and default plan on their way, by request and Compare again count. StrictMode runs
   * the compare effect twice on mount; the second run takes the first one's answer, not a new read.
   */
  const inflight = useRef<{ key: string; compare: Promise<CompareResult>; plan: Promise<SyncPlan> } | null>(null);

  const srcConn = kind === "database" ? (connections.find((c) => c.id === dbSource?.connectionId) ?? null) : null;
  const tgtConn = connections.find((c) => c.id === target?.connectionId) ?? null;
  const modelName = model ? (model.path ? fileName(model.path) : "untitled.dbml") : "";
  const sourceLabel = kind === "model" ? modelName : (srcConn?.name ?? "");
  const sourceDialect = kind === "model" ? (model?.dialect ?? null) : (srcConn?.dialect ?? null);
  const targetLabel = tgtConn?.name ?? "";
  const production = tgtConn?.production ?? false;
  const dialect: DialectKind = tgtConn?.dialect ?? sourceDialect ?? "postgres";
  const dialectRef = useRef(dialect);
  dialectRef.current = dialect;

  const refusal = useMemo(() => {
    if (!tgtConn || !sourceDialect) return null;
    if (sourceDialect !== tgtConn.dialect) return dialectRefusal(sourceLabel, sourceDialect, tgtConn.name, tgtConn.dialect);
    if (kind === "database" && dbSource && target && complete(target, connections) && dbSource.connectionId === target.connectionId && dbSource.database === target.database && dbSource.schema === target.schema) {
      return SAME_SIDE;
    }
    return null;
  }, [tgtConn, sourceDialect, sourceLabel, kind, dbSource, target, connections]);

  const req: CompareRequest | null = useMemo(() => {
    if (refusal || !complete(target, connections)) return null;
    if (kind === "model") return model ? { source: { kind: "model", model: model.model, path: model.path }, target } : null;
    if (!complete(dbSource, connections)) return null;
    return { source: { kind: "database", ...dbSource }, target };
  }, [refusal, target, connections, kind, model, dbSource]);
  const reqKey = useMemo(() => (req ? JSON.stringify(req) : null), [req]);
  const reqRef = useRef(req);
  reqRef.current = req;

  const title = compareTitle(sourceLabel || "Schema Compare", targetLabel || null);
  useEffect(() => {
    onMeta(sourceLabel ? title : "Schema Compare", target?.connectionId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, sourceLabel, target?.connectionId]);

  // A compare from the Schema Builder starts with the Target picker.
  useEffect(() => {
    if (seed.source.kind === "model" && !seed.target) {
      root.current?.querySelector<HTMLElement>('[aria-label="Target Connection"]')?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible || !result) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible, result]);

  const items = result?.items ?? [];
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const scope = target ? (target.schema ?? target.database) : "";
  const ncTotal = result ? notComparedTotal(result.notCompared) : 0;
  const rows = useMemo(() => buildTree(items, filter, scope, ncTotal), [items, filter, scope, ncTotal]);
  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const selectedTable = selectedRow?.table ?? null;
  const recordStep = useRecordStep();
  const modelConnection = model?.connectionId ?? null;
  const stepSource = (): CompareSource => (kind === "model" ? { kind: "model", file: modelName, connectionId: modelConnection } : { kind: "database", side: dbSource });
  usePublishTabAsk(
    askKey,
    () =>
      compareTabAsk({
        source: stepSource(),
        target,
        items,
        notCompared: ncTotal,
        ticked: ticked.size,
        script: plan ? scriptText(plan.statements) : null,
        compared: result !== null,
      }),
    [kind, modelName, modelConnection, dbSource, target, items, ncTotal, ticked, plan, result],
  );

  function applyPlan(p: SyncPlan) {
    setPlan(p);
    setTicked(new Set(p.items.filter((i) => i.ticked).map((i) => i.id)));
    setPlanPending(false);
  }

  // Comparing runs on open, on any picker change and on Compare again.
  useEffect(() => {
    setError(null);
    // Any plan still on its way belongs to the compare before this one.
    if (replanTimer.current) clearTimeout(replanTimer.current);
    replanTimer.current = null;
    const my = ++planSeq.current;
    setPlanPending(false);
    // Another pair of sides: nothing of the old pair stays on screen while the new one is read.
    const otherPair = shownKey.current !== reqKey;
    shownKey.current = reqKey;
    if (otherPair) {
      setResult(null);
      setPlan(null);
      setTicked(new Set());
      setDdl(null);
    }
    if (!req) {
      setComparing(false);
      return;
    }
    let live = true;
    setComparing(true);
    const keep = freshTicks.current || otherPair ? null : ticked;
    const before = otherPair ? null : result;
    freshTicks.current = false;
    const key = `${reqKey}#${seq}`;
    let flight = inflight.current?.key === key ? inflight.current : null;
    if (!flight) {
      const compare = (async () => {
        await Promise.all([
          openConnection(req.target.connectionId).catch(() => null),
          req.source.kind === "database" ? openConnection(req.source.connectionId).catch(() => null) : null,
        ]);
        return compareSchemas(req);
      })();
      const plan = compare.then(() => planSync(req, null));
      const entry = { key, compare, plan };
      flight = entry;
      inflight.current = entry;
      const done = () => {
        if (inflight.current === entry) inflight.current = null;
      };
      plan.then(done, done);
    }
    const pending = flight;
    (async () => {
      try {
        const r = await pending.compare;
        if (!live) return;
        setResult(r);
        setNow(Date.now());
        recordStep(compareStep(stepSource(), target, "compared", r.items.length));
        let p = await pending.plan;
        // Compare again keeps the user's ticks on the items it had; new items take the default.
        if (keep && before) {
          const known = new Set(before.items.map((i) => i.id));
          const merged = p.items.filter((i) => (known.has(i.id) ? keep.has(i.id) : i.ticked)).map((i) => i.id);
          const defaults = p.items.filter((i) => i.ticked).map((i) => i.id);
          if (merged.join("\n") !== defaults.join("\n")) p = await planSync(req, merged);
        }
        if (!live || my !== planSeq.current) return;
        applyPlan(p);
        if (reopenConfirm.current) {
          reopenConfirm.current = false;
          if (p.statements.length > 0) setConfirming(true);
        }
      } catch (e) {
        if (live) setError(errorText(e, dialect));
      } finally {
        if (live) setComparing(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, seq]);

  // The selection survives a recompare by its stable id; else the first item.
  useEffect(() => {
    if (!result) return;
    if (selected === null || !rows.some((r) => r.id === selected)) setSelected(firstSelectable(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, result]);

  // The selected table's DDL, fetched per selection.
  useEffect(() => {
    setDdlError(null);
    if (!req || !selectedTable || !result) {
      setDdl(null);
      return;
    }
    let live = true;
    compareDdl(req, selectedTable).then(
      (pair) => live && setDdl({ table: selectedTable, pair }),
      (e) => live && setDdlError(errorText(e, dialect)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, selectedTable, result]);

  useEffect(() => () => {
    if (replanTimer.current) clearTimeout(replanTimer.current);
  }, []);

  const replan = useCallback((selection: Set<ItemId>, wait: number) => {
    if (replanTimer.current) clearTimeout(replanTimer.current);
    // Newer than every plan on its way: their answers are dropped.
    const my = ++planSeq.current;
    setPlanPending(true);
    const go = () => {
      replanTimer.current = null;
      const r = reqRef.current;
      if (!r || my !== planSeq.current) return;
      planSync(r, [...selection]).then(
        (p) => {
          if (my === planSeq.current) applyPlan(p);
        },
        (e) => {
          if (my !== planSeq.current) return;
          // The ticks go back to the last plan the Core built, so they match the script shown.
          setPlanPending(false);
          const last = planRef.current;
          if (last) setTicked(new Set(last.items.filter((i) => i.ticked).map((i) => i.id)));
          setError(errorText(e, dialectRef.current));
        },
      );
    };
    if (wait > 0) replanTimer.current = setTimeout(go, wait);
    else go();
  }, []);

  function toggle(id: ItemId, on: boolean, wait = REPLAN_DEBOUNCE_MS) {
    if (!plan || run || comparing) return;
    // A tick that would need an item Contura cannot script is refused, naming both.
    const refused = on ? tickRefusal(plan.items, id) : null;
    if (refused) {
      setNotice(refused);
      return;
    }
    const next = toggleTick(plan.items, ticked, id, on);
    setTicked(next);
    replan(next, wait);
  }

  function compareAgain() {
    if (run) return;
    setNotice(null);
    setSeq((s) => s + 1);
  }

  const canSwap = kind === "database" && !!dbSource && !!target && !run;
  function swap() {
    if (!canSwap) return;
    setDbSource(target);
    setTarget(dbSource);
  }

  /** The target tables the ticked items touch, for refreshing after a failed or partial run. */
  function touchedTables(p: SyncPlan): ObjectPath[] {
    if (!target) return [];
    const names = new Set(p.items.filter((i) => i.ticked && i.table && i.object !== "enum").map((i) => i.table!));
    return [...names].map((name) => ({ database: target.database, schema: target.schema, name }));
  }

  /** The tables a plan drops: their open tabs close after Apply instead of loading again. */
  function droppedTables(p: SyncPlan): ObjectPath[] {
    if (!target) return [];
    return p.items
      .filter((i) => i.ticked && i.object === "table" && i.kind === "removed" && i.table)
      .map((i) => ({ database: target.database, schema: target.schema, name: i.table! }));
  }

  /** The items in the plan on screen: Apply and the Production pass use exactly these. */
  const shownSelection = (p: SyncPlan) => p.items.filter((i) => i.ticked).map((i) => i.id);

  const nothing = !plan || plan.statements.length === 0;
  const whyNot: string | null = !tgtConn
    ? null
    : tgtConn.readOnly
      ? readOnlyApply(tgtConn.name)
      : result && items.length === 0
        ? NOTHING_TO_APPLY
        : plan?.mode.kind === "copyOnly"
          ? plan.mode.reason
          : plan && nothing
            ? NOTHING_TO_APPLY
            : null;
  const canApply = !!req && !!plan && !planPending && !comparing && !run && whyNot === null;

  async function applyNow(pass: PassId | null) {
    if (!req || !plan || !tgtConn || !target) return;
    const p = plan;
    const selection = shownSelection(p);
    const id = newJobId();
    const track = jobs.track(id, "sync", `Applying the Sync Script on ${tgtConn.name}`, tgtConn.id);
    let ended = false;
    setRun({ id, total: p.statements.length, done: 0 });
    onJob?.(id);
    setRunError(null);
    setNotice(null);
    try {
      const out = await applySync(id, req, selection, pass, p.hash, (e) => {
        track(e);
        if (e.kind === "finished" || e.kind === "failed") ended = true;
        if (e.kind === "progress") setRun((r) => (r && r.id === id ? { ...r, done: e.statementsDone } : r));
      });
      recordStep(compareStep(stepSource(), target, "syncApplied", ticked.size));
      const dropped = droppedTables(p);
      const gone = new Set(dropped.map((d) => d.name));
      onApplied?.(
        target,
        out.tables.filter((t) => !gone.has(t.name)),
        dropped,
      );
      freshTicks.current = true;
    } catch (e) {
      // A refused start sends no final event: the job goes here.
      if (!ended) jobs.dismiss(id);
      if (isCommandError(e) && e.kind === "needsConfirmation") {
        setRun(null);
        setConfirming(true);
        return;
      }
      setRunError(errorText(e, tgtConn.dialect));
      if (isCommandError(e) && e.kind === "planChanged") {
        // The dialog reopens on Production with the current SQL.
        reopenConfirm.current = production;
      } else if (!(isCommandError(e) && e.kind === "readOnly")) {
        // A failed or cancelled run may have changed the target (MySQL keeps what ran).
        recordStep(compareStep(stepSource(), target, "syncApplied", ticked.size, true));
        onApplied?.(target, touchedTables(p), []);
        freshTicks.current = true;
      }
    } finally {
      setRun(null);
      onJob?.(null);
    }
    setSeq((s) => s + 1);
  }

  function onApply() {
    if (!canApply) return;
    if (production) setConfirming(true);
    else void applyNow(null);
  }

  async function onConfirmed() {
    if (!req || !plan || planPending) return;
    setConfirming(false);
    try {
      // The pass covers exactly the selection of the SQL the dialog shows.
      await applyNow(await confirmSync(req, shownSelection(plan)));
    } catch (e) {
      setRunError(errorText(e, tgtConn?.dialect));
    }
  }

  // I1: what leaves Contura carries the plan's frame (MySQL's sql_mode); the view shows what Apply runs.
  const script = plan ? framedScript(plan.frame, scriptText(plan.statements)) : "";
  const copyScript = () => void navigator.clipboard?.writeText(script);

  async function saveScript() {
    if (!plan || !target) return;
    try {
      const path = await save({ filters: [{ name: "SQL script", extensions: ["sql"] }], defaultPath: `${target.schema ?? target.database}-sync.sql` });
      if (!path) return;
      await writeTextFile(path, script);
      setStatus(`Saved ${fileName(path)}`);
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // A portalled dialog's keys bubble here through React: only the tab's own keys count.
    if (confirming || !root.current?.contains(e.target as Node)) return;
    if (e.key === "F5") {
      e.preventDefault();
      compareAgain();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      swap();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onApply();
    }
  }

  const counts = filterCounts(items);
  const tickedCount = plan ? plan.items.filter((i) => ticked.has(i.id)).length : 0;
  const nameOf = useCallback((id: ItemId) => itemById.get(id)?.path.name ?? id, [itemById]);

  // ---- the Differences pane on the right ----
  const tableItems: DiffItem[] = selectedTable ? items.filter((i) => (i.path.table ?? i.path.name) === selectedTable) : [];
  const lossItems = tableItems.filter((i) => i.losesData);
  const lossItem = selectedRow?.item?.losesData ? selectedRow.item : (lossItems[0] ?? null);
  const qualified = selectedTable ? (target?.schema ? `${target.schema}.${selectedTable}` : selectedTable) : "";
  const focus = selectedRow?.kind === "item" && selectedRow.item?.object !== "enum" ? selectedRow.name : null;
  // Item 43: the shown table's status beside its name, in its colour ("Added", "Changed, 16 changes").
  const tableRow = selectedTable ? rows.find((r) => r.table === selectedTable && r.level === 2) : undefined;
  const statusWord = tableRow?.mark
    ? `${tableRow.mark.charAt(0).toUpperCase()}${tableRow.mark.slice(1)}${tableRow.changes !== null ? `, ${tableRow.changes === 1 ? "1 change" : `${tableRow.changes.toLocaleString("en-US")} changes`}` : ""}`
    : null;

  function inScript(): { sql: string; marks: SqlMark[]; on: number; n: number } {
    const its = plan ? plan.items.filter((i) => i.table === selectedTable) : [];
    const lines: string[] = [];
    const marks: SqlMark[] = [];
    const seen = new Set<number>();
    for (const it of its) {
      if (!ticked.has(it.id)) {
        lines.push(`-- Unticked: ${it.line}`);
        continue;
      }
      plan!.statements.forEach((st, i) => {
        if (!st.items.includes(it.id) || seen.has(i)) return;
        seen.add(i);
        const from = lines.length + 1;
        // Each statement ends with `;`, as in the Sync Script.
        lines.push(...`${st.sql.replace(/\r\n/g, "\n").trimEnd()};`.split("\n"));
        if (production && st.writes) marks.push({ firstLine: from, lastLine: lines.length, band: "prod" });
      });
    }
    return { sql: lines.join("\n"), marks, on: its.filter((i) => ticked.has(i.id)).length, n: its.length };
  }

  const sourceSide = {
    name: sourceLabel,
    scope: kind === "database" ? scopeOf(dbSource, srcConn) : undefined,
    lead: kind === "model" ? <Icon name="layers" size={14} /> : srcConn ? <DbMark dialect={srcConn.dialect} open size={14} label={null} /> : undefined,
  };
  const targetSide = {
    name: targetLabel,
    scope: scopeOf(target, tgtConn),
    lead: tgtConn ? <DbMark dialect={tgtConn.dialect} open size={14} label={null} /> : undefined,
    tag: tgtConn ? <SafetyTag connection={tgtConn} small /> : undefined,
  };

  // ---- the Production dialog ----
  const dropping = plan ? plan.statements.flatMap((s, i) => (s.dropsData ? [i] : [])) : [];
  const lossTicked = plan ? plan.items.filter((i) => i.losesData && ticked.has(i.id)) : [];

  const body = (() => {
    if (!result) {
      return <p className="compare-state muted">{comparing ? "Reading both sides..." : req ? null : "Pick the source and the target to compare."}</p>;
    }
    if (items.length === 0) {
      const hint = notComparedSentence(result.notCompared, result.summary.notComparedLine);
      return (
        <div className="compare-empty">
          <span className="compare-empty-icon">
            <Icon name="check" size={20} />
          </span>
          <h3 className="compare-empty-title">No differences</h3>
          <p>{matchText(scope, sourceLabel, targetLabel, result.summary)}</p>
          {hint && <p className="compare-empty-hint">{hint}</p>}
          <button type="button" className="button" onClick={compareAgain}>
            <Icon name="refresh" size={14} />
            Compare again <Kbd keys="F5" />
          </button>
        </div>
      );
    }
    if (view === "diff") {
      const block = inScript();
      return (
        <div className="compare-split">
          <aside className="compare-left compare-left-diff">
            <div className="compare-filter">
              <div className="compare-chips" role="group" aria-label="Show">
                {(["all", "added", "removed", "changed"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    className={["compare-chip", `compare-chip-${f}`, filter === f && "compare-chip-on"].filter(Boolean).join(" ")}
                    onClick={() => setFilter(f)}
                  >
                    {f !== "all" && <span className="compare-chip-dot" aria-hidden="true" />}
                    {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}{" "}
                    <span className={f === "all" ? "compare-chip-n" : `compare-chip-n diff-${f}`}>{counts[f].toLocaleString("en-US")}</span>
                  </button>
                ))}
              </div>
            </div>
            <DiffTree rows={rows} collapsed={collapsed} onCollapsed={setCollapsed} selected={selected} onSelect={setSelected} />
            <p className="compare-foot-hint">{treeFootText(result.notCompared, result.summary.notComparedLine)}</p>
          </aside>
          <section className="compare-right" aria-label="Definitions">
            <div className="compare-right-head">
              <span className="compare-right-title mono">{qualified}</span>
              {tableRow?.mark && statusWord && (
                <span className={`compare-status-word diff-${tableRow.mark}`}>
                  <MarkIcon mark={tableRow.mark} />
                  {statusWord}
                </span>
              )}
              {lossItems.length > 0 && (
                <span className="chip compare-chip-bad">
                  <Icon name="warning" size={14} />
                  {lossChip(lossItems.length)}
                </span>
              )}
              <span className="spacer" />
              <span className="compare-legend" aria-label="Legend">
                <span className="diff-added">
                  <MarkIcon mark="added" />
                  in source only
                </span>
                <span className="diff-removed">
                  <MarkIcon mark="removed" />
                  in target only
                </span>
                <span className="diff-changed">
                  <MarkIcon mark="changed" />
                  differs
                </span>
              </span>
            </div>
            <DdlPanes
              pair={ddl && ddl.table === selectedTable ? ddl.pair : null}
              loading={!!selectedTable}
              error={ddlError}
              dialect={dialect}
              source={sourceSide}
              target={targetSide}
              production={production}
              focus={focus}
            />
            {lossItem && (
              <div className="compare-loss" role="note">
                <Icon name="warning" size={14} />
                <span>{lossBanner({ kind: lossItem.kind, object: lossItem.object, name: lossItem.path.name }, lossItem.dataLoss, targetLabel)}</span>
              </div>
            )}
            {plan && block.n > 0 && (
              <div className="compare-inscript">
                <div className="compare-inscript-head">
                  <strong>In the Sync Script</strong>
                  <span className="muted">{`${num(block.on)} of ${num(block.n)} ticked`}</span>
                  <span className="spacer" />
                  <button type="button" className="button button-small button-quiet" onClick={() => setView("sync")}>
                    Open Sync Script
                    <Icon name="chevronRight" size={14} />
                  </button>
                </div>
                <SqlBlock sql={block.sql} dialect={dialect} marks={block.marks} ariaLabel="This table in the Sync Script" />
              </div>
            )}
          </section>
        </div>
      );
    }
    return (
      <div className="compare-split">
        <aside className="compare-left compare-left-sync">
          {plan && (
            <SyncList
              items={plan.items}
              ticked={ticked}
              nameOf={nameOf}
              selected={syncSelected}
              onSelect={setSyncSelected}
              onToggle={(id, on) => toggle(id, on)}
            />
          )}
        </aside>
        {plan && (
          <ScriptPane
            plan={plan}
            dialect={dialect}
            target={targetLabel}
            production={production}
            onCopy={copyScript}
            onSave={() => void saveScript()}
            onOpenInEditor={() => target && onOpenInEditor?.(target, script)}
          />
        )}
      </div>
    );
  })();

  return (
    <div ref={root} className="compare-tab" onKeyDown={onKeyDown}>
      <header className="compare-head">
        <span className="compare-lbl">Source</span>
        <Segmented
          label="Source kind"
          value={kind}
          options={[
            { value: "database", label: "Database" },
            { value: "model", label: "Schema Model", disabled: !model },
          ]}
          onChange={(k) => {
            if (k === "model" && !model) return;
            setKind(k);
          }}
        />
        {kind === "database" ? (
          <SidePicker role="Source" connections={connections} side={dbSource} onlyDialect={null} onChange={setDbSource} />
        ) : (
          <span className="compare-model" title={model?.path ?? undefined}>
            <Icon name="layers" size={14} />
            <span className="mono">{modelName}</span>
          </span>
        )}
        <button
          type="button"
          className="icon-button compare-swap"
          aria-label="Swap sides"
          title={kind === "model" ? MODEL_ONLY_SOURCE : "Swap sides  Ctrl+Shift+S"}
          disabled={!canSwap}
          onClick={swap}
        >
          <Icon name="swap" size={16} />
        </button>
        <span className="compare-lbl">Target</span>
        <SidePicker
          role="Target"
          connections={connections}
          side={target}
          onlyDialect={kind === "model" ? (model?.dialect ?? null) : null}
          onChange={setTarget}
        />
        <span className="spacer" />
        {result && <span className="compare-ago">{comparedAgo(result.comparedAtMs, now)}</span>}
        <button type="button" className="button" disabled={!req || comparing || !!run} onClick={compareAgain}>
          <Icon name="refresh" size={14} />
          Compare again <Kbd keys="F5" />
        </button>
      </header>
      {kind === "model" && model?.notice && (
        <div className="compare-ban compare-ban-info" role="status">
          <Icon name="info" size={14} />
          <span>{model.notice}</span>
        </div>
      )}
      {refusal && (
        <div className="compare-ban compare-ban-bad" role="alert">
          <Icon name="error" size={14} />
          <span>{refusal}</span>
        </div>
      )}
      {(error || runError) && (
        <div className="compare-ban compare-ban-bad" role="alert">
          <Icon name="error" size={14} />
          <span>{runError ?? error}</span>
        </div>
      )}
      {notice && (
        <div className="compare-ban compare-ban-info" role="status">
          <Icon name="info" size={14} />
          <span>{notice}</span>
        </div>
      )}
      <div className="compare-strip">
        <div role="tablist" aria-label="Compare views" className="compare-tabs">
          <button type="button" role="tab" aria-selected={view === "diff"} className={view === "diff" ? "compare-itab compare-itab-on" : "compare-itab"} onClick={() => setView("diff")}>
            Differences <span className="compare-itab-n">{result ? items.length.toLocaleString("en-US") : ""}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === "sync"} className={view === "sync" ? "compare-itab compare-itab-on" : "compare-itab"} onClick={() => setView("sync")}>
            Sync Script <span className="compare-itab-n">{plan ? `${num(tickedCount)} of ${num(plan.items.length)}` : ""}</span>
          </button>
        </div>
        {sourceLabel && targetLabel && (
          <>
            <span className="compare-vdiv" aria-hidden="true" />
            <span className="compare-strip-note">
              Changes {targetLabel} to match {sourceLabel}.
            </span>
          </>
        )}
      </div>
      <div className="compare-body">{body}</div>
      <footer className="compare-foot">
        {run ? (
          <>
            <span className="compare-foot-line" role="status">
              {progressText(run.done, run.total)}
            </span>
            <span className="spacer" />
            <button type="button" className="button" onClick={() => void jobs.cancel(run.id)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {status && (
              <span className="compare-foot-line" role="status">
                {status}
              </span>
            )}
            {plan && items.length > 0 && <span className="compare-foot-line">{footerLine(tickedCount, plan.items.length, targetLabel, production)}</span>}
            {/* The Sync Script view shows this line under the script; Apply from the Differences view says it here. */}
            {plan && view === "diff" && plan.mode.kind === "sequential" && plan.statements.length > 0 && <span className="compare-foot-line">{plan.line}</span>}
            <span className="spacer" />
            {whyNot && <span className="compare-foot-why">{whyNot}</span>}
            <button type="button" className="button" disabled={!plan || nothing || comparing} onClick={copyScript}>
              <Icon name="copy" size={14} />
              Copy script
            </button>
            <button
              type="button"
              className={production ? "button button-prod" : "button button-primary"}
              disabled={!canApply}
              title={whyNot ?? (production ? "Opens the confirmation with the exact SQL" : undefined)}
              onClick={onApply}
            >
              {production ? "Apply on PROD..." : "Apply"} <Kbd keys="Ctrl+Enter" />
            </button>
          </>
        )}
      </footer>

      {confirming && plan && tgtConn && target && (
        <ConfirmRun
          verb="Sync"
          verdict={{
            connection: tgtConn.name,
            database: target.database,
            statements: plan.statements.map((s) => ({ text: s.sql, class: s.writes ? ("write" as const) : ("read" as const) })),
            writes: plan.statements.filter((s) => s.writes).length,
            kind: "needsConfirmation",
          }}
          dialect={tgtConn.dialect}
          group={groups.find((g) => g.id === tgtConn.groupId) ?? null}
          danger={dropping.length > 0 || lossTicked.length > 0}
          runDisabled={planPending}
          dropsData={dropping}
          countNote={confirmModeNote(plan.mode, plan.enumValuesFirst)}
          banner={
            lossTicked.length > 0 ? (
              <>
                {lossTicked.map((it, i) => (
                  <WarningBanner
                    key={it.id}
                    className="compare-danger"
                    action={
                      <button type="button" className="button button-small" onClick={() => toggle(it.id, false, 0)}>
                        Untick it
                      </button>
                    }
                  >
                    {i === 0 && <strong>{dropsDataCount(lossTicked.length)} </strong>}
                    {confirmLossSentence({ kind: it.kind, object: it.object, name: nameOf(it.id) }, it.dataLoss)}
                  </WarningBanner>
                ))}
              </>
            ) : undefined
          }
          onRun={() => void onConfirmed()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
