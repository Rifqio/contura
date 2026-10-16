/** CodeMirror measures text ranges to scroll a selection into view; jsdom has no layout. */
export function mockEditorDom() {
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  const rect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getClientRects = empty;
  Range.prototype.getBoundingClientRect = rect;
}
