// One diagram's document: its text in CodeMirror, the worker's parse of it, the layout file and the save.
// Canvas actions become text edits planned by the worker on one exact parse (rulings P5 and P8): the request
// names the parse's version, a stale answer is planned again on the next parse, and an answer is applied only
// if the editor still holds the very document it was planned on. Every edit list is one CodeMirror transaction,
// and a move is an entry of its own in the same history, so one undo covers text and canvas.
import { history, invertedEffects, isolateHistory } from "@codemirror/commands";
import { Compartment, EditorState, type Extension, StateEffect, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, readDiagram, writeDiagram, writeDiagramLayout } from "../api/client";
import type { Positions } from "../diagram/layout";
import type { LangClient } from "../lang/client";
import type { FlowRequestOp, FlowResult, TextEdit } from "../lang/protocol";
import type { DiagramKind, FlowDoc } from "../lang/flow/model";
import type { FlowSpan } from "../lang/flow/parse";
import { type FlowHandle, type FlowHold, registerFlow, registerOrphanFailure } from "./flowRegistry";
import { emptyPositions, type FlowDirection, type FlowLayout, parseFlowLayout, serializeFlowLayout } from "./layout";
import type { NodeLook } from "./nodes/parts";

/** Saves wait this long after the last change (text or layout). */
export const SAVE_DELAY_MS = 400;
/** A canvas action is planned again at most this many times when the text keeps changing under it. */
const PLAN_TRIES = 4;
/** How long an action waits for the next parse before giving up. */
const NEXT_PARSE_MS = 2000;

/** Node positions before and after a move; undo applies the inverse. */
export const moveEffect = StateEffect.define<{ before: Positions; after: Positions }>();

/** The newest parse and the text it was made from. */
export interface Parsed {
  result: FlowResult;
  text: string;
  /** What the canvas draws: this parse's doc, else the last good one (faded). */
  drawn: FlowDoc | null;
  /** The line of the first error, for the banner; null when the text has none. */
  errorLine: number | null;
}

export type SaveState = { kind: "saved" } | { kind: "waiting" } | { kind: "failed"; message: string };

export interface RunOptions {
  /** Plan only on this parse version; a newer text refuses the action instead of planning it again. */
  version?: number;
  /** Node positions written in the same transaction as the edits. */
  move?: Positions;
}

/** What a canvas action did: the name an add used, and where its first new line starts in the new text. */
export interface RunResult {
  name?: string;
  /** The offset of the start of the first line the edits wrote. */
  at?: number;
}

/** Nodes an undo or redo moves: `from` where they are drawn now, `to` where they go. */
export interface HistoryMove {
  from: Positions;
  to: Positions;
  undo: boolean;
}

const KIND_LINE = /^﻿?[ \t]*diagram[ \t]+(dfd|flow|cloud)\b/;

/** The diagram kind from the first line, read without a parse, so the layout defaults are right from the start. */
export function kindOfText(text: string): DiagramKind | null {
  return (KIND_LINE.exec(text)?.[1] as DiagramKind | undefined) ?? null;
}

export interface FlowDocApi {
  docId: string;
  /** The text as read from disk; null until it is. */
  initialText: string | null;
  /** Why the diagram could not be read. */
  readError: string | null;
  parsed: Parsed | null;
  layout: FlowLayout;
  save: SaveState;
  /** The editor's extensions for this document: the history, the move entries and the change listener. */
  extensions: Extension[];
  /** The editor view, once the editor made it. */
  attach(view: EditorView | null): void;
  view(): EditorView | null;
  /**
   * A canvas action as text edits: resolves to the name an add used, or null when it does not apply. With
   * `version` it is planned on that parse only and never planned again on a newer text (an action that names a
   * link by its index). `move` goes in the same transaction, so the text change and the move are one undo entry.
   */
  run(op: FlowRequestOp, opts?: RunOptions): Promise<RunResult | null>;
  /** Spans of `keys` in the text of parse `version`; null when that is no longer the current text. */
  spans(version: number, keys: string[]): Promise<Record<string, FlowSpan | null> | null>;
  /** The edits a canvas action would make to the current text, without making them; null when it does not apply. */
  plan(op: FlowRequestOp): Promise<{ edits: TextEdit[]; text: string } | null>;
  /** The parse of the text the editor holds now, once it has arrived; null when it does not (closed, or a timeout). */
  current(): Promise<Parsed | null>;
  /** Called when undo or redo moves nodes: where they are and where they go (ruling P8: moves share the history). */
  onHistoryMove(fn: (move: HistoryMove) => void): () => void;
  /** Applies a fix's edits when the text is still the one its parse was made from. */
  applyFix(edits: TextEdit[], parsedText: string): boolean;
  /** Moves nodes: writes only the layout, as one undo entry. */
  move(after: Positions): void;
  /** Positions for nodes that had none (placed by the layout engine, or a node just added); not an undo entry. `override` replaces kept ones. */
  place(positions: Positions, override?: boolean): void;
  setStyle(style: NodeLook): void;
  setDirection(direction: FlowDirection): void;
  /** Item 21: a node resized on the canvas: its new box (a left or top handle moves it too); kept in the layout file. */
  resize(name: string, box: { x: number; y: number; w: number; h: number }): void;
  /** The 1-based line each name is defined on in the current text, or null when the text has changed since. */
  linesOf(names: string[]): Promise<Record<string, number | null> | null>;
  /** Parses the editor's text again, as when the worker learns something new (the icon names). */
  reparse(): void;
}

/** What one save writes: the layout file always, the text only when `textEdited`. */
interface Payload {
  text: string;
  textEdited: boolean;
  layout: string;
  edited: number;
}

/** A move, Classic or the direction writes only the layout file; the .flow is written after a text edit only. */
function writeFiles(name: string, p: Payload): Promise<void> {
  return p.textEdited ? writeDiagram(name, p.text, p.layout, true) : writeDiagramLayout(name, p.layout);
}

/** True for a text whose every line break is CRLF: it is saved with CRLF again after an edit. */
function isCrlf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

export function useFlowDoc(name: string, client: LangClient): FlowDocApi {
  const docId = `flow:${name}`;
  const [initialText, setInitialText] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [layout, setLayoutState] = useState<FlowLayout>(() => parseFlowLayout(null, null));
  const [save, setSaveState] = useState<SaveState>({ kind: "saved" });

  const viewRef = useRef<EditorView | null>(null);
  const layoutRef = useRef(layout);
  /** The editor's text (LF), for a save after the view is gone. */
  const textRef = useRef<string | null>(null);
  /** The file's text as it was read or last saved; a save writes the text only after a text edit (P24 I1). */
  const diskText = useRef<string | null>(null);
  /** Counts text edits; while it equals the count at the last text save, a save writes only the layout file. */
  const edits = useRef(0);
  const savedEdits = useRef(0);
  const crlf = useRef(false);
  /** The newest parse, with the number of the call whose text it was made from. */
  const parsedRef = useRef<(Parsed & { call: number }) | null>(null);
  const calls = useRef(0);
  /** Actions waiting for the next parse; closing the tab lets them go at once. */
  const waiters = useRef(new Map<() => void, () => void>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);
  const saveRef = useRef<SaveState>(save);
  const alive = useRef(true);
  /** This tab's entry in the window's list; updates after it closed go nowhere (ruling P17). */
  const handle = useRef<FlowHandle | null>(null);
  /** The user chose Discard: nothing more is written for this tab. */
  const discarded = useRef(false);
  const historyMoves = useRef(new Set<(move: HistoryMove) => void>());
  /** Writes are held (a delete or rename of the file is on its way); a save that comes due waits for the release. */
  const held = useRef(0);
  const dueWhileHeld = useRef(false);
  /** What a tab that closed while held still has to write; written on the release (ruling P21). */
  const deferred = useRef<Payload | null>(null);
  /** The writes on their way; a hold settles once every one has landed. */
  const inflight = useRef(new Set<Promise<boolean>>());
  /** Read-only while a rename runs (ruling P21). */
  const readOnlyRef = useRef(new Compartment());

  const setLayout = useCallback((next: FlowLayout) => {
    layoutRef.current = next;
    setLayoutState(next);
  }, []);

  const setSave = useCallback(
    (next: SaveState) => {
      saveRef.current = next;
      if (alive.current) setSaveState(next);
      handle.current?.update({ save: next.kind, message: next.kind === "failed" ? next.message : undefined });
    },
    [name],
  );

  /** What a save writes now: the layout file, and the text when it was edited since; null before the file was read. */
  const payload = useCallback((): Payload | null => {
    const edited = edits.current;
    const current = viewRef.current?.state.doc.toString() ?? textRef.current;
    // Not edited since it was read or saved: the text is what the file had (Save a copy as copies it), and a save
    // leaves the .flow alone, so an edit made outside Contura meanwhile survives a move (P24 I1).
    const textEdited = edited !== savedEdits.current;
    const text = !textEdited ? diskText.current : current !== null && crlf.current ? current.replace(/\n/g, "\r\n") : current;
    if (text === null) return null;
    // While the text is clean, positions of names it no longer has are left out of the file (memory keeps them
    // for undo); while it has an error every position is kept, so a node added meanwhile keeps its place.
    const cur = parsedRef.current;
    const l = layoutRef.current;
    let nodes = l.nodes;
    if (cur?.result.doc) {
      nodes = emptyPositions();
      for (const n of cur.result.doc.nodes) if (Object.prototype.hasOwnProperty.call(l.nodes, n.name)) nodes[n.name] = l.nodes[n.name];
    }
    // Sizes follow the same rule as positions.
    let sizes = l.sizes;
    if (cur?.result.doc && sizes) {
      const kept: Record<string, { w: number; h: number }> = {};
      for (const n of cur.result.doc.nodes) if (Object.prototype.hasOwnProperty.call(sizes, n.name)) kept[n.name] = sizes[n.name];
      sizes = kept;
    }
    return { text, textEdited, layout: serializeFlowLayout({ ...l, nodes, sizes }), edited };
  }, []);

  /** Writes the layout now, with the text when it was edited; true once it is on disk. */
  const writeNow = useCallback((): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (discarded.current) return Promise.resolve(true);
    if (held.current > 0) {
      dueWhileHeld.current = true;
      return Promise.resolve(false);
    }
    const p = payload();
    if (p === null) return Promise.resolve(false);
    const { text, edited } = p;
    const seq = ++saveSeq.current;
    const write = writeFiles(name, p).then(
      () => {
        if (p.textEdited) {
          diskText.current = text;
          savedEdits.current = edited;
        }
        if (seq === saveSeq.current && !saveTimer.current) setSave({ kind: "saved" });
        return true;
      },
      (e) => {
        if (seq === saveSeq.current) setSave({ kind: "failed", message: errorText(e) });
        return false;
      },
    );
    inflight.current.add(write);
    void write.then(() => {
      inflight.current.delete(write);
    });
    return write;
  }, [name, setSave, payload]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (discarded.current) return;
    if (held.current > 0) dueWhileHeld.current = true;
    else saveTimer.current = setTimeout(() => void writeNow(), SAVE_DELAY_MS);
    setSave({ kind: "waiting" });
  }, [writeNow, setSave]);

  const parse = useCallback(
    (text: string) => {
      const call = ++calls.current;
      client.flow(docId, text).then(
        (result) => {
          if (!alive.current) return;
          const cur = parsedRef.current;
          // Every call waiting on one parse resolves with it: the newest of those calls holds the parsed text.
          if (cur && (result.version < cur.result.version || (result.version === cur.result.version && call < cur.call))) return;
          const drawn = result.doc ?? result.lastValid ?? cur?.drawn ?? null;
          const firstError = result.problems.find((p) => p.severity === "error");
          const next = { result, text, drawn, errorLine: result.doc ? null : (firstError?.line ?? null), call };
          parsedRef.current = next;
          setParsed(next);
          handle.current?.update({ errors: result.problems.filter((p) => p.severity === "error").length });
          for (const check of [...waiters.current.keys()]) check();
        },
        () => {
          // The diagram closed, or the engine restarted (which parses again): nothing to do.
        },
      );
    },
    [client, docId, name],
  );

  /** Resolves once a parse newer than `version` has arrived (at once when it already has), after a while, or on close. */
  const nextParse = useCallback((version: number) => {
    return new Promise<void>((resolve) => {
      if ((parsedRef.current?.result.version ?? -1) > version) return resolve();
      const finish = () => {
        clearTimeout(timer);
        waiters.current.delete(check);
        resolve();
      };
      const check = () => {
        if ((parsedRef.current?.result.version ?? -1) > version) finish();
      };
      const timer = setTimeout(finish, NEXT_PARSE_MS);
      waiters.current.set(check, finish);
    });
  }, []);

  const applyPositions = useCallback(
    (after: Positions) => {
      const nodes = emptyPositions();
      Object.assign(nodes, layoutRef.current.nodes);
      for (const k of Object.keys(after)) nodes[k] = after[k];
      setLayout({ ...layoutRef.current, nodes });
      scheduleSave();
    },
    [setLayout, scheduleSave],
  );

  // Read the files; the tab joins the window's list of diagrams (unsaved mark, status bar, close guard).
  // Closing the tab writes a save still to come or one that failed, then frees the worker's state for it.
  useEffect(() => {
    alive.current = true;
    client.openFlow(docId);
    discarded.current = false;
    // Writes until nothing is due: a save that comes due while a write runs is written before it says done.
    const flush = async () => {
      for (let i = 0; i < 8; i++) {
        if (discarded.current || (saveRef.current.kind === "saved" && !saveTimer.current)) return true;
        if (!(await writeNow())) return false;
      }
      return saveRef.current.kind === "saved" && !saveTimer.current;
    };
    const discard = () => {
      discarded.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
    const setReadOnly = (on: boolean) =>
      viewRef.current?.dispatch({ effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(on)) });
    const hold = (opts?: { readOnly?: boolean }): FlowHold => {
      held.current++;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        dueWhileHeld.current = true;
      }
      if (opts?.readOnly) setReadOnly(true);
      let released = false;
      const release = (() => {
        if (released) return;
        released = true;
        held.current--;
        if (opts?.readOnly && alive.current) setReadOnly(false);
        if (held.current > 0) return;
        if (alive.current) {
          if (dueWhileHeld.current) {
            dueWhileHeld.current = false;
            scheduleSave();
          }
        } else if (deferred.current && !discarded.current) {
          // The tab closed while held: what it still had to write goes now.
          const d = deferred.current;
          deferred.current = null;
          // No tab is left to mark: a failure joins the window's list as a failed save (the close guard asks).
          const retry = () => writeFiles(name, d).then(
            () => null,
            (e: unknown) => errorText(e),
          );
          void retry().then((failed) => {
            if (failed !== null) registerOrphanFailure(name, failed, retry);
          });
        }
      }) as FlowHold;
      // A write already on its way lands before the holder goes on.
      release.settled = Promise.all([...inflight.current]).then(() => {});
      return release;
    };
    const snapshot = () => {
      const p = payload();
      return p && { text: p.text, layout: p.layout };
    };
    const unregister = registerFlow(name, {
      save: saveRef.current.kind,
      line: null,
      col: null,
      errors: 0,
      flush,
      discard,
      isDiscarded: () => discarded.current,
      isHeld: () => held.current > 0,
      snapshot,
      hold,
    });
    handle.current = unregister;
    readDiagram(name).then(
      (files) => {
        if (!alive.current) return;
        diskText.current = files.text;
        crlf.current = isCrlf(files.text);
        textRef.current = files.text.replace(/\r\n?/g, "\n");
        setLayout(parseFlowLayout(files.layout, kindOfText(files.text)));
        setInitialText(files.text);
      },
      (e) => {
        if (alive.current) setReadError(errorText(e));
      },
    );
    // A restarted worker numbers its parses from 1 again and has lost this text: start over with it.
    const offRestart = client.onRestart(() => {
      if (!alive.current) return;
      const cur = parsedRef.current;
      if (cur) parsedRef.current = { ...cur, result: { ...cur.result, version: 0 }, call: 0 };
      client.openFlow(docId);
      const view = viewRef.current;
      if (view) parse(view.state.doc.toString());
    });
    return () => {
      alive.current = false;
      offRestart();
      // A save still to come or one that failed is written, unless the user chose Discard.
      if (!discarded.current && (saveTimer.current || saveRef.current.kind !== "saved")) {
        // Held (a delete or rename is on its way): the write is kept for the release instead.
        if (held.current > 0) deferred.current = payload();
        else void writeNow();
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      for (const finish of [...waiters.current.values()]) finish();
      waiters.current.clear();
      unregister();
      handle.current = null;
      client.closeFlow(docId);
      parsedRef.current = null;
    };
  }, [client, docId, name, parse, setLayout, writeNow, scheduleSave, payload]);

  const extensions = useMemo<Extension[]>(
    () => [
      readOnlyRef.current.of(EditorState.readOnly.of(false)),
      history(),
      // Undoing a move moves the nodes back; redo moves them again.
      invertedEffects.of((tr) =>
        tr.effects.filter((e) => e.is(moveEffect)).map((e) => moveEffect.of({ before: e.value.after, after: e.value.before })),
      ),
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          const undoing = tr.isUserEvent("undo");
          for (const e of tr.effects) {
            if (!e.is(moveEffect)) continue;
            if (undoing || tr.isUserEvent("redo")) for (const fn of historyMoves.current) fn({ from: e.value.before, to: e.value.after, undo: undoing });
            applyPositions(e.value.after);
          }
        }
        if (u.docChanged) {
          const text = u.state.doc.toString();
          textRef.current = text;
          edits.current++;
          parse(text);
          scheduleSave();
        }
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          handle.current?.update({ line: line.number, col: head - line.from + 1 });
        }
      }),
    ],
    [applyPositions, parse, scheduleSave, name],
  );

  const attach = useCallback(
    (view: EditorView | null) => {
      viewRef.current = view;
      if (!view) return;
      parse(view.state.doc.toString());
      handle.current?.update({ line: 1, col: 1 });
    },
    [parse, name],
  );

  /** One edit list as one transaction, and one undo entry of its own. */
  /** Where each named node is now, for the `before` of a move. */
  const positionsOf = useCallback((keys: string[]) => {
    const before = emptyPositions();
    for (const k of keys) {
      const p = Object.prototype.hasOwnProperty.call(layoutRef.current.nodes, k) ? layoutRef.current.nodes[k] : undefined;
      if (p) before[k] = p;
    }
    return before;
  }, []);

  const dispatchEdits = useCallback(
    (view: EditorView, edits: TextEdit[], move?: Positions) => {
      const effects = move && Object.keys(move).length > 0 ? [moveEffect.of({ before: positionsOf(Object.keys(move)), after: move })] : [];
      view.dispatch({
        changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
        effects,
        userEvent: "input.canvas",
        annotations: isolateHistory.of("full"),
      });
    },
    [positionsOf],
  );

  const run = useCallback(
    async (op: FlowRequestOp, opts: RunOptions = {}): Promise<RunResult | null> => {
      for (let i = 0; i < PLAN_TRIES; i++) {
        const view = viewRef.current;
        const cur = parsedRef.current;
        if (!view || !cur || !alive.current) return null;
        if (opts.version !== undefined && cur.result.version !== opts.version) return null;
        // The document object the plan is made on: an answer applies only while the editor still holds it.
        const planned: Text = view.state.doc;
        let answer;
        try {
          answer = await client.flowEdit(docId, cur.result.version, op);
        } catch {
          return null;
        }
        if (answer.stale || viewRef.current !== view || view.state.doc !== planned || cur.text !== planned.toString()) {
          // Planned on one exact version: a newer text may mean something else by it, so it is not planned again.
          if (opts.version !== undefined) return null;
          await nextParse(cur.result.version);
          continue;
        }
        // An empty list: the action does not apply to this text (a taken name, an unknown node).
        if (answer.edits.length === 0) return null;
        dispatchEdits(view, answer.edits, opts.move);
        // The first written line: past the line breaks and indent the insert starts with.
        const first = answer.edits[0];
        const lead = first.insert.length - first.insert.replace(/^[\s]+/, "").length;
        const at = view.state.doc.lineAt(Math.min(first.from + lead, view.state.doc.length)).from;
        return answer.name === undefined ? { at } : { name: answer.name, at };
      }
      return null;
    },
    [client, docId, dispatchEdits, nextParse],
  );

  const current = useCallback(async (): Promise<Parsed | null> => {
    for (let i = 0; i < PLAN_TRIES; i++) {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || !alive.current) return null;
      if (cur.text === view.state.doc.toString()) return cur;
      await nextParse(cur.result.version);
    }
    return null;
  }, [nextParse]);

  const spans = useCallback(
    async (version: number, keys: string[]) => {
      try {
        const r = await client.flowSpans(docId, version, keys, []);
        return r.stale ? null : r.spans;
      } catch {
        return null;
      }
    },
    [client, docId],
  );

  const plan = useCallback(
    async (op: FlowRequestOp) => {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || cur.text !== view.state.doc.toString()) return null;
      try {
        const answer = await client.flowEdit(docId, cur.result.version, op);
        return answer.stale || answer.edits.length === 0 ? null : { edits: answer.edits, text: cur.text };
      } catch {
        return null;
      }
    },
    [client, docId],
  );

  const onHistoryMove = useCallback((fn: (move: HistoryMove) => void) => {
    historyMoves.current.add(fn);
    return () => {
      historyMoves.current.delete(fn);
    };
  }, []);

  const applyFix = useCallback(
    (edits: TextEdit[], parsedText: string) => {
      const view = viewRef.current;
      if (!view || edits.length === 0 || view.state.doc.toString() !== parsedText) return false;
      dispatchEdits(view, edits);
      return true;
    },
    [dispatchEdits],
  );

  const move = useCallback(
    (after: Positions) => {
      const keys = Object.keys(after);
      if (keys.length === 0) return;
      const before = positionsOf(keys);
      const view = viewRef.current;
      if (view) view.dispatch({ effects: moveEffect.of({ before, after }), annotations: isolateHistory.of("full") });
      else applyPositions(after);
    },
    [applyPositions, positionsOf],
  );

  const place = useCallback(
    (positions: Positions, override = false) => {
      const nodes = emptyPositions();
      if (override) Object.assign(nodes, layoutRef.current.nodes, positions);
      else Object.assign(nodes, positions, layoutRef.current.nodes);
      setLayout({ ...layoutRef.current, nodes });
    },
    [setLayout],
  );

  const setStyle = useCallback(
    (style: NodeLook) => {
      if (style === layoutRef.current.style) return;
      setLayout({ ...layoutRef.current, style });
      scheduleSave();
    },
    [setLayout, scheduleSave],
  );

  const resize = useCallback(
    (name: string, box: { x: number; y: number; w: number; h: number }) => {
      const l = layoutRef.current;
      const nodes = emptyPositions();
      Object.assign(nodes, l.nodes, { [name]: { x: box.x, y: box.y } });
      const sizes = Object.assign(Object.create(null) as Record<string, { w: number; h: number }>, l.sizes, { [name]: { w: box.w, h: box.h } });
      setLayout({ ...l, nodes, sizes });
      scheduleSave();
    },
    [setLayout, scheduleSave],
  );

  const setDirection = useCallback(
    (direction: FlowDirection) => {
      if (direction === layoutRef.current.direction) return;
      setLayout({ ...layoutRef.current, direction });
      scheduleSave();
    },
    [setLayout, scheduleSave],
  );

  const linesOf = useCallback(
    async (names: string[]) => {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || cur.text !== view.state.doc.toString()) return null;
      try {
        const r = await client.flowSpans(docId, cur.result.version, [], names);
        return r.stale ? null : r.lineOf;
      } catch {
        return null;
      }
    },
    [client, docId],
  );

  const reparse = useCallback(() => {
    const view = viewRef.current;
    if (view && alive.current) parse(view.state.doc.toString());
  }, [parse]);

  return {
    docId,
    initialText,
    readError,
    parsed,
    layout,
    save,
    extensions,
    attach,
    view: () => viewRef.current,
    run,
    current,
    spans,
    plan,
    onHistoryMove,
    applyFix,
    move,
    place,
    setStyle,
    resize,
    setDirection,
    linesOf,
    reparse,
  };
}
