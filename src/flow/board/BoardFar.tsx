// Which text sizes are far on the board (Plan F Decisions 2 to 4): FlowTab provides the set, changed only when the zoom
// crosses a size's readable line. CSS fades shape labels and line labels by the canvas wrapper's `data-far`; only an ER
// card's body reads this, to draw its rows as bars (Decision 3). A leaf: the cards import it without a cycle.
import { createContext, useContext } from "react";
import type { TextSize } from "./boardLayout";

const NONE: ReadonlySet<TextSize> = new Set();

export const BoardFarContext = createContext<ReadonlySet<TextSize>>(NONE);

/** Whether text of this size is far: drawn as soft lines. */
export function useTextFar(size: TextSize): boolean {
  return useContext(BoardFarContext).has(size);
}
