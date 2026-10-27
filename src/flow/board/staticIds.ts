// The id forms of a board's static shapes and frame boxes. A leaf with no imports: the cards (kindEdit, erCanvas) read
// `isStaticId` from here, so they never import boardScene, whose layout imports reach flowNodes and the cards again.
//
// A title may hold any character, NUL and \u0001 included (the parser takes them), so no id form relies on a character
// a title cannot have: each form has its own prefix, and a key with a NUL in it is written with its length.

/** A frame's node id. `\u0000frame:` is a sequence loop box's, never a board frame's. */
export const boardFrameId = (key: string) => `\u0000board:${key}`;
/**
 * The node id of a frame whose title an earlier frame has: by its index, since it has no key of its own (Decision 9).
 * Its own prefix, so no title meets it.
 */
export const duplicateFrameId = (index: number) => `\u0000clash:${index}`;
/**
 * A static frame's shape, group or line id: the frame's key, then the id the live frame would use. The first NUL
 * after the prefix ends the key; a key that has a NUL of its own is written as NUL, its length, a colon, the key.
 */
export const inFrameId = (key: string, id: string) => (key.includes("\u0000") ? `\u0000in:\u0000${key.length}:${key}\u0000${id}` : `\u0000in:${key}\u0000${id}`);
/** The shape, group or line ids of the frame at `index` whose title an earlier frame has. */
export const clashInFrameId = (index: number, id: string) => `\u0000in#${index}\u0000${id}`;
/** A static frame's shape, group or line, or a frame box (any of the four forms above): never the live frame's (Decision 1). */
export const isStaticId = (id: string) => id.startsWith("\u0000in:") || id.startsWith("\u0000in#") || id.startsWith("\u0000board:") || id.startsWith("\u0000clash:");
