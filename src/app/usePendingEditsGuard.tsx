import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText, saveSavedQuery } from "../api/client";
import type { ConnectionConfig, ConnectionId, GroupId, SavedQuery } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import UnsavedEdits, { tableBody } from "../components/UnsavedEdits";
import type { QueryTabDoc } from "../query/QueryTab";
import { type WorkTab, tabKey } from "../shell/tabs";

export interface PendingEditsGuard {
  dirtyKeys: ReadonlySet<string>;
  gridControl(key: string): MutableRefObject<GridControl | null>;
  markDirty(key: string, dirty: boolean): void;
  /** Keeps a value still in a cell editor, then says whether the grid has Pending Edits. */
  isDirty(key: string): boolean;
  tableKeys(only?: ConnectionId): string[];
  /** The open tables of a Group's Connections. */
  groupTableKeys(groupId: GroupId): string[];
  /** Asks Save, Discard or Cancel for each listed grid that has Pending Edits; false when one is cancelled. */
  confirmLeave(keys: string[]): Promise<boolean>;
  leaveAll(): Promise<boolean>;
  /** A Saved Query tab with edits asks before it closes (PR22); false when cancelled or the save failed. */
  confirmCloseSaved(doc: QueryTabDoc): Promise<boolean>;
  /** The Unsaved Edits dialog while an ask is open, else null. */
  dialog: ReactNode;
}

export function usePendingEditsGuard(opts: {
  tabs: WorkTab[];
  connections: ConnectionConfig[];
  savedQueries: SavedQuery[];
  /** Shows the tab being asked about (App: setActiveKey). */
  activate(key: string): void;
  /** A Saved Query was saved from the ask (App: reloadSaved). */
  onSavedQuerySaved(): void;
  /** A save from the ask failed (App: setNotice). */
  onError(text: string): void;
}): PendingEditsGuard {
  const { tabs, connections, savedQueries } = opts;

  // ---- Pending Edits in table tabs: ask before they are closed or left ----
  const [dirtyGrids, setDirtyGrids] = useState<ReadonlySet<string>>(new Set());
  const dirtyRef = useRef(dirtyGrids);
  dirtyRef.current = dirtyGrids;
  const gridControls = useRef(new Map<string, MutableRefObject<GridControl | null>>());
  const [leaveAsk, setLeaveAsk] = useState<{
    key: string;
    title: string;
    body: ReactNode;
    production: boolean;
    /** A Saved Query's text, not a grid's Pending Edits. */
    doc?: QueryTabDoc;
    busy: boolean;
    resolve(ok: boolean): void;
  } | null>(null);

  function gridControl(key: string): MutableRefObject<GridControl | null> {
    let ref = gridControls.current.get(key);
    if (!ref) {
      ref = { current: null };
      gridControls.current.set(key, ref);
    }
    return ref;
  }

  function markDirty(key: string, dirty: boolean) {
    setDirtyGrids((s) => {
      if (s.has(key) === dirty) return s;
      const next = new Set(s);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // A removed tab, by any path, takes its dirty mark and its control with it.
  useEffect(() => {
    const live = new Set(tabs.flatMap((t) => (t.kind === "object" ? [t.key] : [])));
    for (const key of [...gridControls.current.keys()]) if (!live.has(key)) gridControls.current.delete(key);
    setDirtyGrids((s) => {
      const kept = [...s].filter((key) => live.has(key));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [tabs]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tableKeys = (only?: ConnectionId) =>
    tabsRef.current.flatMap((t) =>
      t.kind === "object" && (only === undefined || t.selection.connectionId === only) ? [t.key] : [],
    );

  /** Keeps a value still in a cell editor, then says whether the grid has Pending Edits. */
  function isDirty(key: string): boolean {
    const control = gridControls.current.get(key)?.current;
    return control ? control.flush() : dirtyRef.current.has(key);
  }

  /** Asks Save, Discard or Cancel for each listed grid that has Pending Edits; false when one is cancelled. */
  function confirmLeave(keys: string[]): Promise<boolean> {
    // One ask at a time: a later request waits for the open one, then checks again.
    const run = leaveQueue.current.then(() => askLeave(keys));
    leaveQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const leaveQueue = useRef<Promise<void>>(Promise.resolve());

  async function askLeave(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      if (!isDirty(key)) continue;
      const tabs = tabsRef.current;
      const index = tabs.findIndex((t) => t.kind === "object" && t.key === key);
      const tab = tabs[index];
      if (index >= 0) opts.activate(key);
      const table = tab?.kind === "object" ? tab.selection.path.name : "this table";
      const path = tab?.kind === "object" ? [tab.selection.path.database, tab.selection.path.schema, tab.selection.path.name] : [table];
      const conn = tab?.kind === "object" ? connections.find((c) => c.id === tab.selection.connectionId) : undefined;
      const production = conn?.production ?? false;
      const body = tableBody(
        gridControls.current.get(key)?.current?.pendingCount() ?? 1,
        path.filter(Boolean).join("."),
        conn?.name ?? "this Connection",
        production,
      );
      const title = `Save changes to ${table}?`;
      const ok = await new Promise<boolean>((resolve) =>
        setLeaveAsk({ key, title, body, production, busy: false, resolve }),
      );
      if (!ok) return false;
      markDirty(key, false);
    }
    return true;
  }
  /** A Saved Query tab with edits asks Save, Discard or Cancel before it closes (PR22); false when cancelled or the save failed. */
  function confirmCloseSaved(doc: QueryTabDoc): Promise<boolean> {
    if (!doc.savedId || doc.savedText === null || doc.text === doc.savedText) return Promise.resolve(true);
    const run = leaveQueue.current.then(() => {
      const q = savedQueries.find((x) => x.id === doc.savedId);
      const day = q ? new Date(q.updatedAtMs).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
      const body = (
        <span>
          Your edits to this Saved Query are not saved. Discard keeps the version {day ? `saved on ${day}` : "you saved"}.
        </span>
      );
      opts.activate(tabKey({ kind: "query", doc }));
      return new Promise<boolean>((resolve) =>
        setLeaveAsk({ key: doc.id, title: `Save changes to ${doc.name}?`, body, production: false, doc, busy: false, resolve }),
      );
    });
    leaveQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const confirmLeaveRef = useRef(confirmLeave);
  confirmLeaveRef.current = confirmLeave;
  const leaveAll = () => confirmLeave(tableKeys());
  /** The open tables of a Group's Connections. */
  const groupTableKeys = (groupId: GroupId) => {
    const ids = new Set(connections.filter((c) => c.groupId === groupId).map((c) => c.id));
    return tabsRef.current.flatMap((t) => (t.kind === "object" && ids.has(t.selection.connectionId) ? [t.key] : []));
  };

  // Quitting with Pending Edits asks first; the title bar's Close raises this request too.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    // Outside the Tauri window (a plain browser) getCurrentWindow throws, and nothing is watched.
    Promise.resolve()
      .then(() => {
        const w = getCurrentWindow();
        return w.onCloseRequested(async (event) => {
          const keys = tableKeys();
          if (!keys.some(isDirty)) return;
          event.preventDefault();
          if (await confirmLeaveRef.current(keys)) await w.destroy();
        });
      })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const dialog =
    leaveAsk && !leaveAsk.busy ? (
      <UnsavedEdits
        title={leaveAsk.title}
        body={leaveAsk.body}
        production={leaveAsk.production}
        busy={leaveAsk.busy}
        onSave={async () => {
          const ask = leaveAsk;
          setLeaveAsk({ ...ask, busy: true });
          let ok: boolean;
          if (ask.doc) {
            try {
              await saveSavedQuery({ id: ask.doc.savedId, name: ask.doc.name, sql: ask.doc.text });
              opts.onSavedQuerySaved();
              ok = true;
            } catch (e) {
              opts.onError(errorText(e));
              ok = false;
            }
          } else {
            ok = (await gridControl(ask.key).current?.save()) ?? true;
          }
          setLeaveAsk(null);
          ask.resolve(ok);
        }}
        onDiscard={() => {
          if (!leaveAsk.doc) gridControl(leaveAsk.key).current?.discard();
          setLeaveAsk(null);
          leaveAsk.resolve(true);
        }}
        onCancel={() => {
          setLeaveAsk(null);
          leaveAsk.resolve(false);
        }}
      />
    ) : null;

  return {
    dirtyKeys: dirtyGrids,
    gridControl,
    markDirty,
    isDirty,
    tableKeys,
    groupTableKeys,
    confirmLeave,
    leaveAll,
    confirmCloseSaved,
    dialog,
  };
}
