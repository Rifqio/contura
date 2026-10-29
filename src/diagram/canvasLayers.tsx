// React Flow's two portal layers (the line labels' and the viewport's), each looked up once per canvas. React Flow's own
// `EdgeLabelRenderer` and `ViewportPortal` run `domNode.querySelector` as a store selector, so each one drawn walked the
// canvas's DOM on every view change and every measure (with a frame's 300 labelled lines in view, 300
// walks a frame through a zoom, and the viewport layer is the canvas's last element, so its walk passes every node).
import { type ReactFlowState, useStore } from "@xyflow/react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const LABEL_LAYER = ".react-flow__edgelabel-renderer";
const VIEWPORT_LAYER = ".react-flow__viewport-portal";

/**
 * A store selector for one of the canvas's layers: found once and kept while it is in the document; until React Flow
 * has drawn it, each update looks again, as React Flow's own selector does.
 */
function layerOf(selector: string) {
  const kept = new WeakMap<Element, Element>();
  return (s: ReactFlowState): Element | null => {
    const dom = s.domNode;
    if (!dom) return null;
    const was = kept.get(dom);
    if (was?.isConnected) return was;
    const found = dom.querySelector(selector);
    if (found) kept.set(dom, found);
    return found;
  };
}

const labelLayer = layerOf(LABEL_LAYER);
const viewportLayer = layerOf(VIEWPORT_LAYER);

/** React Flow's `EdgeLabelRenderer`, its layer looked up once: a line's label in screen space over the lines. */
export function EdgeLabel({ children }: { children: ReactNode }) {
  const layer = useStore(labelLayer);
  return layer ? createPortal(children, layer) : null;
}

/** React Flow's `ViewportPortal`, its layer looked up once: drawn in flow coordinates over the nodes. */
export function ViewportLayer({ children }: { children: ReactNode }) {
  const layer = useStore(viewportLayer);
  return layer ? createPortal(children, layer) : null;
}
