// Diagram step 3 (board DiagramEditInPlace): the edits drawn inside a shape of the newer kinds, CL1's class member
// rows and T1's date fields. One small store holds the open edit; each card reads it through a selector, so only
// the card being edited draws again and 2,000 cards at rest keep nothing (memory is a requirement).
import { useNodeId } from "@xyflow/react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { isStaticId } from "./board/staticIds";
import type { CommitHow } from "./interactions/InlineEdit";

export type KindEdit =
  /** A member being changed, by its place in the class's rows and the text the canvas saw there. */
  | { kind: "member"; node: string; index: number; was: string; error?: string; tries?: number }
  /** A new member row before `at` (or at the end); nothing is written until it is kept. */
  | { kind: "draft"; node: string; at: number; value?: string; error?: string; tries?: number }
  /** A member picked by a press on its row or kept by its edit: drawn picked; Ctrl+Enter copies it, Delete removes it. */
  | { kind: "picked"; node: string; index: number; was: string; error?: string; tries?: number }
  /** An event's date, or a period's two dates. */
  | { kind: "date"; node: string; date?: string; until?: string; error?: string; tries?: number; errorAt?: "from" | "until" };

export interface KindEditApi {
  commitMember(e: KindEdit, value: string, how: CommitHow): void;
  commitDate(e: KindEdit, date: string, until: string | undefined, how: CommitHow): void;
  cancel(e: KindEdit): void;
  /** Read-only (the Assistant holds the text, or a preview): the cards only draw. */
  readOnly: boolean;
}

export interface KindEditStore {
  get(): KindEdit | null;
  set(e: KindEdit | null): void;
  subscribe(fn: () => void): () => void;
}

export function createKindEditStore(): KindEditStore {
  let cur: KindEdit | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(e) {
      if (e === cur) return;
      cur = e;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const KindEditContext = createContext<{ store: KindEditStore; api: KindEditApi } | null>(null);

const NONE = () => () => {};
const nothing = () => null;

/**
 * A shape of a static frame, in every form boardScene's `isStaticId` knows (B3 R1: one list). Static frames are inert:
 * their cards never draw the live frame's edit rows, though their shapes may share its names (two frames with a "User").
 */
export const inStaticFrame = (id: string | null | undefined) => !!id && isStaticId(id);

/** The edit open on `node`, or null; a card draws again only when its own edit changes. Null on a static frame's card. */
export function useKindEdit(node: string): KindEdit | null {
  const ctx = useContext(KindEditContext);
  const live = !inStaticFrame(useNodeId());
  const store = live ? ctx : null;
  return useSyncExternalStore(store ? store.store.subscribe : NONE, store ? () => (store.store.get()?.node === node ? store.store.get() : null) : nothing);
}

export const MEMBER_MESSAGES = {
  needsName: "A member needs a name. Delete removes the row.",
  taken: (member: string, owner: string) => `${member} is already a member of ${owner}.`,
};

export const DATE_MESSAGES = {
  pick: "Pick a date, for example 2026-10-19.",
  pickEnd: "Pick the end date too.",
  endBeforeStart: "The end is before the start: pick a later end date.",
};
