import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText, saveSavedQuery } from "../api/client";
import type { ConnectionConfig, ConnectionId, GroupId, SavedQuery } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import UnsavedEdits, { designBody, tableBody } from "../components/UnsavedEdits";
import type { QueryTabDoc } from "../query/QueryTab";
import { type AnyTab, type VisualTabDoc, type WorkTab, isUnsaved, objectTabOf, tabKey } from "../shell/tabs";

export interface PendingEditsGuard {
  dirtyKeys: ReadonlySet<string>;
  gridControl(key: string): MutableRefObject<GridControl | null>;
  markDirty(key: string, dirty: boolean): void;
  /** Keeps a value still in a cell editor, then says whether the grid has Pending Edits. */
  isDirty(key: string): boolean;
  /** The keys of every tab that can hold Pending Edits or an unapplied design, of one Connection or all. */
  tableKeys(only?: ConnectionId): string[];
  /** The same tabs of a Group's Connections. */
  groupTableKeys(groupId: GroupId): string[];
  /** Asks Save, Discard or Cancel for each listed grid that has Pending Edits; false when one is cancelled. */
  confirmLeave(keys: string[]): Promise<boolean>;
  leaveAll(): Promise<boolean>;
  /**
   * A tab whose Saved Query text or Visual Query model differs from what was saved (`isUnsaved`)
   * asks Save, Discard or Cancel before it closes (PR22); false when cancelled or the save failed.
   * Every other tab closes at once.
   */
  confirmCloseUnsaved(tab: AnyTab): Promise<boolean>;
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
  /** Saves a Visual Query from the ask; true when it saved. Without it, Save keeps the tab open. */
  saveVisual?(doc: VisualTabDoc): Promise<boolean>;
}): PendingEditsGuard {
  const { tabs, connections, savedQueries } = opts;

  // ---- Pending Edits in table tabs and unapplied designs: ask before they are closed or left ----
  const [dirtyGrids, setDirtyGrids] = useState<ReadonlySet<string>>(new Set());
  const dirtyRef = useRef(dirtyGrids);
  dirtyRef.current = dirtyGrids;
  const gridControls = useRef(new Map<string, MutableRefObject<GridControl | null>>());
  const [leaveAsk, setLeaveAsk] = useState<{
    key: string;
    title: string;
    body: ReactNode;
    production: boolean;
    /** "Apply" for a design tab's unapplied changes. */
    verb: "Save" | "Apply";
    /** A Saved Query's text, not a grid's Pending Edits. */
    doc?: QueryTabDoc;
    /** A saved Visual Query's model. */
    visual?: VisualTabDoc;
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
    const live = new Set(tabs.flatMap((t) => objectTabOf(t)?.key ?? []));
    for (const key of [...gridControls.current.keys()]) if (!live.has(key)) gridControls.current.delete(key);
    setDirtyGrids((s) => {
      const kept = [...s].filter((key) => live.has(key));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [tabs]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tableKeys = (only?: ConnectionId) =>
    tabsRef.current.flatMap((t) => {
      const o = objectTabOf(t);
      return o && (only === undefined || o.connectionId === only) ? [o.key] : [];
    });

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
      const raw = tabsRef.current.find((t) => objectTabOf(t)?.key === key);
      const tab = raw ? objectTabOf(raw) : null;
      if (tab) opts.activate(key);
      const design = raw?.kind === "design";
      const table = tab?.path?.name ?? (design ? "the new table" : "this table");
      const path = tab?.path ? [tab.path.database, tab.path.schema, tab.path.name] : [table];
      const conn = tab ? connections.find((c) => c.id === tab.connectionId) : undefined;
      const production = conn?.production ?? false;
      const count = gridControls.current.get(key)?.current?.pendingCount() ?? 1;
      const connName = conn?.name ?? "this Connection";
      const body = design
        ? designBody(count, table, connName, production)
        : tableBody(count, path.filter(Boolean).join("."), connName, production);
      const title = design ? `Apply changes to ${table}?` : `Save changes to ${table}?`;
      const verb = design ? "Apply" : "Save";
      const ok = await new Promise<boolean>((resolve) =>
        setLeaveAsk({ key, title, body, production, verb, busy: false, resolve }),
      );
      if (!ok) return false;
      markDirty(key, false);
    }
    return true;
  }
  /** A saved tab with unsaved edits (a query's text, a Visual Query's model) asks Save, Discard or Cancel before it closes (PR22). */
  function confirmCloseUnsaved(tab: AnyTab): Promise<boolean> {
    if (!isUnsaved(tab) || (tab.kind !== "query" && tab.kind !== "visual")) return Promise.resolve(true);
    const run = leaveQueue.current.then(() => {
      const doc = tab.doc;
      const q = savedQueries.find((x) => x.id === doc.savedId);
      const day = q ? new Date(q.updatedAtMs).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
      const what = tab.kind === "visual" ? "this Visual Query" : "this Saved Query";
      const body = (
        <span>
          Your edits to {what} are not saved. Discard keeps the version {day ? `saved on ${day}` : "you saved"}.
        </span>
      );
      opts.activate(tabKey(tab));
      return new Promise<boolean>((resolve) =>
        setLeaveAsk({
          key: doc.id,
          title: `Save changes to ${doc.name}?`,
          body,
          production: false,
          verb: "Save",
          ...(tab.kind === "query" ? { doc: tab.doc } : { visual: tab.doc }),
          busy: false,
          resolve,
        }),
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
  /** The table and design tabs of a Group's Connections. */
  const groupTableKeys = (groupId: GroupId) => {
    const ids = new Set(connections.filter((c) => c.groupId === groupId).map((c) => c.id));
    return tabsRef.current.flatMap((t) => {
      const o = objectTabOf(t);
      return o && ids.has(o.connectionId) ? [o.key] : [];
    });
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
        verb={leaveAsk.verb}
        busy={leaveAsk.busy}
        onSave={async () => {
          const ask = leaveAsk;
          setLeaveAsk({ ...ask, busy: true });
          let ok: boolean;
          if (ask.visual) {
            try {
              ok = (await opts.saveVisual?.(ask.visual)) ?? false;
            } catch (e) {
              opts.onError(errorText(e));
              ok = false;
            }
          } else if (ask.doc) {
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
          // Refused while a save or Apply runs: the tab, Group or Connection stays, as on Cancel.
          const ok = leaveAsk.doc || leaveAsk.visual ? true : (gridControl(leaveAsk.key).current?.discard() ?? true);
          setLeaveAsk(null);
          leaveAsk.resolve(ok);
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
    confirmCloseUnsaved,
    dialog,
  };
}
