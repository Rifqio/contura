// The label font hook: a shape or label drawn at another text size carries its scale as `--text-scale`
// with this class, and flow-board.css sizes the type tokens inside it from that. One module, so flowNodes and kindNodes
// (which flowNodes imports) share it without a cycle.

export const TEXT_SCALED = "is-text-scaled";

/** A label's class suffix and style for its scale; nothing at 1 or unset. */
export function labelScale(scale: number | undefined): { cls: string; style: Record<string, number> } {
  return scale !== undefined && scale !== 1 ? { cls: ` ${TEXT_SCALED}`, style: { "--text-scale": scale } } : { cls: "", style: {} };
}

/**
 * A frame's text size from its label scale: the board's TEXT_SCALE (s 0.88, m 1, l 1.15) read
 * back. Mirrored here, as the cards import this leaf and not the board's layout; textFar.test checks the two agree.
 */
export function textSizeOf(scale: number | undefined): "s" | "m" | "l" {
  return scale === 0.88 ? "s" : scale === 1.15 ? "l" : "m";
}

/** The class flow-board.css fades far text by: every shape, ER card body and line label of a frame carries it. */
export const textSizeClass = (scale: number | undefined) => `board-ts-${textSizeOf(scale)}`;
