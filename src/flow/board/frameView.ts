import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  Prec,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";

/** The shown frame's block of the document: `from` is the start of its header, `to` the end of its last line. */
type Shown = { from: number; to: number; line: number };

/** Show one frame's block; `null` shows the whole document. `line` is the header's 1-based line. */
export const showFrame = StateEffect.define<Shown | null>();

/** Canvas edits and undo edits may touch hidden frames; user edits there are dropped. An edit that appends at the
 *  shown frame's end joins the shown frame (an insert at the end belongs to it), so a caller whose edit should not
 *  join it sends `showFrame` in the same transaction. */
export const canvasEdit = Annotation.define<boolean>();

/** Marks the follow-up selection dispatch after an undo or redo, which must not report a second reveal. */
const followUp = Annotation.define<boolean>();

const shownField = StateField.define<Shown | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showFrame)) return e.value;
    if (!value || !tr.docChanged) return value;
    // An insert at the end belongs to the shown frame; so does one at the header's start.
    const from = tr.changes.mapPos(value.from, -1);
    const to = Math.max(from, tr.changes.mapPos(value.to, 1));
    return { from, to, line: tr.newDoc.lineAt(from).number };
  },
});

/** The shown frame's block in `state`; null when the whole document shows or `frameView` is not installed. */
export function shownRange(state: EditorState): Shown | null {
  return state.field(shownField, false) ?? null;
}

/** The shown range after the transaction's changes and effects, without evaluating the new state. */
function shownAfter(tr: Transaction): Shown | null {
  for (let i = tr.effects.length - 1; i >= 0; i--) {
    const e = tr.effects[i];
    if (e.is(showFrame)) return e.value;
  }
  const value = tr.startState.field(shownField);
  if (!value || !tr.docChanged) return value;
  const from = tr.changes.mapPos(value.from, -1);
  return { from, to: Math.max(from, tr.changes.mapPos(value.to, 1)), line: tr.newDoc.lineAt(from).number };
}

function hiddenRanges(state: EditorState): DecorationSet {
  const shown = state.field(shownField);
  if (!shown) return Decoration.none;
  const ranges = [];
  // Block replaces cover whole lines; the line break next to the shown block stays outside them.
  if (shown.from > 0) ranges.push(Decoration.replace({ block: true }).range(0, shown.from - 1));
  if (shown.to + 1 < state.doc.length) ranges.push(Decoration.replace({ block: true }).range(shown.to + 1, state.doc.length));
  return Decoration.set(ranges);
}

const hiddenField = StateField.define<DecorationSet>({
  create: hiddenRanges,
  update: (value, tr) =>
    tr.docChanged || tr.effects.some((e) => e.is(showFrame)) ? hiddenRanges(tr.state) : value,
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
});

const isHistory = (tr: Transaction) => tr.isUserEvent("undo") || tr.isUserEvent("redo");

/** The first changed position outside the shown range of an undo or redo, or null when it lies inside. */
export function revealTarget(tr: Transaction): number | null {
  if (!tr.docChanged) return null;
  const shown = shownAfter(tr);
  if (!shown) return null;
  let target: number | null = null;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (target !== null) return;
    if (fromB < shown.from || fromB > shown.to) target = fromB;
    else if (toB > shown.to) target = toB;
  });
  return target;
}

const clampTo = (shown: Shown, pos: number) => Math.max(shown.from, Math.min(shown.to, pos));

/** The edit guard; `onDropped` hears of a user edit it dropped (scheduled, never inside the update). */
const guard = (onDropped?: () => void) => EditorState.transactionFilter.of((tr) => {
  const start = tr.startState.field(shownField);
  if (!start) return tr;
  if (tr.docChanged && !tr.annotation(canvasEdit) && !isHistory(tr)) {
    let touches = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA < start.from || toA > start.to) touches = true;
    });
    if (touches) {
      // Backspace at the block's first line or Delete at its end does nothing, silently, as at a document's ends;
      // a real edit dropped (a Replace all, a paste reaching a hidden frame) is told.
      const atEdge = tr.isUserEvent("delete") && tr.startState.selection.ranges.every((r) => r.empty);
      if (onDropped && !atEdge) queueMicrotask(onDropped);
      return [];
    }
  }
  const shown = shownAfter(tr);
  if (!shown) return tr;
  const sel = tr.newSelection;
  if (!tr.selection) {
    // A new range with the selection left in a now hidden frame would drop the next keystroke: move it to the start.
    const moved = tr.effects.some((e) => e.is(showFrame));
    const outside = sel.ranges.some((r) => r.anchor < shown.from || r.head > shown.to || r.head < shown.from || r.anchor > shown.to);
    return moved && outside ? [tr, { selection: EditorSelection.cursor(shown.from), sequential: true } as TransactionSpec] : tr;
  }
  if (sel.ranges.every((r) => r.anchor >= shown.from && r.head <= shown.to && r.head >= shown.from && r.anchor <= shown.to)) return tr;
  // Keyboard and pointer moves stop at the shown block's edges, as at a document's ends.
  if (tr.isUserEvent("select") && !tr.isUserEvent("select.search")) {
    const clamped = EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.range(clampTo(shown, r.anchor), clampTo(shown, r.head))),
      sel.mainIndex,
    );
    return [tr, { selection: clamped, sequential: true } as TransactionSpec];
  }
  return tr;
});

/** Undo and redo are dispatched with `filter: false`, so the guard never sees them: report the reveal here. */
function historyExtender(onReveal: (pos: number) => void): Extension {
  return EditorState.transactionExtender.of((tr) => {
    if (!isHistory(tr)) return null;
    const target = revealTarget(tr);
    if (target !== null) onReveal(target);
    return null;
  });
}

/**
 * `pos` moved into the shown block, as an editor keeps the cursor out of folded text: above it, onto its first body
 * line; below it, onto its last line; the column kept where the line is long enough.
 */
function intoShown(state: EditorState, shown: Shown, pos: number): number {
  if (pos >= shown.from && pos <= shown.to) return pos;
  const header = state.doc.lineAt(shown.from);
  const target = pos < shown.from ? (header.to < shown.to ? state.doc.line(header.number + 1) : header) : state.doc.lineAt(shown.to);
  const col = pos - state.doc.lineAt(pos).from;
  return clampTo(shown, Math.min(target.from + col, target.to));
}

/**
 * Part of `frameView`: an undo or redo whose change lies outside the shown range reveals it, then the selection
 * follows. One whose change lies inside but whose restored selection is in a hidden frame puts the selection back into
 * the shown block (the guard never sees undo and redo, which are dispatched with `filter: false`).
 */
export function historyReveal(onReveal: (pos: number) => void): Extension {
  return [
    historyExtender(onReveal),
    EditorView.updateListener.of((u) => {
      let history = false;
      for (const tr of u.transactions) {
        if (!isHistory(tr)) continue;
        history = true;
        const target = revealTarget(tr);
        if (target === null) continue;
        const view = u.view;
        queueMicrotask(() => {
          const len = view.state.doc.length;
          view.dispatch({ selection: EditorSelection.cursor(Math.min(target, len)), scrollIntoView: true, annotations: followUp.of(true) });
        });
        return;
      }
      if (!history) return;
      const view = u.view;
      // Scheduled (no dispatch inside an update); read again then, as a switch may have come first. The dispatch puts
      // the selection inside, so it does not schedule another.
      queueMicrotask(() => {
        const state = view.state;
        const shown = state.field(shownField, false);
        if (!shown) return;
        const sel = state.selection;
        if (sel.ranges.every((r) => r.from >= shown.from && r.to <= shown.to)) return;
        const ranges = sel.ranges.map((r) => EditorSelection.range(intoShown(state, shown, r.anchor), intoShown(state, shown, r.head)));
        try {
          view.dispatch({ selection: EditorSelection.create(ranges, sel.mainIndex), annotations: followUp.of(true) });
        } catch {
          // The view was destroyed before the microtask ran.
        }
      });
    }),
  ];
}

const shownKeys = keymap.of([
  {
    key: "Mod-a",
    run: (view) => {
      const shown = view.state.field(shownField);
      if (!shown) return false;
      view.dispatch({ selection: EditorSelection.range(shown.from, shown.to), userEvent: "select" });
      return true;
    },
  },
  {
    key: "Mod-End",
    run: (view) => edge(view, "to", false),
    shift: (view) => edge(view, "to", true),
  },
  {
    key: "Mod-Home",
    run: (view) => edge(view, "from", false),
    shift: (view) => edge(view, "from", true),
  },
]);

function edge(view: EditorView, which: "from" | "to", extend: boolean): boolean {
  const shown = view.state.field(shownField);
  if (!shown) return false;
  const pos = shown[which];
  view.dispatch({
    selection: extend ? EditorSelection.range(view.state.selection.main.anchor, pos) : EditorSelection.cursor(pos),
    userEvent: "select",
    scrollIntoView: true,
  });
  return true;
}

/** One document with every frame but the shown one hidden (Decision 14). `onReveal` is called synchronously, inside
 *  the update, so it must not dispatch to this view; it should schedule the `showFrame` dispatch. `onDropped` is told,
 *  after the update, when an edit was dropped because it reached a hidden frame (a Replace all, a Delete at the edge). */
export function frameView(onReveal: (pos: number) => void, onDropped?: () => void): Extension {
  const gutter = new Compartment();
  const numbers = () =>
    lineNumbers({
      formatNumber: (n, state) => {
        const shown = state.field(shownField, false);
        return String(shown ? n - shown.line + 1 : n);
      },
    });
  return [
    shownField,
    hiddenField,
    guard(onDropped),
    historyReveal(onReveal),
    gutter.of(numbers()),
    EditorView.updateListener.of((u) => {
      const before = u.startState.field(shownField);
      const after = u.state.field(shownField);
      // The gutter redraws only when its config changes, so a new first line needs a reconfigure.
      if (before?.line !== after?.line || (before === null) !== (after === null)) {
        queueMicrotask(() => {
          try {
            u.view.dispatch({ effects: gutter.reconfigure(numbers()) });
          } catch {
            // The view was destroyed before the microtask ran.
          }
        });
      }
      if (!after || u.transactions.some((tr) => isHistory(tr) || tr.annotation(followUp))) return;
      const head = u.state.selection.main.head;
      if (u.selectionSet && (head < after.from || head > after.to)) onReveal(head);
    }),
    Prec.high(shownKeys),
  ];
}
