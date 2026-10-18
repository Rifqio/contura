// The engine's shared kinds: node kinds with their colour tokens, ports and edge kinds.

/** Room for `service` and `external` later (drawn diagrams). */
export type NodeKind = "table" | "view" | "derived" | "result";

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
};
