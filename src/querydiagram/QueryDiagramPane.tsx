// The query diagram (B1): a read-only drawing of the current statement beside a SQL tab or a
// Visual Query, rebuilt as you type. It reads table details only and sends nothing to the server.
import type { Edge, Node, NodeTypes, ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionId, DialectKind } from "../api/types";
import Icon from "../components/Icon";
import DiagramCanvas from "../diagram/DiagramCanvas";
import { ARROW_MARKER } from "../diagram/edges";
import PublishDialog from "../diagram/export/PublishDialog";
import type { LayoutRequest, Positions } from "../diagram/layout";
import { QUERY_CARD_WIDTH, RESULT_WIDTH } from "../diagram/metrics";
import type { LangClient } from "../lang/client";
import type { Range } from "../lang/sql/analyze";
import type { SchemaState } from "../lang/sql/inspect";
import type { QueryShape, ShapeJoin, ShapeProblem, ShapeTable } from "../lang/sql/queryShape";
import { type SchemaCache, schemaKey as keyOf } from "../lang/sql/schemaCache";
import type { SqlFk, SqlSchema } from "../lang/sql/types";
import ResultNode, { RESULT_ID, resultHeight, resultPort } from "./ResultNode";
import ShapeCard, { type ShapeCardData, rowPort, shapeCardHeight } from "./ShapeCard";
import { toScene } from "./toScene";

export interface QueryDiagramPaneProps {
  /** The editor's text and where you are typing, or a Visual Query's generated SQL. */
  source: { kind: "editor"; docId: string; text: string; pos: number } | { kind: "visual"; docId: string; text: string };
  dialect: DialectKind;
  schemaKey: string | null;
  /** Whether the schema under `schemaKey` is loading (cards say "Loading schema"), loaded, or absent for good. */
  schemaState: SchemaState;
  lang: { client: LangClient };
  /** The SQL ranges of the selected card (the SELECT list for the Result); empty clears. */
  onBand(ranges: Range[]): void;
  /** A card was selected: its alias, or its name when it has none. */
  onSelectTable?(alias: string): void;
  onClose(): void;
  /**
   * The schema cache, Connection and database the tab reads: with them, every other database the
   * statement names (MySQL `db.table`, SQLite attached) loads, and its tables say "Loading schema" until it does (V9).
   */
  schemas?: { cache: SchemaCache; connectionId: ConnectionId; database: string | null } | null;
  /** The status slot's "3 tables, 2 Joins"; null when nothing is drawn or the pane closes. */
  onStatus?(text: string | null): void;
  /** False while the pane's tab is hidden: it loads, merges and asks nothing until it shows again. */
  visible?: boolean;
}

const NODE_TYPES: NodeTypes = { shapeCard: ShapeCard, result: ResultNode } as unknown as NodeTypes;

const JOIN_KINDS = new Set(["inner", "left", "right", "full", "cross"]);

/** "3 tables, 2 Joins": CROSS JOINs count as Joins; WHERE and condition lines do not. */
export function shapeCount(shape: QueryShape): string {
  const n = shape.tables.length;
  if (n === 0) return "No tables";
  const joins = shape.joins.filter((j) => JOIN_KINDS.has(j.kind)).length;
  const tables = `${n} ${n === 1 ? "table" : "tables"}`;
  return joins === 0 ? tables : `${tables}, ${joins} ${joins === 1 ? "Join" : "Joins"}`;
}

/** The analyzer's sentence after "Line N: ", first letter lowered, with its full stop (V5). */
function lineMessage(p: { line: number; message: string }): string {
  const m = p.message.trim();
  const body = m.charAt(0).toLowerCase() + m.slice(1);
  return `Line ${p.line}: ${/[.?!]$/.test(body) ? body : `${body}.`}`;
}

/** "This one is an UPDATE." / "a DELETE." */
const notReadText = (verb: string) => `The diagram shows SELECT statements. This one is ${/^[AEIOU]/i.test(verb) ? "an" : "a"} ${verb}.`;

/** `dbs`: the named databases whose tables the shape was read with. */
type Drawn = { shape: QueryShape; positions: Positions; dbs: string[] };
type Merged = { schema: SqlSchema; dbs: string[] };

const lc = (s: string) => s.toLowerCase();

/** The other databases a shape's tables name: MySQL and SQLite only (PostgreSQL schemas live in the tab's database). */
function namedDatabases(shape: QueryShape | null, dialect: DialectKind, schemas: { database: string | null } | null): string[] {
  if (!shape || !schemas || dialect === "postgres") return [];
  const home = schemas.database === null ? null : lc(schemas.database);
  const own = new Set(dialect === "sqlite" ? ["main", "temp", home] : [home]);
  const out = new Map<string, string>();
  for (const t of shape.tables) if (t.kind !== "derived" && t.schema && !own.has(lc(t.schema)) && !out.has(lc(t.schema))) out.set(lc(t.schema), t.schema);
  return [...out.values()].sort();
}

function layoutNodes(shape: QueryShape): LayoutRequest["nodes"] {
  return [
    ...shape.tables.map((t) => ({ id: t.key, w: QUERY_CARD_WIDTH, h: shapeCardHeight(t) })),
    { id: RESULT_ID, w: RESULT_WIDTH, h: resultHeight(shape) },
  ];
}

/** Joined tables rank after what they join to's partner, and every card ranks before the Result. */
function layoutEdges(shape: QueryShape): LayoutRequest["edges"] {
  return [...shape.joins.map((j) => ({ from: j.from, to: j.to })), ...shape.tables.map((t) => ({ from: t.key, to: RESULT_ID }))];
}

/** Where cards go when the layout worker fails: a column per card, the Result last. */
function fallbackPlace(nodes: LayoutRequest["nodes"], existing: Positions): Positions {
  const out: Positions = { ...existing };
  let x = Math.max(0, ...Object.entries(existing).map(([id, p]) => p.x + (nodes.find((n) => n.id === id)?.w ?? 0) + 80));
  for (const n of nodes) {
    if (out[n.id]) continue;
    out[n.id] = { x, y: 0 };
    x += n.w + 80;
  }
  return out;
}

/** The line's label pill: the Join kind, the condition text, or "in WHERE". */
function pill(j: ShapeJoin) {
  return <span className={`qd-pill qd-pill-${j.kind}`}>{j.label}</span>;
}

export default function QueryDiagramPane(props: QueryDiagramPaneProps) {
  const { source, dialect, schemaKey, schemaState, lang, schemas, visible = true } = props;
  const pos = source.kind === "editor" ? source.pos : 0;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [problem, setProblem] = useState<ShapeProblem | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [publishAt, setPublishAt] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Every card's place while the pane is open, by card key, so a card keeps it across rebuilds. */
  const places = useRef<Positions>({});
  const asked = useRef(0);
  const placing = useRef(0);
  const flow = useRef<ReactFlowInstance | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  /** The last shape drawn, as text, so an answer that changes nothing draws nothing (moving within a statement). */
  const drawnJson = useRef<string | null>(null);

  /** Draws `shape` where its cards were; new cards (or all of them, for Tidy) go through the layout worker. */
  const place = useCallback(
    (shape: QueryShape, all: boolean, dbs: string[]) => {
      const run = ++placing.current;
      const nodes = layoutNodes(shape);
      const existing: Positions = {};
      if (!all) for (const n of nodes) if (places.current[n.id]) existing[n.id] = places.current[n.id];
      const json = JSON.stringify([shape, dbs]);
      const commit = (p: Positions) => {
        if (run !== placing.current) return;
        places.current = { ...places.current, ...p };
        drawnJson.current = json;
        setDrawn({ shape, positions: p, dbs });
      };
      if (nodes.every((n) => existing[n.id])) {
        if (!all && json === drawnJson.current) return;
        return commit(existing);
      }
      lang.client
        .layout({ nodes, edges: layoutEdges(shape), existing, rankdir: "LR", pin: RESULT_ID })
        .then(commit, () => commit(fallbackPlace(nodes, existing)));
    },
    [lang.client],
  );

  // ---- V9: every other database the statement names loads through the shared schema cache ----
  const home = schemas ? schemas.database : undefined;
  const hasCache = !!schemas;
  // Keyed on the values, not the props object, which a host may rebuild on every render.
  const namedList = useMemo(
    () => namedDatabases(drawn?.shape ?? null, dialect, hasCache ? { database: home ?? null } : null),
    [drawn, dialect, hasCache, home],
  );
  const namedKey = namedList.join("\u0000");
  const named = useMemo(() => (namedKey ? namedKey.split("\u0000") : []), [namedKey]);
  const [stamp, setStamp] = useState(0);
  const cache = schemas?.cache ?? null;
  const cid = schemas?.connectionId ?? null;
  // A hidden pane takes no notice of the cache; shown again, it catches up once.
  useEffect(() => {
    if (!cache || !visible) return;
    setStamp((n) => n + 1);
    return cache.subscribe(() => setStamp((n) => n + 1));
  }, [cache, visible]);
  useEffect(() => {
    if (!cache || !cid || !visible) return;
    for (const db of namedKey.split("\u0000")) if (db) void cache.ensure(cid, db);
  }, [cache, cid, namedKey, visible]);
  /** The tab's schema plus each named database's tables under its name; kept while nothing in it changed. */
  const mergedRef = useRef<{ parts: unknown[]; value: Merged } | null>(null);
  const merged = useMemo<Merged | null>(() => {
    if (!cid || !schemaKey || named.length === 0) return null;
    const base = lang.client.sqlSchemaFor(schemaKey);
    // Until the tab's own schema is here, its tables would read as unknown.
    if (!base) return null;
    const loaded = named.flatMap((db) => {
      const s = lang.client.sqlSchemaFor(keyOf(cid, db));
      return s ? [{ db, s }] : [];
    });
    const parts = [base, ...loaded.flatMap((l) => [l.db, l.s])];
    const prev = mergedRef.current;
    if (prev && prev.parts.length === parts.length && prev.parts.every((p, i) => p === parts[i])) return prev.value;
    const scoped = (db: string) => (e: SqlFk["from"]) => ({ ...e, schema: db });
    const value: Merged = {
      schema: {
        searchPath: base.searchPath,
        tables: [...base.tables, ...loaded.flatMap(({ db, s }) => s.tables.map((t) => ({ ...t, schema: db })))],
        fks: [...base.fks, ...loaded.flatMap(({ db, s }) => s.fks.map((f) => ({ ...f, from: scoped(db)(f.from), to: scoped(db)(f.to) })))],
      },
      dbs: loaded.map((l) => l.db),
    };
    mergedRef.current = { parts, value };
    return value;
    // `stamp` is the schema cache's change count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, schemaKey, namedKey, stamp, lang.client]);
  const mergedKey = cid ? `${cid}\u0000${source.docId}\u0000diagram` : null;
  // Sent before the ask below (effects run in order), so the worker has it when the shape is asked for.
  useEffect(() => {
    if (merged && mergedKey) lang.client.setSqlSchema(mergedKey, merged.schema);
  }, [merged, mergedKey, lang.client]);
  useEffect(
    () => () => {
      if (mergedKey && lang.client.sqlSchemaFor(mergedKey)) lang.client.setSqlSchema(mergedKey, null);
    },
    [mergedKey, lang.client],
  );

  // Asks for the shape on every change of the text or of where you are typing; the worker debounces (D13).
  // With other databases merged in, the pane parses under its own document, so the editor's parse stays as it is.
  useEffect(() => {
    if (!visible) return;
    const run = ++asked.current;
    let live = true;
    const withOthers = !!merged && !!mergedKey;
    const dbs = merged?.dbs ?? [];
    lang.client
      .sqlShape({
        docId: withOthers ? `${source.docId}#diagram` : source.docId,
        text: source.text,
        dialect,
        schemaKey: withOthers ? mergedKey : schemaKey,
        schemaState,
        pos,
      })
      .then((r) => {
        if (!live || run !== asked.current) return;
        if ("kind" in r) {
          setProblem(r);
          // A syntax error keeps the last drawing; anything else clears it.
          if (r.kind !== "syntax") {
            placing.current++;
            drawnJson.current = null;
            setDrawn(null);
          }
        } else {
          setProblem(null);
          place(r, false, dbs);
        }
      })
      .catch(() => {
        // A restarted engine answers the next change.
      });
    return () => {
      live = false;
    };
  }, [lang.client, source.docId, source.text, pos, dialect, schemaKey, schemaState, place, merged, mergedKey, visible]);

  /** A card of a named database: "Loading schema" until the shape was read with that database, then what the shape says. */
  const shownTable = useCallback(
    (t: ShapeTable, dbs: string[]): ShapeCardData => {
      if (t.kind !== "unknown" || !t.schema || !cache || !cid) return { table: t, failed: false };
      const db = named.find((d) => lc(d) === lc(t.schema!));
      if (!db || dbs.includes(db)) return { table: t, failed: false };
      // Try again loads that database again, as a Visual Query card does (V6).
      if (cache.state(cid, db) === "failed") return { table: t, failed: true, onRetry: () => void cache.ensure(cid, db) };
      return { table: { ...t, kind: "table", schemaState: "loading" }, failed: false };
    },
    // `stamp` is the schema cache's change count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [named, cache, cid, stamp],
  );

  // The status slot follows what is drawn.
  const count = drawn ? shapeCount(drawn.shape) : null;
  useEffect(() => {
    latest.current.onStatus?.(count);
  }, [count]);
  useEffect(() => () => latest.current.onStatus?.(null), []);

  // A selected card bands its lines; the Result bands the SELECT list. Rebuilt shapes band again.
  const banded = useRef("[]");
  const one = selected.length === 1 ? selected[0] : null;
  useEffect(() => {
    const shape = drawn?.shape;
    const t = one && shape ? shape.tables.find((x) => x.key === one) : null;
    const ranges: Range[] = !shape || !one ? [] : one === RESULT_ID ? [shape.result.selectRange] : (t?.ranges ?? []);
    const key = JSON.stringify(ranges);
    if (key === banded.current) return;
    banded.current = key;
    latest.current.onBand(ranges);
  }, [one, drawn]);
  // Closing the pane takes its band away.
  useEffect(
    () => () => {
      if (banded.current !== "[]") latest.current.onBand([]);
    },
    [],
  );
  const onSelect = useCallback((ids: string[]) => {
    setSelected((prev) => (prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids));
  }, []);
  // Selecting a card picks the same table in a Visual Query; a rebuild of the same card does not pick it again.
  const shown = useRef(drawn);
  shown.current = drawn;
  useEffect(() => {
    if (!one || one === RESULT_ID) return;
    const t = shown.current?.shape.tables.find((x) => x.key === one);
    if (t) latest.current.onSelectTable?.(t.alias ?? t.name);
  }, [one]);

  // A dropped card keeps its place for the next rebuild, and its lines switch sides if it passed its partner.
  const [moves, setMoves] = useState(0);
  const onMove = useCallback((id: string, x: number, y: number) => {
    places.current = { ...places.current, [id]: { x, y } };
    setMoves((n) => n + 1);
  }, []);
  const onInit = useCallback((i: ReactFlowInstance) => {
    flow.current = i;
  }, []);

  const nodes = useMemo<Node[]>(() => {
    if (!drawn) return [];
    const { shape, positions, dbs } = drawn;
    return [
      ...shape.tables.map((t, i) => ({
        id: t.key,
        type: "shapeCard",
        position: positions[t.key] ?? { x: i * 280, y: 0 },
        data: shownTable(t, dbs),
        initialWidth: QUERY_CARD_WIDTH,
        initialHeight: shapeCardHeight(t),
      })),
      {
        id: RESULT_ID,
        type: "result",
        position: positions[RESULT_ID] ?? { x: shape.tables.length * 280, y: 0 },
        data: { shape },
        initialWidth: RESULT_WIDTH,
        initialHeight: resultHeight(shape),
      },
    ];
  }, [drawn, shownTable]);

  const edges = useMemo<Edge[]>(() => {
    if (!drawn) return [];
    const { shape, positions } = drawn;
    const shown = new Map(shape.tables.map((t) => [t.key, new Map(t.columns.map((c, i) => [c.name, i] as const))]));
    /** A row's handle when the card draws that row, else the card's header. */
    const end = (key: string, column: string | null, side: "s" | "t") => {
      const i = column === null ? undefined : shown.get(key)?.get(column);
      return `${i === undefined ? "card" : rowPort(i)}:${side}`;
    };
    // Sides follow the cards where they are now, dragged ones included.
    const xOf = (key: string) => (places.current[key] ?? positions[key])?.x ?? 0;
    const out: Edge[] = [];
    shape.joins.forEach((j, i) => {
      const pairs = j.ports?.length ? j.ports.map((p) => [p.from.port, p.to.port] as const) : [[null, null] as const];
      pairs.forEach(([a, b], k) => {
        // Each line leaves the left card on its right and enters the right card on its left.
        const ltr = xOf(j.from) <= xOf(j.to);
        const [src, srcCol, dst, dstCol] = ltr ? [j.from, a, j.to, b] : [j.to, b, j.from, a];
        out.push({
          id: `line-${i}-${k}`,
          source: src,
          target: dst,
          sourceHandle: end(src, srcCol, "s"),
          targetHandle: end(dst, dstCol, "t"),
          type: "orthogonal",
          className: `qd-edge qd-edge-${j.kind}`,
          selectable: false,
          data: k === 0 ? { badge: pill(j) } : {},
        });
      });
    });
    shape.result.columns.forEach((c, i) =>
      c.from.forEach((p, k) =>
        out.push({
          id: `lineage-${i}-${k}`,
          source: p.node,
          target: RESULT_ID,
          sourceHandle: end(p.node, p.port, "s"),
          targetHandle: `${resultPort(i)}:t`,
          type: "orthogonal",
          className: "qd-edge qd-edge-lineage",
          selectable: false,
          markerEnd: ARROW_MARKER,
        }),
      ),
    );
    return out;
  }, [drawn, moves]);

  /** The canvas box in canvas units, for Publish's "What's on screen". */
  const onScreen = () => {
    const r = box.current?.getBoundingClientRect();
    const f = flow.current;
    if (r && f && r.width > 0 && r.height > 0) {
      const a = f.screenToFlowPosition({ x: r.x, y: r.y });
      const b = f.screenToFlowPosition({ x: r.x + r.width, y: r.y + r.height });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  };

  const banner =
    problem?.kind === "syntax"
      ? drawn
        ? `${lineMessage(problem)} The diagram shows the last version that could be read.`
        : `The diagram appears once this statement can be read. ${lineMessage(problem)}`
      : null;
  const emptyText =
    problem?.kind === "notRead" ? notReadText(problem.verb) : problem?.kind === "noStatement" ? "Click into a statement to draw it." : null;

  return (
    <section className="query-diagram" aria-label="Query diagram">
      <div className="query-diagram-strip" role="toolbar" aria-label="Query diagram">
        <span className="query-diagram-title">Query diagram</span>
        <span className="chip chip-neutral">
          <Icon name="eye" size={14} />
          Read only
        </span>
        <span className="query-diagram-about">Built from the current statement, table details only, no rows</span>
        <span className="spacer" />
        <button type="button" className="button button-small button-quiet" disabled={!drawn} onClick={() => drawn && place(drawn.shape, true, drawn.dbs)}>
          <Icon name="grid" size={14} />
          Tidy
        </button>
        <button type="button" className="button button-small button-quiet" disabled={!drawn} onClick={() => setPublishAt(onScreen())}>
          <Icon name="image" size={14} />
          Publish
        </button>
        <button type="button" className="icon-button" aria-label="Close diagram" title="Close diagram" onClick={props.onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="query-diagram-body" ref={box}>
        {banner && (
          <div className="qd-banner qd-banner-danger" role="alert">
            <Icon name="alert" size={14} />
            <span>{banner}</span>
          </div>
        )}
        {!banner && drawn?.shape.note && (
          <div className="qd-banner qd-banner-info" role="status">
            <Icon name="info" size={14} />
            <span>{drawn.shape.note}</span>
          </div>
        )}
        {drawn ? (
          <DiagramCanvas
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onSelect={onSelect}
            onMove={onMove}
            onInit={onInit}
          >
            <p className="qd-hint">
              <Icon name="info" size={14} />
              <span>Select a card to find its lines in the SQL.</span>
            </p>
          </DiagramCanvas>
        ) : (
          emptyText && (
            <p className="qd-empty" role="status">
              {emptyText}
            </p>
          )
        )}
      </div>
      {publishAt && drawn && (
        <PublishDialog
          scene={toScene(drawn.shape, { ...drawn.positions, ...places.current })}
          fileName="query diagram"
          selected={selected}
          onScreen={publishAt}
          onClose={() => setPublishAt(null)}
          onSaved={() => setPublishAt(null)}
        />
      )}
    </section>
  );
}
