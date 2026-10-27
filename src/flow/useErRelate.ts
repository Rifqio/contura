// B3 Task 7 (decisions 4, 7 and 9; R4, R10, R11, R12): relationships drawn between columns on the board's cards. A drag
// from a column's port, the Relationship tool's press on a row or header (no port needed) or its two clicks, and a
// Shapes line's two clicks all end here, planned by erRelate and written as one worker op (a batch for a reference), in
// the frame the gesture started in, tracked across a switch. The A tool infers the arrow from the keys; a Shapes line
// forces its own (R10). A drop over another frame writes nothing (R12).
//
// Restored from the old FlowTab's `connect` ER branch, `relate`, `reference`, `runPlan`, `relateAt` and the
// `onConnectRelease` ER branch (5478210^, lines 3317 to 3420). It imports the pure planning, the stores' types and the
// leaf ids only: never kindNodes, flowNodes or the board scene, so no cycle runs back through the cards.
//
// B3 Task 9 (5478210^, lines 773 to 868 and 5185 to 5228): "Add relationship to..." (`linking`, draw.io's connect
// mode), "Make a relationship from here" (`pick`, the keyboard's arrows, Tab and Enter, with its window listeners only
// while it is on) and a relationship's end dragged onto a column (`reattachColumn`). The aim the pick shows is the
// store's (`store.set({ aim })`), its places `pickTargets` once per pick and drawing. The pick keeps what it aims by
// table and column, never by place in the list, so a drawing that changes under it (an undo) never moves Enter onto
// a column the ring did not show (Task 9 fix round 1).
import type { Node } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { routeRows } from "../diagram/route";
import type { Port } from "../diagram/types";
import { LINK_NOTES, linkRefOf } from "../lang/flow/edits";
import { type FlowArrow, type FlowDoc, splitRow } from "../lang/flow/model";
import type { FlowRequestOp } from "../lang/flow/service";
import { isStaticId } from "./board/staticIds";
import { EDIT_MESSAGES } from "./editWords";
import type { ErStore } from "./erCanvas";
import { type CardHit, erRefusal, hitRow, isErTable, joinRefusal, keyOf, type PickTarget, pickTargets, planReference, planRelationship, portColumn, RELATE_MESSAGES, type RelatePlan } from "./erRelate";
import type { ErScrollStore } from "./erScroll";
import type { Box, Point } from "./interactions/geometry";
import { erColumnRow, erRowY } from "./kindLayout";
import type { RunResult } from "./useFlowDoc";

export interface ErRelateOptions {
  /** The live frame's parse, to plan on (null while there is none). */
  doc(): FlowDoc | null;
  /** What the canvas draws (the last good parse while the text has an error), to find the card under a point. */
  drawn(): FlowDoc | null;
  run(op: FlowRequestOp, opts: { onRefused(note: string): void; frame: number }): Promise<RunResult | null>;
  /** The live frame's identity now (`doc.frameIdNow()`), so a write lands in the frame its gesture started in (R4). */
  frame(): number;
  /** A write under way: a frame switch waits for it (`trackCommit`). */
  track(p: Promise<unknown>): void;
  /** Bands a written line in the pane (`bandWritten`, decision 14). */
  band(at: number | undefined): void;
  /** The live frame's nodes, in board coordinates (`graphRef.current.nodes`). */
  nodes(): Node[];
  /** The frame under a board point: live or not; null outside every frame (`frameAt` and `staticFrameAt`, R12). */
  frameAt(at: Point): { live: boolean } | null;
  scroll: ErScrollStore;
  store: ErStore;
  stale(): boolean;
  locked(): boolean;
  /** An old-form frame: every drop says `ER_NOTES.oldForm` and writes nothing, before the stale note (Review Focus 4). */
  oldForm?(): boolean;
  notice(text: string | null, written?: boolean): void;
  /** This tab's drawing pane: the pick's keys come from inside it only, or from the page itself (N1). */
  pane?(): HTMLElement | null;
  /** The canvas: the keyboard goes on from it once a pick starts, however its menu item was chosen (fix round 3). */
  canvas?(): HTMLElement | null;
}

/**
 * "Make a relationship from here": the column it starts from, and what the keyboard aims: a column, or a header
 * (`column` null) for its table's key. `at` is -1 with nothing aimed yet, -2 after Enter with nothing aimed, and the
 * aim's place in the pick's list when it was aimed.
 */
export type RelPick = { from: { table: string; column: string }; at: number; aim: { table: string; column: string | null } | null };

/** What a press with the Relationship tool started from: a column of a table, or its header (column null). */
type Press = NonNullable<CardHit>;

const boxOf = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });
const inside = (b: Box, p: Point) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export function useErRelate(o: ErRelateOptions) {
  const opts = useRef(o);
  opts.current = o;
  /** The Relationship tool's press under way, and the first click of a two-click pick. */
  const press = useRef<Press | null>(null);
  const first = useRef<{ from: Press; arrow: FlowArrow | null } | null>(null);
  /** This module aimed a row (the drag's target): only its own aim is let go. */
  const aimed = useRef(false);
  /** "Add relationship to...": the table the next table picked refers to (draw.io's connect mode). */
  const [linking, setLinkingState] = useState<string | null>(null);
  const linkingRef = useRef<string | null>(null);
  /** "Make a relationship from here": it lives as long as its prompt, as "Add relationship to..." does. */
  const [pick, setPickState] = useState<RelPick | null>(null);
  const pickRef = useRef<RelPick | null>(null);
  /** The pick's places for this pick and this drawing (N3): built once, not on every render or key. */
  const places = useRef<{ from: RelPick["from"]; doc: FlowDoc; list: PickTarget[] } | null>(null);

  /** `startPick`'s one frame that focuses the canvas, cancelled when the pick is reset or the tab goes. */
  const focusFrame = useRef<number | null>(null);

  const api = useMemo(() => {
    const cancelFocus = () => {
      if (focusFrame.current === null) return;
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
    };
    const unaim = () => {
      if (!aimed.current) return;
      aimed.current = false;
      opts.current.store.set({ aim: null });
    };
    const endPress = () => {
      press.current = null;
      unaim();
    };

    /** Why nothing may be planned now: the lock, an old-form frame (before the stale note), a text with an error. */
    const refusal = (): string | null => {
      const c = opts.current;
      return erRefusal({ locked: c.locked, oldForm: c.oldForm, stale: () => c.stale() || !c.doc() })?.note ?? null;
    };
    /** The doc to plan on, or null with the reason in the strip. */
    const plannable = (): FlowDoc | null => {
      const why = refusal();
      if (why) opts.current.notice(why);
      return why ? null : opts.current.doc();
    };

    /** A plan's ops as one op, in the frame it started in; the strip says what was made, or the worker's note. */
    const runPlan = async (plan: RelatePlan) => {
      const c = opts.current;
      if ("refuse" in plan) {
        c.notice(plan.refuse);
        return;
      }
      const frame = c.frame();
      let note: string | null = null;
      const op: FlowRequestOp = plan.ops.length === 1 ? plan.ops[0] : { op: "batch", ops: plan.ops };
      const p = c.run(op, { onRefused: (n) => (note = n), frame });
      c.track(p);
      const r = await p;
      // A switch meanwhile: the strip is the other frame's now.
      if (opts.current.frame() !== frame) return;
      if (r) {
        opts.current.notice(plan.message, true);
        opts.current.band(r.at);
      } else opts.current.notice(note ?? EDIT_MESSAGES.changed);
    };

    /** A column's drag let go on `to`: a column joins the two, a header that table's key (decision 4). */
    const relate = async (table: string, column: string, to: { table: string; column: string | null }, arrow?: FlowArrow | null) => {
      const d = plannable();
      if (d) await runPlan(planRelationship(d, { table, column }, to, arrow ?? undefined));
    };

    /** Table `from`'s own port or header let go on table `to`: the key column that refers to `to`, and its line. */
    const reference = async (from: string, to: string, arrow?: FlowArrow | null) => {
      const d = plannable();
      if (d) await runPlan(planReference(d, from, to, arrow ?? undefined));
    };

    /** The live card under board point `at`, and the part of it there (header, row, or null below its rows). */
    const cardAt = (at: Point): { node: Node; box: Box; hit: CardHit } | null => {
      const c = opts.current;
      const d = c.doc() ?? c.drawn();
      const nodes = c.nodes();
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.id.startsWith("\u0000") || isStaticId(n.id)) continue;
        const box = boxOf(n);
        if (!inside(box, at)) continue;
        const t = d?.nodes.find((x) => x.name === n.id && isErTable(x));
        return { node: n, box, hit: t ? hitRow(t, box.y, at.y, c.scroll.get(n.id)) : null };
      }
      return null;
    };

    /**
     * A drag from `table`'s `column` (null: its header) let go at board point `at`: on a row joins that column, on a
     * header that table's key (from a header, the key column that refers to the table let go on); off every card, the
     * port React Flow snapped to stands; over another frame, nothing, decided before any search (R12).
     */
    const relateAt = (table: string, column: string | null, at: Point, snapped: { table: string; column: string } | null = null) => {
      endPress();
      const f = opts.current.frameAt(at);
      if (f && !f.live) return opts.current.notice(RELATE_MESSAGES.otherFrame);
      const card = cardAt(at);
      const hit = card ? card.hit : snapped;
      if (!hit) return opts.current.notice(RELATE_MESSAGES.nowhere);
      if (column === null) return void reference(table, hit.table);
      return void relate(table, column, hit);
    };

    /** Where a column's row (null: the header) meets its card, in board coordinates, as the lines to it are drawn. */
    const rowY = (n: Node, box: Box, column: string | null) => {
      const t = opts.current.drawn()?.nodes.find((x) => x.name === n.id && isErTable(x));
      const row = column === null || !t ? -1 : erColumnRow(t.rows ?? [], column);
      return erRowY(box.y, box.h, row, opts.current.scroll.get(n.id));
    };

    const setLinking = (from: string | null) => {
      linkingRef.current = from;
      setLinkingState(from);
    };
    /** Where the pick can land, worked out once per pick and drawing. */
    const targets = (): PickTarget[] => {
      const p = pickRef.current;
      const d = opts.current.drawn();
      if (!p || !d) return [];
      const c = places.current;
      if (c && c.from === p.from && c.doc === d) return c.list;
      const list = pickTargets(d, p.from);
      places.current = { from: p.from, doc: d, list };
      return list;
    };
    /** Where the pick's aim is in the list as the drawing is now (-1: gone, or nothing aimed). */
    const aimAt = (list: PickTarget[]): number => {
      const a = pickRef.current?.aim;
      return a ? list.findIndex((t) => t.table === a.table && t.column === a.column) : -1;
    };
    /** The pick, and the row or header it aims drawn on the card (the store's aim, its row as the drawing is now). */
    const setPick = (p: RelPick | null) => {
      pickRef.current = p;
      setPickState(p);
      const list = targets();
      const t = list[aimAt(list)];
      if (!t) {
        if (!p) places.current = null;
        return unaim();
      }
      aimed.current = true;
      opts.current.store.set({ aim: { table: t.table, index: t.index } });
    };
    /** Ends "Add relationship to..." and the pick, with nothing written; `clear` takes their prompt from the strip. */
    const endModes = (clear: boolean) => {
      const on = linkingRef.current !== null || pickRef.current !== null;
      if (linkingRef.current !== null) setLinking(null);
      if (pickRef.current !== null) setPick(null);
      if (on && clear) opts.current.notice(null);
    };
    /** The pick lands on a column, or on a table's header or body for its key; the drop's rules make the line. */
    const finishPick = (table: string, column: string | null) => {
      const p = pickRef.current;
      if (!p) return;
      setPick(null);
      void relate(p.from.table, p.from.column, { table, column });
    };
    const isTableName = (name: string) => !!opts.current.drawn()?.nodes.some((n) => n.name === name && isErTable(n));

    /** The pick's keys (fix rounds 3 and 4): arrows or Tab move the aim, Enter picks, Esc leaves. */
    const pickKey = (e: KeyboardEvent) => {
      const p = pickRef.current;
      if (!p || e.ctrlKey || e.metaKey || e.altKey) return;
      const c = opts.current;
      const t = e.target as HTMLElement | null;
      const inPane = !!t && !!c.pane?.()?.contains(t);
      if (!(t === document.body || inPane)) return;
      // A text field or a menu inside the pane keeps its own keys.
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest?.('[role="menu"]'))) return;
      const list = targets();
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey) ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 0;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
        const el = c.canvas?.();
        if (el && document.activeElement !== el) el.focus({ preventScroll: true });
      };
      if (step !== 0 && list.length > 0) {
        take();
        const now = aimAt(list);
        const at = now < 0 ? (step > 0 ? 0 : list.length - 1) : (now + step + list.length) % list.length;
        setPick({ ...p, at, aim: { table: list[at].table, column: list[at].column } });
      } else if (e.key === "Enter") {
        take();
        const to = list[aimAt(list)];
        if (to) finishPick(to.table, to.column);
        // Nothing aimed yet, or what was aimed is gone: the strip says what to do, and the pick stays (N6).
        else setPick({ ...p, at: -2, aim: null });
      } else if (e.key === "Escape") {
        take();
        endModes(true);
      }
    };
    /** Focus going outside the pane (a dialog, the tree, a field elsewhere) ends the pick, as a menu does (N1). */
    const pickFocus = (e: FocusEvent) => {
      const t = e.target;
      if (!pickRef.current || t === document.body || (t instanceof globalThis.Node && !!opts.current.pane?.()?.contains(t)) || (t instanceof Element && t.closest('[role="menu"]'))) return;
      setPick(null);
      opts.current.notice(null);
    };

    return {
      relate,
      reference,
      relateAt,
      pickKey,
      pickFocus,
      targets,

      /** "Add relationship to..." from `table`: the next table picked gets the relationship (its prompt is FlowTab's). */
      startLinking(table: string) {
        first.current = null;
        endPress();
        if (pickRef.current !== null) setPick(null);
        setLinking(table);
      },

      /**
       * A pick on the canvas while "Add relationship to..." is on: another single table gets the relationship (one
       * edit); a pick of anything else ends the mode (draw.io's connect mode). True when the pick made the line.
       */
      pickWhileLinking(ids: readonly string[]): boolean {
        const from = linkingRef.current;
        if (from === null) return false;
        if (ids.length === 1 && ids[0] === from) return false;
        setLinking(null);
        opts.current.notice(null);
        if (ids.length !== 1 || !isTableName(ids[0])) return false;
        void reference(from, ids[0]);
        return true;
      },

      /** "Make a relationship from here" from a column: nothing is aimed until a key is pressed (fix round 3). */
      startPick(from: { table: string; column: string }) {
        first.current = null;
        endPress();
        if (linkingRef.current !== null) setLinking(null);
        setPick({ from, at: -1, aim: null });
        opts.current.notice(RELATE_MESSAGES.pick);
        // The keyboard goes on from the canvas, however the menu was chosen; a pick ended first takes the frame with it.
        cancelFocus();
        focusFrame.current = requestAnimationFrame(() => {
          focusFrame.current = null;
          opts.current.canvas?.()?.focus({ preventScroll: true });
        });
      },

      /** A press on a column (index) or on a table's header or body (null) while a pick is on: true when it took it. */
      interceptPick(table: string, index: number | null): boolean {
        if (!pickRef.current) return false;
        const row = index === null ? undefined : opts.current.drawn()?.nodes.find((n) => n.name === table && isErTable(n))?.rows?.[index];
        finishPick(table, row === undefined ? null : splitRow(row).name);
        return true;
      },

      /** Ends both modes with nothing written; `clear` takes their prompt from the strip. */
      endModes,

      /**
       * The drawing changed under a pick: the ring follows its column to its row now, and an aim whose table or column
       * is gone goes back to nothing aimed, so Enter says to aim first (N6).
       */
      syncPick() {
        const p = pickRef.current;
        if (!p?.aim) return;
        if (aimAt(targets()) < 0) setPick({ ...p, at: -1, aim: null });
        else setPick(p);
      },

      /**
       * Fix round 1 (ruling 5): an ER relationship between columns keeps the rules of a new drop when an end is
       * dragged. On a column it joins that column; on a header, that table's key; a table with no key, or its body
       * below the rows, leaves the end on the whole table and the strip says so. Away from every card it goes back;
       * over another frame nothing is written (R12). True when the line was such a relationship.
       */
      reattachColumn(index: number, end: "from" | "to", at: Point): boolean {
        const c = opts.current;
        const drawnNow = c.drawn();
        const link = drawnNow?.links[index];
        if (!drawnNow || drawnNow.kind !== "er" || !link || (link.fromColumn === undefined && link.toColumn === undefined)) return false;
        const f = c.frameAt(at);
        if (f && !f.live) {
          c.notice(RELATE_MESSAGES.otherFrame);
          return true;
        }
        const card = cardAt(at);
        const t = card ? drawnNow.nodes.find((x) => x.name === card.node.id && isErTable(x)) : undefined;
        if (!card || !t) return true;
        c.notice(null);
        const why = erRefusal({ locked: c.locked, oldForm: c.oldForm, stale: () => c.stale() || !c.doc() }, { stale: LINK_NOTES.broken });
        if (why) {
          c.notice(why.note);
          return true;
        }
        const known = c.doc()!;
        const hit = hitRow(t, card.box.y, at.y, c.scroll.get(t.name));
        let column: string | undefined;
        let whole: string | null = null;
        if (hit && hit.column !== null) column = hit.column;
        else if (hit) {
          const key = keyOf(t);
          if (key) column = key.name;
          else whole = RELATE_MESSAGES.wholeTable(t.name, "key");
        } else whole = RELATE_MESSAGES.wholeTable(t.name, "body");
        const other = end === "from" ? { table: link.to, column: link.toColumn } : { table: link.from, column: link.fromColumn };
        if (column !== undefined && other.column !== undefined) {
          const no = joinRefusal(known, { table: t.name, column }, { table: other.table, column: other.column }, index);
          if (no) {
            c.notice(no);
            return true;
          }
        }
        const ref = linkRefOf(drawnNow.links, index);
        if (!ref) return true;
        const frame = c.frame();
        let note: string | null = null;
        const p = c.run({ op: "setLinkEnd", link: ref, end, node: t.name, ...(column !== undefined ? { column } : {}) }, { onRefused: (n) => (note = n), frame });
        c.track(p);
        void p.then((r) => {
          // A switch meanwhile: the strip is the other frame's now.
          if (opts.current.frame() !== frame) return;
          if (!r) opts.current.notice(note ?? EDIT_MESSAGES.changed);
          else if (whole) opts.current.notice(whole, true);
        });
        return true;
      },

      /** A drag from a column's port dropped on a port: false for a table's own port, so `connect` goes on as today. */
      onPortConnect(from: Port, to: Port, at?: Point): boolean {
        const column = portColumn(from.port);
        if (column === null) return false;
        const target = portColumn(to.port);
        // Where it was let go decides (a row, the header, or nothing), never a port React Flow snapped to from bounds
        // that rows may have scrolled under since (fix round 2, I6). Let go off every card, the port it reached stands.
        if (at) relateAt(from.node, column, at, target !== null ? { table: to.node, column: target } : null);
        else void relate(from.node, column, { table: to.node, column: target });
        return true;
      },

      /** A drag from a column's port let go off every port: false for a table's own port. */
      onPortRelease(from: Port, at: Point): boolean {
        const column = portColumn(from.port);
        if (column === null) return false;
        relateAt(from.node, column, at);
        return true;
      },

      /**
       * The Relationship tool pressed on a row or a header: the drag starts there (decision 9, R11). Where nothing may
       * be written (the lock, an old-form frame, a text with an error) the press says why at once and holds nothing:
       * false (Review Focus 4).
       */
      toolPress(target: CardHit): boolean {
        unaim();
        const why = refusal();
        if (why) opts.current.notice(why);
        press.current = why ? null : target;
        return !why;
      },

      /**
       * The tool's drag at board point `to`: the line from the pressed row (routed square by `routeRows`) to the row or
       * header under the pointer, which is aimed and its card ringed; to the pointer over no card of this frame.
       */
      toolMove(to: Point): { d: string; ring: Box | null } | null {
        const p = press.current;
        const c = opts.current;
        if (!p) return null;
        const src = c.nodes().find((n) => n.id === p.table);
        if (!src) return null;
        const a = boxOf(src);
        const ay = rowY(src, a, p.column);
        const f = c.frameAt(to);
        // Nothing is aimed where the release would be refused, nor on another frame.
        const card = (f && !f.live) || refusal() ? null : cardAt(to);
        if (!card?.hit) {
          unaim();
          return { d: routeRows(a, ay, { x: to.x, y: to.y, w: 0, h: 0 }, to.y).d, ring: null };
        }
        const t = c.drawn()?.nodes.find((x) => x.name === card.node.id && isErTable(x));
        const index = card.hit.column === null || !t ? -1 : erColumnRow(t.rows ?? [], card.hit.column);
        aimed.current = true;
        c.store.set({ aim: { table: card.hit.table, index } });
        const by = rowY(card.node, card.box, card.hit.column);
        return { d: routeRows(a, ay, card.box, by, card.node.id === src.id).d, ring: card.box };
      },

      /**
       * One click of a two-click pick (the A tool, or a Shapes line): the first is kept and false returned; the second
       * plans the line with the arrow (null: inferred from the keys) and true is returned. A column first joins columns;
       * a header first adds the key column that refers to the second table (decision 9). Where nothing may be written,
       * the first click already says why and ends the pick: true (Review Focus 4). `fresh`: the pick's prompt is gone,
       * so this click is a first one whatever was kept.
       */
      toolClick(target: CardHit, arrow: FlowArrow | null, fresh = false): boolean {
        endPress();
        // A first click whose prompt is gone (another notice took its place) is no half of this line (final review).
        if (fresh) first.current = null;
        if (!target) return false;
        const why = refusal();
        if (why) {
          first.current = null;
          opts.current.notice(why);
          return true;
        }
        const f = first.current;
        if (!f) {
          first.current = { from: target, arrow };
          return false;
        }
        first.current = null;
        if (f.from.column === null) void reference(f.from.table, target.table, arrow);
        else void relate(f.from.table, f.from.column, target, arrow);
        return true;
      },

      /**
       * Ends a press, a two-click pick and the aim, and "Add relationship to..." and the keyboard pick with nothing
       * written and their prompt gone: Esc, a frame switch, a pick given up, another tool or pick started.
       */
      reset() {
        first.current = null;
        endPress();
        cancelFocus();
        endModes(true);
      },
    };
  }, []);

  useEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );

  // The pick's keys and focus are taken on the window, before anything else, only while a pick is on (N1, N3).
  const on = pick !== null;
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => api.pickKey(e);
    const focus = (e: FocusEvent) => api.pickFocus(e);
    window.addEventListener("keydown", key, true);
    window.addEventListener("focusin", focus, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("focusin", focus, true);
    };
  }, [on, api]);

  return useMemo(() => ({ ...api, linking, pick }), [api, linking, pick]);
}
