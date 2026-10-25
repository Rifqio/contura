import { isolateHistory } from "@codemirror/commands";
import { Annotation, type EditorState, type Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { diffLines } from "../assistant/lineDiff";

/** How a suggestion left the editor: written in, dropped, or put aside for a newer one. */
export type SuggestionEnd = "kept" | "discarded" | "replaced";

/**
 * An answer's SQL waiting in the editor (A2): `from` to `to` would become `text`. It shows as a diff in the editor's own
 * lines and the text does not change until it is kept.
 */
export interface Suggestion {
  from: number;
  to: number;
  text: string;
  /** "Replaces lines 2 to 10 of Query 2": said on the bar in the editor. */
  where: string;
  /** "Keep" or "Keep, commented out". */
  keepLabel?: string;
  /** A Keep and Discard bar under the diff, for a suggestion that came from outside the editor (the Ask panel). */
  bar?: boolean;
  /** Moves the keyboard into the editor, so Ctrl+Enter and Esc reach it. */
  focus?: boolean;
  /** `kept` is where the kept text now is. */
  onEnd?(end: SuggestionEnd, kept?: { from: number; to: number }): void;
}

type Shown = Required<Pick<Suggestion, "from" | "to" | "text" | "where" | "keepLabel" | "bar">> & {
  id: number;
  onEnd?: Suggestion["onEnd"];
};

const setSuggestion = StateEffect.define<Shown | null>();
/** Why a transaction ended the suggestion; an edit that runs into it ends it as discarded. */
const ending = Annotation.define<{ how: SuggestionEnd; kept?: { from: number; to: number } }>();

const suggestionField = StateField.define<Shown | null>({
  create: () => null,
  update(v, tr) {
    let next = v;
    if (next && tr.docChanged) {
      // An edit inside the lines it would replace makes the diff stale: it goes.
      next = tr.changes.touchesRange(next.from, next.to)
        ? null
        : { ...next, from: tr.changes.mapPos(next.from, 1), to: tr.changes.mapPos(next.to, -1) };
    }
    for (const e of tr.effects) if (e.is(setSuggestion)) next = e.value;
    return next;
  },
});

/** The text of the lines a suggestion covers: while it is the same, the diff is mapped, not made again (M8). */
function linesKey(state: EditorState, v: Shown): string {
  const doc = state.doc;
  const first = doc.lineAt(Math.min(v.from, doc.length));
  const last = doc.lineAt(Math.min(Math.max(v.to, v.from), doc.length));
  return `${v.id}\u0000${v.from - first.from}\u0000${v.to - first.from}\u0000${doc.sliceString(first.from, last.to)}`;
}

const diffField = StateField.define<{ key: string; deco: DecorationSet }>({
  create: () => ({ key: "", deco: Decoration.none }),
  update(prev, tr) {
    const v = tr.state.field(suggestionField);
    if (!v) return prev.key === "" ? prev : { key: "", deco: Decoration.none };
    const key = linesKey(tr.state, v);
    if (key === prev.key) return tr.docChanged ? { key, deco: prev.deco.map(tr.changes) } : prev;
    return { key, deco: diffDecorations(tr.state, v) };
  },
  provide: (f) => EditorView.decorations.from(f, (x) => x.deco),
});

const delLine = Decoration.line({ class: "cm-suggest-del" });

class AddedLines extends WidgetType {
  constructor(readonly lines: readonly string[]) {
    super();
  }
  eq(other: AddedLines) {
    return other.lines.length === this.lines.length && other.lines.every((l, i) => l === this.lines[i]);
  }
  toDOM() {
    const dom = document.createElement("div");
    dom.className = "cm-suggest-block";
    for (const l of this.lines) {
      const line = document.createElement("div");
      line.className = "cm-suggest-add";
      line.textContent = l;
      dom.append(line);
    }
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

class Bar extends WidgetType {
  constructor(readonly where: string, readonly keepLabel: string) {
    super();
  }
  eq(other: Bar) {
    return other.where === this.where && other.keepLabel === this.keepLabel;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-suggest-bar";
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Suggestion");
    const text = document.createElement("span");
    text.className = "cm-suggest-where";
    text.textContent = `${this.where}. Nothing runs.`;
    const button = (label: string, keys: string, primary: boolean, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "button button-small button-primary" : "button button-small";
      b.append(label);
      const k = document.createElement("kbd");
      k.className = "kbd";
      k.textContent = keys;
      b.append(" ", k);
      // The editor keeps the keyboard while the button is pressed.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", run);
      return b;
    };
    dom.append(
      text,
      button(this.keepLabel, "Ctrl+Enter", true, () => keepSuggestion(view)),
      button("Discard", "Esc", false, () => discardSuggestion(view)),
    );
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

/** Removed lines struck through on the editor's own lines; added lines in a block after the line they follow. */
function diffDecorations(state: EditorState, v: Shown | null): DecorationSet {
  if (!v) return Decoration.none;
  const doc = state.doc;
  const first = doc.lineAt(Math.min(v.from, doc.length));
  const last = doc.lineAt(Math.min(Math.max(v.to, v.from), doc.length));
  const before: string[] = [];
  for (let n = first.number; n <= last.number; n++) before.push(doc.line(n).text);
  const after = (doc.sliceString(first.from, v.from) + v.text + doc.sliceString(v.to, last.to)).split("\n");
  const ranges = [];
  let n = first.number;
  let adds: string[] = [];
  const flush = () => {
    if (adds.length === 0) return;
    const widget = new AddedLines(adds);
    ranges.push(
      n === first.number
        ? Decoration.widget({ widget, block: true, side: -1 }).range(first.from)
        : Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(n - 1).to),
    );
    adds = [];
  };
  for (const op of diffLines(before, after)) {
    if (op.op === "add") {
      adds.push(op.text);
      continue;
    }
    flush();
    if (op.op === "del") ranges.push(delLine.range(doc.line(n).from));
    n++;
  }
  flush();
  if (v.bar) ranges.push(Decoration.widget({ widget: new Bar(v.where, v.keepLabel), block: true, side: 2 }).range(last.to));
  return Decoration.set(ranges, true);
}

const setMark = StateEffect.define<LineMark | null>();
/** The lines an action would replace, or the line it would add below (A3). */
export type LineMark = { from: number; to: number } | { after: number };

const targetLine = Decoration.line({ class: "cm-ai-target" });
const insertAtLine = Decoration.line({ class: "cm-ai-insert-at" });

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue;
      const m = e.value;
      const doc = tr.state.doc;
      const clip = (p: number) => Math.max(0, Math.min(p, doc.length));
      if (!m) next = Decoration.none;
      else if ("after" in m) next = Decoration.set([insertAtLine.range(doc.lineAt(clip(m.after)).from)]);
      else {
        const ranges = [];
        for (let n = doc.lineAt(clip(m.from)).number; n <= doc.lineAt(clip(Math.max(m.to, m.from))).number; n++)
          ranges.push(targetLine.range(doc.line(n).from));
        next = Decoration.set(ranges);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Ranges that follow the text through edits (I2, M2): an Ask's statement, or what its answer kept. */
const setTrack = StateEffect.define<{ id: number; range: { from: number; to: number } | null }>();
const trackField = StateField.define<ReadonlyMap<number, { from: number; to: number }>>({
  create: () => new Map(),
  update(all, tr) {
    let next = all;
    if (tr.docChanged && all.size > 0) {
      const mapped = new Map<number, { from: number; to: number }>();
      for (const [id, r] of all) {
        const from = tr.changes.mapPos(r.from, 1);
        mapped.set(id, { from, to: Math.max(from, tr.changes.mapPos(r.to, -1)) });
      }
      next = mapped;
    }
    for (const e of tr.effects) {
      if (!e.is(setTrack)) continue;
      const copy = new Map(next);
      if (e.value.range) copy.set(e.value.id, e.value.range);
      else copy.delete(e.value.id);
      next = copy;
    }
    return next;
  },
});

let nextTrack = 1;

export function track(view: EditorView, from: number, to: number): number {
  const id = nextTrack++;
  retrack(view, id, from, to);
  return id;
}

export function retrack(view: EditorView, id: number, from: number, to: number) {
  const len = view.state.doc.length;
  const a = Math.max(0, Math.min(from, len));
  view.dispatch({ effects: setTrack.of({ id, range: { from: a, to: Math.max(a, Math.min(to, len)) } }) });
}

export function untrack(view: EditorView, id: number) {
  if (view.state.field(trackField).has(id)) view.dispatch({ effects: setTrack.of({ id, range: null }) });
}

export function tracked(state: EditorState, id: number): { from: number; to: number } | null {
  return state.field(trackField, false)?.get(id) ?? null;
}

/** A view going away ends its waiting suggestion, so whoever showed it stops waiting (M3). */
export function endOnDestroy(view: EditorView) {
  view.state.field(suggestionField, false)?.onEnd?.("discarded");
  forgetObserver(view);
}

/**
 * The inline Ask box's place in the editor (I3): a block under the last line of the statement it is about, after any
 * diff of that statement, as VS Code's inline chat sits in the text. The box itself is drawn into `host` by React.
 */
type Zone = { host: HTMLElement; track: number | null; pos: number };
const setZone = StateEffect.define<Zone | null>();

export class ZoneWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }
  eq(other: ZoneWidget) {
    return other.host === this.host;
  }
  toDOM() {
    return this.host;
  }
  /** The box's height once drawn, else about a question box, so the scroll does not jump when it opens (N6). */
  get estimatedHeight() {
    return this.host.offsetHeight || 160;
  }
  // The box's own fields and keys stay the box's: the editor's keymap never sees them.
  ignoreEvent() {
    return true;
  }
}

const zoneField = StateField.define<Zone | null>({
  create: () => null,
  update(z, tr) {
    let next = z && tr.docChanged ? { ...z, pos: tr.changes.mapPos(z.pos, 1) } : z;
    for (const e of tr.effects) if (e.is(setZone)) next = e.value;
    return next;
  },
  provide: (f) =>
    EditorView.decorations.compute([f, trackField], (state) => {
      const z = state.field(f);
      if (!z) return Decoration.none;
      const t = z.track !== null ? tracked(state, z.track) : null;
      const r = t && t.from < t.to ? t : null;
      const at = Math.min(r ? r.to : z.pos, state.doc.length);
      return Decoration.set([Decoration.widget({ widget: new ZoneWidget(z.host), block: true, side: 3 }).range(state.doc.lineAt(at).to)]);
    }),
});

/** Opens the box's place under the statement (`track`, or `pos` without one) and returns the element to draw into. */
export function openZone(view: EditorView, at: { track: number | null; pos: number }): HTMLElement {
  forgetObserver(view);
  const host = document.createElement("div");
  host.className = "cm-ask-zone";
  host.setAttribute("contenteditable", "false");
  // The box grows as the answer streams: the editor measures its lines again.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => view.requestMeasure());
    ro.observe(host);
    observers.set(host, ro);
  }
  const pos = Math.max(0, Math.min(at.pos, view.state.doc.length));
  view.dispatch({ effects: [setZone.of({ host, track: at.track, pos }), EditorView.scrollIntoView(pos, { y: "nearest" })] });
  return host;
}

export function closeZone(view: EditorView) {
  if (!view.state.field(zoneField, false)) return;
  forgetObserver(view);
  view.dispatch({ effects: setZone.of(null) });
}

/** Disconnects the observer of the box's place now in the editor, if any (N5). */
function forgetObserver(view: EditorView) {
  const z = view.state.field(zoneField, false);
  if (!z) return;
  observers.get(z.host)?.disconnect();
  observers.delete(z.host);
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

let nextId = 1;

/** The suggestion and line marks; `onPending` hears when a suggestion starts or stops waiting. */
export function suggestions(onPending: (pending: boolean) => void): Extension {
  return [
    suggestionField,
    diffField,
    markField,
    trackField,
    zoneField,
    EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) {
        const was = tr.startState.field(suggestionField);
        const now = tr.state.field(suggestionField);
        if (!was || now?.id === was.id) continue;
        const end = tr.annotation(ending);
        const how = end?.how ?? (now ? "replaced" : "discarded");
        if (end?.kept) was.onEnd?.(how, end.kept);
        else was.onEnd?.(how);
      }
      const was = u.startState.field(suggestionField) !== null;
      const now = u.state.field(suggestionField) !== null;
      if (was !== now) onPending(now);
    }),
  ];
}

export function showSuggestion(view: EditorView, s: Suggestion) {
  const len = view.state.doc.length;
  const from = Math.max(0, Math.min(s.from, len));
  const to = Math.max(from, Math.min(s.to, len));
  const shown: Shown = { from, to, text: s.text, where: s.where, keepLabel: s.keepLabel ?? "Keep", bar: s.bar ?? false, id: nextId++, onEnd: s.onEnd };
  view.dispatch({ effects: [setSuggestion.of(shown), EditorView.scrollIntoView(from, { y: "nearest" })] });
  if (s.focus) view.focus();
}

export function pendingSuggestion(state: EditorState): boolean {
  return state.field(suggestionField, false) != null;
}

/** Writes the waiting suggestion in, as one undo step; false when none waits. */
export function keepSuggestion(view: EditorView): boolean {
  const v = view.state.field(suggestionField, false);
  if (!v) return false;
  view.dispatch({
    changes: { from: v.from, to: v.to, insert: v.text },
    effects: setSuggestion.of(null),
    selection: { anchor: v.from + v.text.length },
    annotations: [
      ending.of({ how: "kept", kept: { from: v.from, to: v.from + v.text.length } }),
      isolateHistory.of("full"),
      Transaction.userEvent.of("input.ai"),
    ],
    scrollIntoView: true,
  });
  return true;
}

/** Drops the waiting suggestion; the text and the undo history stay as they are. */
export function discardSuggestion(view: EditorView): boolean {
  if (!view.state.field(suggestionField, false)) return false;
  view.dispatch({ effects: setSuggestion.of(null), annotations: ending.of({ how: "discarded" }) });
  return true;
}

export function markLines(view: EditorView, m: LineMark | null) {
  view.dispatch({ effects: setMark.of(m) });
}
