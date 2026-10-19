// The engine's shared kinds: node kinds with their colour tokens, ports and edge kinds.

/** The kinds a table card draws (schema, query and lineage diagrams). */
export type CardKind = "table" | "view" | "derived" | "result";

/** Drawn diagram kinds (step 6+): data flow, flowchart and cloud. */
export type DrawnKind = "process" | "store" | "external" | "start" | "end" | "step" | "decision" | "io" | "subprocess" | "service";

export type NodeKind = CardKind | DrawnKind;

/** A column row on a node, where an edge starts or ends. */
export interface Port {
  node: string;
  port: string;
}

export type EdgeKind = "fk" | "join" | "joinPending" | "joinCross" | "lineage" | "condition" | "where";

/** The colour token names for each node kind (ADR 0008: tokens only); wrap in `var()` for CSS, or read them for export. */
export const NODE_TOKENS: Record<NodeKind, { fill: string; stroke: string }> = {
  table: { fill: "--c-node-table-fill", stroke: "--c-node-table-stroke" },
  view: { fill: "--c-node-view-fill", stroke: "--c-node-view-stroke" },
  derived: { fill: "--c-node-view-fill", stroke: "--c-node-view-stroke" },
  result: { fill: "--c-node-view-fill", stroke: "--c-node-view-stroke" },
  // Data flow, as frame 6+.2 draws it: a process in the service pair, a store in the datastore pair.
  process: { fill: "--c-node-service-fill", stroke: "--c-node-service-stroke" },
  store: { fill: "--c-node-datastore-fill", stroke: "--c-node-datastore-stroke" },
  external: { fill: "--c-node-external-fill", stroke: "--c-node-external-stroke" },
  // Flowchart (frame 6+.4): neutral start and end pills, the step family, the one amber decision.
  start: { fill: "--c-node-external-fill", stroke: "--c-node-external-stroke" },
  end: { fill: "--c-node-external-fill", stroke: "--c-node-external-stroke" },
  step: { fill: "--c-node-table-fill", stroke: "--c-node-table-stroke" },
  io: { fill: "--c-node-table-fill", stroke: "--c-node-table-stroke" },
  subprocess: { fill: "--c-node-table-fill", stroke: "--c-node-table-stroke" },
  decision: { fill: "--c-node-enum-fill", stroke: "--c-node-enum-stroke" },
  // Cloud: the provider icon sits on --c-node-icon-tile; the pair colours its minimap block and export frame.
  service: { fill: "--c-node-service-fill", stroke: "--c-node-service-stroke" },
};

/** The light tile behind a cloud service icon, in both themes. */
export const ICON_TILE_TOKEN = "--c-node-icon-tile";
