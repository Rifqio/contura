// The Shelf's Shapes tab (decision 11): with a frame selected, that kind's shapes first (each with the .flow line it
// writes), then the loose shapes, B1's own sketches named by `SKETCH_WORD`. Only kind shapes that add a node drag:
// a line, a group or a marker acts on what is selected, so it has no drop point.
import { useMemo } from "react";
import Icon, { type IconName } from "../../../components/Icon";
import Kbd from "../../../components/Kbd";
import type { DiagramKind } from "../../../lang/flow/model";
import { type Shape, shapesOf } from "../../ShapePicker";
import { matchRank } from "../catalog/search";
import { KIND_HEAD } from "../chips";
import { GENERIC_TOOLS, keyOfShape, NOTE_TOOL } from "../kindTools";
import { SKETCH_WORD } from "../sketches";
import { Nothing, ShelfOption, useOptionList } from "./list";
import type { ShelfItem, ShelfSketch, ShelfTabProps } from "./types";

/** The loose shapes' order (spec): their names are `SKETCH_WORD`'s, their icons the drawing tools'. */
const LOOSE: readonly ShelfSketch[] = ["rect", "ellipse", "diamond", "note", "text"];

export const LOOSE_NOTE = "Loose shapes belong to no diagram. The Assistant reads them as notes on the board.";

/** One row of the Shapes list. */
export interface ShapeRow {
  item: ShelfItem;
  label: string;
  icon: IconName;
  /** The .flow line a kind shape writes. */
  code?: string;
  /** A kind shape's key: its kind tool's (`keyOfShape`). */
  key?: string;
  /** What it does, where its line does not say (`Shape.hint`): the option's tip and description when it is not disabled. */
  hint?: string;
  drag: boolean;
}

/** Each kind's shapes, built once (nine kinds at most). */
const kindShapes = new Map<DiagramKind, Shape[]>();
function shapesFor(kind: DiagramKind): Shape[] {
  let s = kindShapes.get(kind);
  if (!s) kindShapes.set(kind, (s = shapesOf(kind)));
  return s;
}

const sketchIcon = (sketch: ShelfSketch): IconName => [...GENERIC_TOOLS, NOTE_TOOL].find((t) => t.id === sketch)?.icon ?? "square";

/** The row for a shape or sketch item. */
export function shapeRow(item: Extract<ShelfItem, { kind: "shape" | "sketch" }>): ShapeRow {
  if (item.kind === "sketch") return { item, label: SKETCH_WORD[item.sketch], icon: sketchIcon(item.sketch), drag: true };
  const sh = shapesFor(item.frameKind).find((s) => s.label === item.label);
  return { item, label: item.label, icon: sh?.icon ?? "square", code: sh?.code, key: sh && keyOfShape(item.frameKind, sh), hint: sh?.hint, drag: sh?.act.kind === "node" };
}

/** The rows whose name matches `query`, best rank first, list order within a rank (decision 4). */
function matching(rows: ShapeRow[], query: string): ShapeRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows
    .map((row, at) => ({ row, at, rank: matchRank(row.label.toLowerCase(), q) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((r) => r.row);
}

/** The frame kind's rows and the loose rows that match `query`. */
export function shapeRows(query: string, frameKind: DiagramKind | null): { kind: ShapeRow[]; loose: ShapeRow[] } {
  const kind = frameKind ? shapesFor(frameKind).map((s) => shapeRow({ kind: "shape", frameKind, label: s.label })) : [];
  const loose = LOOSE.map((sketch) => shapeRow({ kind: "sketch", sketch }));
  return { kind: matching(kind, query), loose: matching(loose, query) };
}

/** How many shapes match: the Shapes tab's count. */
export function shapeCount(query: string, frameKind: DiagramKind | null): number {
  const { kind, loose } = shapeRows(query, frameKind);
  return kind.length + loose.length;
}

/** The id of a row's .flow line, its option's description: `codeId(optionId)`. */
export const codeId = (optionId: string) => `${optionId}c`;

/** Whether a row shows its .flow line (it is not disabled and writes one): its option is described by it. */
export const showsCode = (row: ShapeRow, why?: string | null) => !why && !!row.code;

/** A shape's row content: its icon, its name and, for a kind shape, its .flow line (`id`) and its key. */
export function ShapeRowBody({ row, why, id }: { row: ShapeRow; why?: string | null; id: string }) {
  return (
    <>
      <Icon name={row.icon} size={16} />
      <span className="flow-shelf-row-name">{row.label}</span>
      {why ? (
        <span className="flow-shelf-why">{why}</span>
      ) : (
        row.code && (
          <code id={codeId(id)} className="flow-shelf-code">
            {row.code}
          </code>
        )
      )}
      {row.key && <Kbd keys={row.key} />}
    </>
  );
}

export default function ShapesTab({ query, registerKeys, add, beginDrag, setActiveDescendant, listboxId, frameKind, disabled }: ShelfTabProps) {
  const { kind, loose } = useMemo(() => shapeRows(query, frameKind), [query, frameKind]);
  const rows = useMemo(() => [...kind, ...loose], [kind, loose]);
  const { active, optionId } = useOptionList({
    n: rows.length,
    reset: `${frameKind}:${query}`,
    registerKeys,
    setActiveDescendant,
    pick: (i) => add(rows[i].item),
  });
  if (rows.length === 0) return <Nothing query={query} />;
  const option = (row: ShapeRow, i: number, why = disabled?.(row.item) ?? null) => (
    <ShelfOption
      key={`${row.item.kind}:${row.label}`}
      id={optionId(i)}
      active={i === active}
      label={row.label}
      item={row.item}
      drag={row.drag}
      className="flow-shelf-row"
      add={add}
      beginDrag={beginDrag}
      disabled={why}
      title={row.hint}
      description={row.hint}
      describedBy={showsCode(row, why) ? codeId(optionId(i)) : undefined}
    >
      <ShapeRowBody row={row} why={why} id={optionId(i)} />
    </ShelfOption>
  );
  return (
    <>
      <div id={listboxId} role="listbox" aria-label="Shapes" className="flow-shelf-rows">
        {kind.length > 0 && frameKind && (
          <div role="group" aria-label={`${KIND_HEAD[frameKind].name} shapes`}>
            <div className="flow-shelf-heading" aria-hidden="true">{`${KIND_HEAD[frameKind].name} shapes`}</div>
            {kind.map((row, i) => option(row, i))}
          </div>
        )}
        {loose.length > 0 && (
          <div role="group" aria-label="Loose shapes">
            <div className="flow-shelf-heading" aria-hidden="true">
              Loose shapes
            </div>
            {loose.map((row, i) => option(row, kind.length + i))}
          </div>
        )}
      </div>
      {loose.length > 0 && <p className="flow-shelf-note">{LOOSE_NOTE}</p>}
    </>
  );
}
