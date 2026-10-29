import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText, saveSavedQuery } from "../api/client";
import type { ConnectionConfig, ConnectionId, GroupId, SavedQuery } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import UnsavedEdits, { designBody, tableBody } from "../components/UnsavedEdits";
import { flowEntry, unsavedFlows } from "../flow/flowRegistry";
import type { QueryTabDoc } from "../query/QueryTab";
import { type AnyTab, type VisualTabDoc, type WorkTab, isUnsaved, objectTabOf, tabKey } from "../shell/tabs";
import { flushColumnOrders } from "../grid/columnOrderStore";

export interface LeaveOpts {
  /** The next ask after the Pending Edits (running jobs); a Discard applies only when it says yes. */
  then?(): Promise<boolean>;
}

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
  /**
   * Asks Save, Discard or Cancel for each listed grid that has Pending Edits; false when one is
   * cancelled. With `then`, a Discard waits: `then` runs once every grid is answered (the jobs ask),
   * and the discards apply only when it says yes, so a later No keeps the edits.
   */
  confirmLeave(keys: string[], opts?: LeaveOpts): Promise<boolean>;
  leaveAll(opts?: LeaveOpts): Promise<boolean>;
  /**
   * A tab whose Saved Query text or Visual Query model differs from what was saved (`isUnsaved`)
   * asks Save, Discard or Cancel before it closes (PR22); false when cancelled or the save failed.
   * Every other tab closes at once.
   */
  confirmCloseUnsaved(tab: AnyTab): Promise<boolean>;
  /**
   * A diagram tab closing: a save still to come or one that failed is written now; when that fails, asks
   * Save (try again), Discard (close without it) or Cancel. False when cancelled or the retry failed.
   */
  confirmCloseFlow(name: string): Promise<boolean>;
  /** The Unsaved Edits dialog while an ask is open, else null. */
  dialog: ReactNode;
}

/** Why a diagram cannot be saved yet while a rename or delete of its file runs. */
const FLOW_HELD = "Contura is still moving or deleting this file. Try again in a moment.";

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
  /**
   * Running jobs (useJobsGuard): quitting while one runs asks after the Pending Edits, and a yes
   * cancels them before the window goes.
   */
  jobsOnClose?: { running(): boolean; confirmStop(): Promise<boolean> };
}): PendingEditsGuard {
  const { tabs, connections, savedQueries } = opts;
  const jobsOnClose = useRef(opts.jobsOnClose);
  jobsOnClose.current = opts.jobsOnClose;

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
    /** A diagram whose save failed, by name. */
    flow?: string;
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
  function confirmLeave(keys: string[], leave?: LeaveOpts): Promise<boolean> {
    // One ask at a time: a later request waits for the open one, then checks again.
    const run = leaveQueue.current.then(() => askLeave(keys, leave));
    leaveQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const leaveQueue = useRef<Promise<void>>(Promise.resolve());

  /** The Discards held back while a `then` ask is still to come, by grid key. */
  const deferred = useRef<string[] | null>(null);

  async function askLeave(keys: string[], leave?: LeaveOpts): Promise<boolean> {
    deferred.current = leave?.then ? [] : null;
    try {
      if (!(await askEach(keys))) return false;
      if (!leave?.then) return true;
      const held = deferred.current ?? [];
      deferred.current = null;
      if (!(await leave.then())) return false;
      let ok = true;
      for (const key of held) {
        if (gridControl(key).current?.discard() ?? true) markDirty(key, false);
        else ok = false;
      }
      return ok;
    } finally {
      deferred.current = null;
    }
  }

  async function askEach(keys: string[]): Promise<boolean> {
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
      if (!deferred.current?.includes(key)) markDirty(key, false);
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
  /** A diagram closing writes what is waiting; a failed write asks before the edits are dropped. */
  function confirmCloseFlow(name: string): Promise<boolean> {
    const run = leaveQueue.current.then(async () => {
      const entry = flowEntry(name);
      if (!entry || entry.save === "saved") return true;
      let ok = false;
      try {
        ok = await entry.flush();
      } catch {
        ok = false;
      }
      if (ok) return true;
      opts.activate(`flow:${name}`);
      const message = flowEntry(name)?.message;
      // A rename or delete of the file holds its writes: say that, not a failure with no reason.
      const body = flowEntry(name)?.isHeld?.() ? (
        <span>
          {FLOW_HELD} Discard closes the diagram without the last changes.
        </span>
      ) : (
        <span>
          {message ? `The last changes could not be saved: ${message}` : "The last changes could not be saved."} Discard closes the diagram
          without them.
        </span>
      );
      return new Promise<boolean>((resolve) =>
        setLeaveAsk({ key: `flow:${name}`, title: `Save changes to ${name}?`, body, production: false, verb: "Save", flow: name, busy: false, resolve }),
      );
    });
    leaveQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const confirmCloseFlowRef = useRef(confirmCloseFlow);
  confirmCloseFlowRef.current = confirmCloseFlow;

  const confirmLeaveRef = useRef(confirmLeave);
  confirmLeaveRef.current = confirmLeave;
  const leaveAll = (leave?: LeaveOpts) => confirmLeave(tableKeys(), leave);
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
          // Column orders still waiting for a run of move keys to pause are written now, and waited for before the
          // window goes.
          const orders = flushColumnOrders();
          const keys = tableKeys();
          const dirty = keys.some(isDirty);
          const jobs = jobsOnClose.current;
          const running = jobs?.running() ?? false;
          const flows = unsavedFlows();
          if (!dirty && !running && flows.length === 0) return orders;
          event.preventDefault();
          // Diagrams save on their own: a save still to come is written (and waited for) before the window goes.
          for (const name of flows) if (!(await confirmCloseFlowRef.current(name))) return;
          // with Pending Edits, the jobs ask comes before any Discard is applied.
          const jobsAsk = running && jobs ? { then: () => jobs.confirmStop() } : undefined;
          if (dirty) {
            if (!(await confirmLeaveRef.current(keys, jobsAsk))) return;
          } else if (jobsAsk && !(await jobsAsk.then())) return;
          await orders;
          await w.destroy();
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
          if (ask.flow) {
            try {
              ok = (await flowEntry(ask.flow)?.flush()) ?? true;
            } catch {
              ok = false;
            }
            if (!ok) {
              const entry = flowEntry(ask.flow);
              opts.onError(entry?.isHeld?.() ? FLOW_HELD : (entry?.message ?? `${ask.flow} could not be saved.`));
            }
          } else if (ask.visual) {
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
          const grid = !leaveAsk.doc && !leaveAsk.visual && !leaveAsk.flow;
          // Discard means discard: the diagram tab writes nothing more, not even when it closes.
          if (leaveAsk.flow) flowEntry(leaveAsk.flow)?.discard?.();
          let ok = true;
          // A Discard waiting for the next ask is held; it applies once that ask says yes.
          if (grid && deferred.current) deferred.current.push(leaveAsk.key);
          else if (grid) ok = gridControl(leaveAsk.key).current?.discard() ?? true;
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
    confirmCloseFlow,
    dialog,
  };
}
