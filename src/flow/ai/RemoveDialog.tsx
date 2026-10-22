// "Remove <n> shapes and <m> lines?" (board 11.5, ask): a proposal that removes more than 3 shapes always asks
// first, in either mode. The answer row above it names what goes; the card says why it asks.
import { plural } from "../../format/plural";

interface Props {
  shapes: string[];
  lines: number;
  /** The removed shapes that link to a table. */
  tables: string[];
  /** How many shapes the proposal adds. */
  adds: number;
  onCancel(): void;
  onReview(): void;
  onRemove(): void;
}

/** "a", "a and b", "a, b and c". */
const joined = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const what = (shapes: number, lines: number) => `${plural(shapes, "shape", "shapes")} and ${plural(lines, "line", "lines")}`;

export default function RemoveDialog({ shapes, lines, tables, adds, onCancel, onReview, onRemove }: Props) {
  const row = `This would remove ${what(shapes.length, lines)}: ${joined(shapes)}.${adds > 0 ? ` Then I'd draw ${plural(adds, "new shape", "new shapes")}.` : ""}`;
  const why = `Removing more than 3 shapes always asks, even with Auto-apply on.${tables.length > 0 ? ` The links from ${joined(tables)} to their tables go too.` : ""}`;
  return (
    <>
      <p className="answer-p">{row}</p>
      <div className="ccard warnc" role="group" aria-label={`Remove ${what(shapes.length, lines)}?`}>
        <div className="ccard-ask">{`Remove ${what(shapes.length, lines)}?`}</div>
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
