// "Remove <n> shapes and <m> lines?" (board 11.5, ask): a proposal that removes more than 3 shapes and ER columns,
// summed across a board's frames, always asks first, in either mode. The answer row above it
// names what goes and, on a board, the diagrams it goes from; the card says why it asks.
import { plural } from "../../format/plural";

interface Props {
  shapes: string[];
  /** The removed ER columns, as `table.column`. */
  columns: string[];
  lines: number;
  /** The removed shapes that link to a table. */
  tables: string[];
  /** How many shapes the proposal adds. */
  adds: number;
  /** The diagrams the removals are in, named on a board of several; empty names none. */
  frames: string[];
  onCancel(): void;
  onReview(): void;
  onRemove(): void;
}

/** "a", "a and b", "a, b and c". */
const joined = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** "4 shapes, 1 column and 6 lines": the parts that are removed, shapes when nothing else is. */
function what(shapes: number, columns: number, lines: number): string {
  const parts = [
    ...(shapes > 0 || columns === 0 ? [plural(shapes, "shape", "shapes")] : []),
    ...(columns > 0 ? [plural(columns, "column", "columns")] : []),
    ...(lines > 0 || (shapes > 0 && columns === 0) ? [plural(lines, "line", "lines")] : []),
  ];
  return joined(parts);
}

export default function RemoveDialog({ shapes, columns, lines, tables, adds, frames, onCancel, onReview, onRemove }: Props) {
  const parts = what(shapes.length, columns.length, lines);
  const where = frames.length > 0 ? ` in ${joined(frames)}` : "";
  const row = `This would remove ${parts}${where}: ${joined([...shapes, ...columns])}.${adds > 0 ? ` Then I'd draw ${plural(adds, "new shape", "new shapes")}.` : ""}`;
  const counted = columns.length > 0 ? "shapes and columns" : "shapes";
  const why = `Removing more than 3 ${counted} always asks, even with Auto-apply on.${tables.length > 0 ? ` The links from ${joined(tables)} to their tables go too.` : ""}`;
  return (
    <>
      <p className="answer-p">{row}</p>
      <div className="ccard warnc" role="group" aria-label={`Remove ${parts}?`}>
        <div className="ccard-ask">{`Remove ${parts}?`}</div>
        <div className="ccard-why">{why}</div>
        <div className="ccard-foot end">
          <button type="button" className="btn pbtn2" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn pbtn2" onClick={onReview}>
            Review each change
          </button>
          <button type="button" className="btn pbtn2 dng" onClick={onRemove}>
            {adds > 0 ? "Remove and redraw" : "Remove"}
          </button>
        </div>
      </div>
    </>
  );
}
