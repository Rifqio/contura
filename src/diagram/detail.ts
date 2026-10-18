// Level of detail: how much a node draws, by zoom and by node count (ADR 0003 note: full cards cost memory).
import { createContext, useContext } from "react";

export type Detail = "full" | "box" | "block";

/** Below this zoom every card is a 100 x 48 name box. */
export const BOX_BELOW = 0.45;
/** Below this zoom cards are plain blocks in their stroke colour. */
export const BLOCK_BELOW = 0.15;
/** Over this many nodes, fast mode: name boxes at every zoom, straight edges, no ports, no hover. */
export const FAST_OVER = 300;
/** The snap grid is hidden below this zoom (DESIGN-NEXT 10.6). */
export const GRID_FROM = 0.4;

export function detailFor(zoom: number, nodeCount: number): { detail: Detail; fast: boolean } {
  if (nodeCount > FAST_OVER) return { detail: "box", fast: true };
  return { detail: zoom < BLOCK_BELOW ? "block" : zoom < BOX_BELOW ? "box" : "full", fast: false };
}

export const DetailContext = createContext<{ detail: Detail; fast: boolean }>({ detail: "full", fast: false });

/** The level of detail the canvas draws at; nodes outside a canvas draw in full. */
export const useDetail = () => useContext(DetailContext);
