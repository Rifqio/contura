// The lineage tab (spec 6+ section 5, frame 6+.1): a table's Foreign Keys both ways as a read-only
// diagram, with a panel that says what each key does. Reads catalog details only, never rows.
import type { Edge, EdgeTypes, Node, NodeTypes, ReactFlowInstance } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DIALECT_LABEL, isCommandError, isNotOpen, errorText, lineage as readLineage, listFlowTableLinks, tableDesign, viewDependencies } from "../api/client";
import type { ConnectionId, DialectKind, FlowTableAccess, Lineage, LineageDirection, ObjectPath } from "../api/types";
import CardFrame from "../diagram/CardFrame";
import DiagramCanvas from "../diagram/DiagramCanvas";
import PublishDialog from "../diagram/export/PublishDialog";
import type { Box, Scene } from "../diagram/export/scene";
import { ARROW_MARKER } from "../diagram/edges";
import type { LivePositions } from "../diagram/livePositions";
import { motionMs } from "../diagram/motion";
import { tween } from "../flow/interactions/tween";
import Icon from "../components/Icon";
import Segmented from "../components/Segmented";
import LineagePanel, { type RefRow } from "./LineagePanel";
import { LineageCard, RefCard, RefEdge, columnPort } from "./nodes";
import { keyFor, useLineageLayout } from "./layout";
import { LINEAGE_CARD_WIDTH, REF_HEIGHT, cardHeightOf, layoutLineage, lineageScene, refId, tableId } from "./scene";
import { type DeleteEffects, deleteEffects, flowMatches, flowSentence, processSentence, samePath } from "./sentences";
import { MAX_VIEWS, viewsUsing } from "./views";

export interface LineageTabProps {
  connection: { id: ConnectionId; name: string; dialect: DialectKind };
  path: ObjectPath;
  /** Opens the table's own tab (Nothing linked's Open orders). */
  onOpenTable(path: ObjectPath): void;
  /** Add a Foreign Key: opens the Table Designer. */
  onAddForeignKey(path: ObjectPath): void;
  /** Opens a diagram by name; the Diagrams rows offer Open only when set. */
  onOpenDiagram?(name: string): void;
  /** Opens a view's tab; the Views rows offer Open only when set. */
  onOpenView?(path: ObjectPath): void;
}

type Depth = "1" | "2" | "3" | "all";
type Source = "flows" | "views";
type Load = { s: "loading" } | { s: "failed"; error: unknown } | { s: "ready"; lineage: Lineage };
/** `key` names the card in the layout file, so a moved card keeps its place when the rows change. */
type Ref = { kind: "flow" | "view"; key: string; title: string; file: string; diagram: string; access: FlowTableAccess; open?: () => void };
/**
 * The diagrams or views below the table; `failed` when the diagrams folder or the views could not be read,
 * `catalog` when the views came from the catalog's own record rather than a name match.
 */
type Refs = { rows: Ref[]; notes: string[]; failed: boolean; catalog?: boolean };
type Effects = { s: "loading" } | { s: "failed" } | { s: "ready"; lineage: Lineage };

/** What was not checked when the diagrams folder or the views could not be read. */
const UNREAD: Record<Source, string> = {
  flows: "Contura couldn't read the diagrams folder, so diagrams weren't checked.",
  views: "Contura couldn't read the views, so views weren't checked.",
};

const NODE_TYPES: NodeTypes = { lineageCard: LineageCard, lineageRef: RefCard };
const EDGE_TYPES: EdgeTypes = { lineageRef: RefEdge };

/** Puts a card in the middle of the view at the same zoom: a canvas move, so 240 ms (0 under reduced motion). */
export function centerOn(flow: Pick<ReactFlowInstance, "getNode" | "getZoom" | "setCenter">, id: string): void {
  const n = flow.getNode(id);
  if (!n) return;
  const w = n.measured?.width ?? n.width ?? n.initialWidth ?? 0;
  const h = n.measured?.height ?? n.height ?? n.initialHeight ?? 0;
  void flow.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: flow.getZoom(), duration: motionMs("fit") });
}

const PERMISSION = /permission denied|access denied|command denied|not allowed|insufficient privilege|not authori[sz]ed/i;

/** The Could not read notice's sentence, by what went wrong. */
function failedSentence(e: unknown): string {
  if (isNotOpen(e)) return "This Connection is not open. Open it again, then try again.";
  if (isCommandError(e)) {
    if (typeof e.message === "string" && PERMISSION.test(e.message)) {
      return "Your account isn't allowed to read key details here. Ask the database owner for access, then try again.";
    }
    if (e.kind === "timedOut") return `Reading the keys took longer than Contura's ${e.message}s limit. Try a smaller depth, then try again.`;
    if (e.kind === "notFound") return "Contura can't find this table. Refresh the tree, then try again.";
    if (e.kind === "connect") return "Contura can't reach the database server. Check that it is running, then try again.";
  }
  return "The database did not give the key details. Its reason is below.";
}

/** The "From the database" text: the server's own words when there are any. */
function rawText(e: unknown, dialect: DialectKind): string {
  if (isCommandError(e) && typeof e.message === "string") return e.message;
  // Lineage's own read limit, not the database's words or the Connection's timeout.
  if (isCommandError(e) && e.kind === "timedOut") return `Contura stops reading keys after ${e.message}s.`;
  return errorText(e, dialect);
}

type FlowRow = { file: string; frame: string | null; process: string | null; access: FlowTableAccess };

/**
 * One row per process that touches the table in each diagram ("Ship order in Fulfilment reads orders"), and
 * one per diagram for a table node no process touches. Accesses merge: reading in one place and writing in
 * another does both.
 */
function flowRefs(all: Awaited<ReturnType<typeof listFlowTableLinks>>, path: ObjectPath): FlowRow[] {
  const out = new Map<string, FlowRow>();
  const add = (file: string, frame: string | null, process: string | null, access: FlowTableAccess) => {
    const key = JSON.stringify([file, frame, process]);
    const was = out.get(key);
    out.set(key, { file, frame, process, access: was === undefined || was.access === access ? access : "both" });
  };
  for (const f of all) {
    if (!flowMatches(f.table, path)) continue;
    const processes = f.processes ?? [];
    const frame = f.frame == null ? null : f.frame === "" ? "Untitled" : f.frame;
    if (processes.length === 0) add(f.file, frame, null, f.access);
    for (const p of processes) add(f.file, frame, p.node, p.access);
  }
  return [...out.values()];
}

/** The views as rows: "reads" when the catalog said so, "names" for a name match. */
function viewRefs(views: ObjectPath[], path: ObjectPath, reads: boolean, onOpenView?: (path: ObjectPath) => void): Ref[] {
  return views.map((v) => {
    const label = v.schema ? `${v.schema}.${v.name}` : v.database !== path.database ? `${v.database}.${v.name}` : v.name;
    return {
      kind: "view" as const,
      // The database too: on MySQL views come from every database and have no schema (P18).
      key: `r:view:${JSON.stringify([v.database, v.schema ?? null, v.name])}`,
      title: `${v.name} ${reads ? "reads" : "names"} ${path.name}`,
      file: label,
      diagram: label,
      access: "reads" as const,
      open: onOpenView && (() => onOpenView(v)),
    };
  });
}

/** Under the Views rows when the server keeps a view catalog but reading it failed (P18). */
const CATALOG_FAILED = "Contura couldn't read the view catalog, so these are name matches.";

export default function LineageTab({ connection, path, onOpenTable, onAddForeignKey, onOpenDiagram, onOpenView }: LineageTabProps) {
  const [depth, setDepth] = useState<Depth>("1");
  const [direction, setDirection] = useState<LineageDirection>("both");
  const [source, setSource] = useState<Source>("flows");
  const [retry, setRetry] = useState(0);
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [refsRead, setRefsRead] = useState<Refs | null>(null);
  const [effectsRead, setEffectsRead] = useState<Effects>({ s: "loading" });
  /** Key column defaults by holder table, read for SET DEFAULT keys only: column name to "has a default", or the read failed. */
  const [defaults, setDefaults] = useState<ReadonlyMap<string, ReadonlyMap<string, boolean> | "failed">>(new Map());
  const asked = useRef(new Set<string>());
  const [hot, setHot] = useState<string | null>(null);
  const { moves, move, reset } = useLineageLayout(connection.id, path);
  const flow = useRef<ReactFlowInstance | null>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  /** The Publish dialog, open on the scene built when it was asked for; closing it lets the scene go. */
  const [publishing, setPublishing] = useState<{ scene: Scene; onScreen: Box } | null>(null);
  /** Reset layout's glide: the moved cards part of the way home (Reset is lineage's Tidy, 240 ms). */
  const [glide, setGlide] = useState<LivePositions | null>(null);
  const stopGlide = useRef<() => void>(() => {});
  useEffect(() => () => stopGlide.current(), []);
  const pathKey = tableId(path);
  const scope = path.schema ?? path.database;

  // Depth, direction and Try again read the keys again; the drawing stays until the new one is in.
  useEffect(() => {
    let alive = true;
    setLoad((was) => (was.s === "ready" ? was : { s: "loading" }));
    readLineage(connection.id, path, depth === "all" ? 0 : Number(depth), direction).then(
      (lineage) => {
        if (!alive) return;
        setLoad({ s: "ready", lineage });
      },
      (error: unknown) => alive && setLoad({ s: "failed", error }),
    );
    return () => {
      alive = false;
    };
    // `path` is read through its key, so a new object for the same table does not read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, pathKey, depth, direction, retry]);

  // The warning block's own read: every table using this one, whatever the toolbar shows.
  useEffect(() => {
    let alive = true;
    // Try again keeps the last result on screen while it reads again; another table starts unchecked.
    setEffectsRead((was) => (was.s === "ready" && tableId(was.lineage.center) === pathKey ? was : { s: "loading" }));
    readLineage(connection.id, path, 0, "usedBy").then(
      (lineage) => alive && setEffectsRead({ s: "ready", lineage }),
      () => alive && setEffectsRead({ s: "failed" }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, pathKey, retry]);

  // The source switch reads the diagrams folder or the views that name the table.
  useEffect(() => {
    let alive = true;
    setRefsRead(null);
    // A name match, said as one: the view's text names the table.
    const byName = (catalogFailed: boolean): Promise<Refs> =>
      viewsUsing(connection.id, path, () => alive).then((scan) => ({
        rows: viewRefs(scan.views, path, false, onOpenView),
        notes: [
          ...(catalogFailed ? [CATALOG_FAILED] : []),
          ...(scan.capped ? [`Checked the first ${MAX_VIEWS} views.`] : []),
          ...(scan.unreadable > 0 ? [`${scan.unreadable} ${scan.unreadable === 1 ? "view" : "views"} could not be read.`] : []),
        ],
        failed: false,
      }));
    const read: Promise<Refs> =
      source === "flows"
        ? listFlowTableLinks().then((all) => ({
            rows: flowRefs(all, path).map(({ file, frame, process, access }) => ({
              kind: "flow" as const,
              // A board names the frame beside the file; a one-frame file keeps its old key.
              key: `r:flow:${JSON.stringify(frame === null ? [file, process] : [file, frame, process])}`,
              title: process === null ? flowSentence(file, access, path) : processSentence(process, access, path),
              file: frame === null ? file : `${file}: ${frame}`,
              diagram: file,
              access,
              open: onOpenDiagram && (() => onOpenDiagram(file)),
            })),
            notes: [],
            failed: false,
          }))
        : // The catalog's own record of what each view reads, where the server keeps one (PostgreSQL, MySQL
          // 8.0.13+). SQLite and older servers, or a catalog read that fails, fall back to the name match.
          viewDependencies(connection.id, path).then(
            (deps): Refs | Promise<Refs> =>
              deps.catalog
                ? {
                    rows: viewRefs(deps.views, path, true, onOpenView),
                    notes: deps.capped ? [`Showing the first ${MAX_VIEWS} views.`] : [],
                    failed: false,
                    catalog: true,
                  }
                : byName(false),
            () => byName(true),
          );
    read.then(
      (r) => alive && setRefsRead(r),
      () => alive && setRefsRead({ rows: [], notes: [], failed: true }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, pathKey, source, retry]);

  const lineage = load.s === "ready" ? load.lineage : null;
  const refs = refsRead?.rows ?? null;
  const effectsLineage = effectsRead.s === "ready" ? effectsRead.lineage : null;

  // SET DEFAULT can only run when every key column has a default (or can be empty): read the holders' defaults.
  useEffect(() => {
    const holders = [...(lineage?.links ?? []), ...(effectsLineage?.links ?? [])]
      .filter((l) => [l.onDelete, l.onUpdate].some((r) => r?.toUpperCase() === "SET DEFAULT"))
      .map((l) => l.from);
    for (const holder of holders) {
      const id = tableId(holder);
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      tableDesign(connection.id, holder).then(
        (d) => setDefaults((m) => new Map(m).set(id, new Map(d.columns.map((c) => [c.name, c.defaultSql !== null])))),
        // Said in the warning ("couldn't read the defaults of ..."); Try again reads it once more.
        () => setDefaults((m) => new Map(m).set(id, "failed")),
      );
    }
  }, [lineage, effectsLineage, connection.id]);
  const hasDefault = useMemo(
    () => (holder: ObjectPath, column: string) => {
      const known = defaults.get(tableId(holder));
      return known === undefined ? null : known === "failed" ? "failed" : (known.get(column) ?? null);
    },
    [defaults],
  );
  const effects: DeleteEffects | null =
    effectsRead.s === "ready"
      ? deleteEffects(effectsRead.lineage, effectsRead.lineage.center, hasDefault)
      : effectsRead.s === "failed"
        ? { blocks: [], cascades: [], incomplete: `This list may be incomplete: Contura couldn't read the keys that point to ${path.name}.` }
        : null;
  const refCount = refs?.length ?? 0;
  const placed = useMemo(() => (lineage ? layoutLineage(lineage, refCount) : {}), [lineage, refCount]);

  const recenter = (id: string) => () => flow.current && centerOn(flow.current, id);
  const cardData = useMemo(
    () => new Map((lineage?.tables ?? []).map((t, i) => [tableId(t.path), { table: t, center: i === 0, drive: [] as string[], onDouble: recenter(tableId(t.path)) }])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineage],
  );

  const nodes = useMemo<Node[]>(() => {
    if (!lineage) return [];
    const hotLink = hot?.startsWith("link:") ? lineage.links[Number(hot.slice(5))] : undefined;
    const at = (id: string, key = id) => moves[key] ?? placed[id] ?? { x: 0, y: 0 };
    const cards: Node[] = lineage.tables.map((t) => {
      const id = tableId(t.path);
      const data = cardData.get(id)!;
      return {
        id,
        type: "lineageCard",
        position: at(id),
        initialWidth: LINEAGE_CARD_WIDTH,
        initialHeight: cardHeightOf(t),
        data: hotLink && samePath(hotLink.from, t.path) ? { ...data, drive: hotLink.fromColumns } : data,
      };
    });
    const below: Node[] = (refs ?? []).map((r, i) => ({
      id: refId(i),
      type: "lineageRef",
      position: at(refId(i), r.key),
      initialWidth: LINEAGE_CARD_WIDTH,
      initialHeight: REF_HEIGHT,
      data: { kind: r.kind, title: r.title, file: r.file, onDouble: recenter(refId(i)) },
    }));
    return [...cards, ...below];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineage, refs, placed, moves, hot, cardData]);

  const edges = useMemo<Edge[]>(() => {
    if (!lineage) return [];
    const x = (id: string) => (moves[keyFor(id, refs)] ?? placed[id] ?? { x: 0 }).x;
    const shown = new Map(lineage.tables.map((t) => [tableId(t.path), new Set(t.columns.map((c) => c.name))]));
    const port = (id: string, column: string | undefined, side: "s" | "t") =>
      column !== undefined && shown.get(id)?.has(column) ? `${columnPort(column)}:${side}` : `card:${side}`;
    const cls = (key: string, more = "") => `lineage-edge${more}${hot === key ? " lineage-edge-hot" : ""}`;
    const links: Edge[] = lineage.links.map((l, i) => {
      const key = `link:${i}`;
      const holder = tableId(l.from);
      const target = tableId(l.to);
      const base = { id: key, type: "orthogonal", className: cls(key), selectable: false };
      // Each line leaves the left card on its right and enters the right card on its left; the arrow points to the key's table.
      return x(holder) <= x(target)
        ? { ...base, source: holder, sourceHandle: port(holder, l.fromColumns[0], "s"), target, targetHandle: port(target, l.toColumns[0], "t"), markerEnd: ARROW_MARKER }
        : { ...base, source: target, sourceHandle: port(target, l.toColumns[0], "s"), target: holder, targetHandle: port(holder, l.fromColumns[0], "t"), markerStart: ARROW_MARKER };
    });
    const center = tableId(lineage.center);
    const below: Edge[] = (refs ?? []).map((r, i) => ({
      id: refId(i),
      type: "lineageRef",
      source: refId(i),
      target: center,
      targetHandle: "card:t",
      className: cls(refId(i), " lineage-edge-ref"),
      selectable: false,
      // Writes point into the table, reads out of it into the diagram or view.
      ...(r.access !== "reads" ? { markerEnd: ARROW_MARKER } : {}),
      ...(r.access !== "writes" ? { markerStart: ARROW_MARKER } : {}),
    }));
    return [...links, ...below];
  }, [lineage, refs, placed, moves, hot]);

  /**
   * Reset layout: lineage's layout is computed, so Reset is its Tidy. Every moved card glides back to its computed
   * place with the Tidy timing (none under reduced motion), then the layout file is removed.
   */
  function resetLayout() {
    stopGlide.current();
    const from: Record<string, { x: number; y: number }> = {};
    const to: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      const home = placed[n.id];
      if (!home || (n.position.x === home.x && n.position.y === home.y)) continue;
      from[n.id] = n.position;
      to[n.id] = home;
    }
    reset();
    const ids = Object.keys(to);
    const ms = motionMs("tidy");
    if (ms === 0 || ids.length === 0) {
      setGlide(null);
      return;
    }
    const frame = (p: number): LivePositions =>
      Object.fromEntries(ids.map((id) => [id, { x: from[id].x + (to[id].x - from[id].x) * p, y: from[id].y + (to[id].y - from[id].y) * p }]));
    setGlide(frame(0));
    stopGlide.current = tween(
      ms,
      (p) => setGlide(frame(p)),
      () => {
        stopGlide.current = () => {};
        setGlide(null);
      },
    );
  }

  /** Publish: every card where the canvas draws it now, with its key lines and the dashed diagram or view lines. */
  function openPublish() {
    if (!lineage) return;
    const at = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
    const scene = lineageScene(lineage, (refs ?? []).map(({ kind, title, file, access }) => ({ kind, title, file, access })), at);
    let onScreen: Box = { x: 0, y: 0, w: 0, h: 0 };
    const r = canvasBox.current?.getBoundingClientRect();
    const f = flow.current;
    if (r && f && r.width > 0 && r.height > 0) {
      const a = f.screenToFlowPosition({ x: r.x, y: r.y });
      const b = f.screenToFlowPosition({ x: r.x + r.width, y: r.y + r.height });
      onScreen = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    setPublishing({ scene, onScreen });
  }

  const panelRefs: RefRow[] | null = refs && refs.map((r, i) => ({ key: refId(i), kind: r.kind, title: r.title, file: r.file, diagram: r.diagram, onOpen: r.open }));
  const nothing = lineage !== null && lineage.links.length === 0 && refs !== null && refs.length === 0 && direction === "both";
  // Nothing linked says what was searched, and when the diagrams folder could not be read.
  const nothingText =
    refsRead?.failed
      ? `No Foreign Key points to or from it. ${UNREAD[source]}`
      : source === "views"
        ? refsRead?.catalog
          ? "No Foreign Key points to or from it, and no view reads it."
          : "No Foreign Key points to or from it, and no view names it."
        : // Only diagram arrows are read (a table: node no arrow touches is left out, ADR 0019).
          "No Foreign Key points to or from it, and no diagram arrow reads or writes it.";
  // The panel's group says the same when the read failed.
  const refNotes = refsRead?.failed ? [UNREAD[source]] : refsRead?.notes;
  const truncatedNote = lineage?.truncated
    ? lineage.tables.length >= 300
      ? "Showing the first 300 tables."
      : "Reading stopped after 10s, so some tables are left out."
    : null;
  const where = `${scope}, ${DIALECT_LABEL[connection.dialect]}`;

  const centerCard = (rows: Lineage["tables"][number] | undefined) => (
    <CardFrame
      kind="table"
      label={`Table ${path.name}`}
      name={path.name}
      title={<span className="table-card-name">{path.name}</span>}
      subtitle={scope}
      count={rows?.columnCount ?? 0}
      countLabel={rows ? undefined : ""}
      selected={false}
      width={LINEAGE_CARD_WIDTH}
      rows={(rows?.columns ?? []).map((c) => (
        <li key={c.name} className="table-card-column lineage-row">
          <span className={c.pk ? "lineage-mark lineage-mark-pk" : c.fk ? "lineage-mark lineage-mark-fk" : "lineage-mark"}>{c.pk ? "PK" : c.fk ? "FK" : ""}</span>
          <span className="lineage-col-name">{c.name}</span>
          <span className="lineage-col-type">{c.nullable ? `${c.ty} ?` : c.ty}</span>
        </li>
      ))}
    />
  );

  let canvas;
  if (load.s === "failed") {
    const raw = rawText(load.error, connection.dialect);
    canvas = (
      <div className="lineage-state">
        <div className="lineage-error" role="alert">
          <div className="lineage-error-title">
            <Icon name="alert" size={16} />
            Can't read the keys in {scope}
          </div>
          <p>{failedSentence(load.error)}</p>
          <div className="lineage-raw" role="group" aria-label="From the database">
            <b>From the database</b>
            <code>{raw}</code>
            <button type="button" className="icon-button lineage-raw-copy" aria-label="Copy error" title="Copy error" onClick={() => void navigator.clipboard?.writeText(raw)}>
              <Icon name="copy" size={14} />
            </button>
          </div>
          <div className="lineage-error-actions">
            <button
              type="button"
              className="icon-button lineage-retry"
              aria-label="Try again"
              title="Try again"
              onClick={() => {
                setLoad({ s: "loading" });
                // Defaults that failed (or were never answered) are read again too.
                asked.current.clear();
                setDefaults(new Map());
                setRetry((n) => n + 1);
              }}
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  } else if (load.s === "loading") {
    canvas = (
      <div className="lineage-state lineage-loading">
        <div className="lineage-loading-cards">
          <div className="lineage-skel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          {centerCard(undefined)}
          <div className="lineage-skel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
        <p className="lineage-loadline" role="status">
          <span className="spinner spinner-small" aria-hidden="true" />
          Reading Foreign Keys in {scope}
        </p>
      </div>
    );
  } else if (nothing) {
    canvas = (
      <div className="lineage-state lineage-nothing">
        {centerCard(lineage?.tables[0])}
        <div className="lineage-nothing-note">
          <h4>Nothing links to {path.name} yet</h4>
          <p>{nothingText}</p>
          {refsRead?.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          <div className="lineage-nothing-actions">
            <button type="button" className="button button-primary" onClick={() => onAddForeignKey(path)}>
              Add a Foreign Key
            </button>
            <button type="button" className="button" onClick={() => onOpenTable(path)}>
              Open {path.name}
            </button>
          </div>
        </div>
      </div>
    );
  } else {
    canvas = (
      <DiagramCanvas
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onMove={(id, nx, ny) => {
          // A card moved by hand ends a Reset glide where the cards are.
          stopGlide.current();
          setGlide(null);
          move(keyFor(id, refs), { x: nx, y: ny });
        }}
        livePositions={glide}
        // F32: one navigation model on every canvas (drag selects, wheel pans, Ctrl + wheel zooms).
        boxSelect
        onInit={(i) => {
          flow.current = i;
        }}
      />
    );
  }

  return (
    <section className="lineage-tab" aria-label={`${path.name} lineage`}>
      <div className="lineage-toolbar" role="toolbar" aria-label="Lineage">
        <span className="lineage-toolbar-label">Depth</span>
        <Segmented<Depth>
          label="Depth"
          value={depth}
          onChange={setDepth}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "all", label: "All" },
          ]}
        />
        <span className="editor-header-divider" aria-hidden="true" />
        <Segmented<LineageDirection>
          label="Direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "both", label: "Both" },
            { value: "uses", label: "Uses" },
            { value: "usedBy", label: "Used by" },
          ]}
        />
        <span className="editor-header-divider" aria-hidden="true" />
        <Segmented<Source>
          label="Source"
          value={source}
          onChange={setSource}
          options={[
            { value: "flows", label: "Flows" },
            { value: "views", label: "Views" },
          ]}
        />
        {truncatedNote && <span className="lineage-toolbar-note">{truncatedNote}</span>}
        <span className="lineage-toolbar-spacer" />
        {lineage && !nothing && <span className="lineage-toolbar-hint">Double-click a table to put it in the middle</span>}
        {lineage && !nothing && (
          <button type="button" className="button" onClick={openPublish}>
            <Icon name="image" size={14} />
            Publish
          </button>
        )}
        {lineage && !nothing && Object.keys(moves).length > 0 && (
          <button type="button" className="button" title="Put every card back in its place" onClick={resetLayout}>
            Reset layout
          </button>
        )}
      </div>
      <div className="lineage-body">
        <div className="lineage-canvas" ref={canvasBox}>
          {canvas}
        </div>
        {lineage && !nothing ? (
          <LineagePanel
            lineage={lineage}
            effects={effects}
            hasDefault={hasDefault}
            sqlite={connection.dialect === "sqlite"}
            refs={panelRefs}
            refNotes={refNotes}
            source={source}
            where={where}
            hot={hot}
            onHot={setHot}
          />
        ) : (
          <aside className="lineage-panel" aria-label="What links do">
            <div className="lineage-panel-strip">
              <span className="lineage-panel-title">{path.name}</span>
              <span className="lineage-panel-where">{where}</span>
            </div>
          </aside>
        )}
      </div>
      {publishing && (
        <PublishDialog
          scene={publishing.scene}
          fileName={`${path.name} lineage`}
          selected={[]}
          onScreen={publishing.onScreen}
          onClose={() => setPublishing(null)}
          onSaved={() => setPublishing(null)}
        />
      )}
    </section>
  );
}
