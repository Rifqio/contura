// The label font hook (Decision 22): a shape or label drawn at another text size carries its scale as `--text-scale`
// with this class, and flow-board.css sizes the type tokens inside it from that. One module, so flowNodes and kindNodes
// (which flowNodes imports) share it without a cycle.

export const TEXT_SCALED = "is-text-scaled";

/** A label's class suffix and style for its scale; nothing at 1 or unset. */
export function labelScale(scale: number | undefined): { cls: string; style: Record<string, number> } {
  return scale !== undefined && scale !== 1 ? { cls: ` ${TEXT_SCALED}`, style: { "--text-scale": scale } } : { cls: "", style: {} };
}
