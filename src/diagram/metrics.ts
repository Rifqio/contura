// Diagram sizes in px: layout, canvas CSS and exports all use these (app.css `.table-card*` repeats the card ones).

/** The table card of the Schema Builder and Visual Query (frame 6.1). */
export const CARD_WIDTH = 216;
export const CARD_HEADER = 32;
export const CARD_ROW = 24;
/** Below the rows: the column list's 4 px padding top and bottom (the card has no Add column row). */
export const CARD_FOOTER = 8;
export const cardHeight = (rows: number) => CARD_HEADER + CARD_ROW * rows + CARD_FOOTER;

/** The name box a card draws as when zoomed out. */
export const BOX_WIDTH = 100;
export const BOX_HEIGHT = 48;

/** Query diagram cards and its Result node (frame 6.2, ruling D1). */
export const QUERY_CARD_WIDTH = 200;
export const RESULT_WIDTH = 268;
