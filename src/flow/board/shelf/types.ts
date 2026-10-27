// The Shelf's shared types (decisions 2 to 6): what can be added from it, what a tab body receives, and the groups
// a search shows on the left side.
import type { DragEvent, KeyboardEvent } from "react";
import type { DiagramKind } from "../../../lang/flow/model";
import type { SketchKind } from "../boardLayout";
import type { ShelfIconHit } from "./iconSource";

/** The drag type a Shelf item travels under; the board's canvas takes only this type (R11). */
export const SHELF_DRAG_TYPE = "application/x-contura-shelf";

/** A loose shape the Shelf offers: B1's own sketch kinds, named by `SKETCH_WORD` (L3). */
export type ShelfSketch = Extract<SketchKind, "rect" | "ellipse" | "diamond" | "note" | "text">;

/** One thing the Shelf adds. */
export type ShelfItem =
  | { kind: "diagram"; diagram: DiagramKind }
  | { kind: "template"; id: string }
  | { kind: "icon"; name: string }
  | { kind: "sketch"; sketch: ShelfSketch }
  | { kind: "shape"; frameKind: DiagramKind; label: string }
  | { kind: "fromDatabase" }
  | { kind: "fromMermaid" };

/** What a tab body gets from the Shelf (Plan C's Icons tab takes the first five). `at` is a board point. */
export interface ShelfTabProps {
  query: string;
  active: boolean;
  /** The body's key handler: the Shelf forwards Up, Down, PageUp, PageDown, Ctrl+Home, Ctrl+End and Enter; true when the body took the key. */
  registerKeys(handler: (e: KeyboardEvent) => boolean): void;
  add(item: ShelfItem, at?: { x: number; y: number }): void;
  beginDrag(item: ShelfItem, e: DragEvent): void;
  /** The id of the body's active option, for the search's `aria-activedescendant`. */
  setActiveDescendant?(id: string | undefined): void;
  frameKind: DiagramKind | null;
  /** The id the body gives its listbox, so the search's `aria-controls` names it. */
  listboxId?: string;
  /** Why an item cannot be added now ("Select shapes first"), or null: it shows disabled, with the reason. */
  disabled?(item: ShelfItem): string | null;
}

/** A group of the left side while searching with no tab pinned (decision 4). */
export type ShelfGroup =
  | { label: "Diagrams"; items: DiagramKind[] }
  | { label: "Icons"; items: readonly ShelfIconHit[]; total: number }
  | { label: "Shapes"; items: ShelfItem[] };
