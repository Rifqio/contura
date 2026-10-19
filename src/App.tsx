import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { errorText, forgetRecent, listConnections, listDiagrams, listGroups, setLastGroup, tableDesign } from "./api/client";
import type { ConnectionConfig, ConnectionId, DiagramEntry, Group, GroupId, JobId, ObjectPath, RecentItem, SavedQuery } from "./api/types";
import { useJobsGuard } from "./app/useJobsGuard";
import { useDiagramFileActions } from "./flow/diagramFileActions";
import { focusFlowText } from "./flow/focusFlowText";
import MermaidImportDialog from "./flow/MermaidImportDialog";
import NewDiagramSheet from "./flow/NewDiagramSheet";
import ExportDialog from "./jobs/ExportDialog";
import { type ExportOrigin, originFromJob } from "./jobs/exportText";
import ImportTab from "./jobs/ImportTab";
import LineageTab from "./lineage/LineageTab";
import type { ImportTarget } from "./jobs/importModel";
import JobStatusItem from "./jobs/JobStatusItem";
import { JobsProvider, useJobs } from "./jobs/useJobs";
import DataGrid from "./components/DataGrid";
import { GroupImagesProvider, useGroupImageCache } from "./components/GroupBadge";
import GroupSwitcher, { menuPlaces } from "./components/GroupSwitcher";
import { ToastProvider, useToast } from "./components/Toast";
import StatusBar from "./components/StatusBar";
import { version } from "../package.json";
import { assistantContextFor, assistantTargetFor } from "./app/assistantContext";
import { statusScreenFor } from "./app/statusScreen";
import { useConnectionLifecycle } from "./app/useConnectionLifecycle";
import { connectionActions } from "./app/connectionActions";
import { usePendingEditsGuard } from "./app/usePendingEditsGuard";
import StartupFailed from "./app/StartupFailed";
import DefinitionView from "./app/DefinitionView";
import { newId } from "./app/ids";
import PlaceSidebar from "./app/PlaceSidebar";
import WindowPanes from "./app/WindowPanes";
import { FormDialogs, StartModelDialog, type Form, type ModelStart } from "./app/WorkspaceDialogs";
import { usePlaceDrafts } from "./app/usePlaceDrafts";
import { answerText, useQueryTabRefs } from "./app/queryTabRefs";
import { useAskKit } from "./app/useAskKit";
import { useDataFolder } from "./app/useDataFolder";
import { useSavedQueries } from "./app/useSavedQueries";
import { useStartup } from "./app/useStartup";
import { openRecentItem } from "./app/openRecent";
import { placeOf } from "./app/places";
import { useRecentList } from "./app/useRecentList";
import { useTableDrop } from "./app/useTableDrop";
import { useWorkspaceTabs } from "./app/useWorkspaceTabs";
import LaunchScreen from "./components/LaunchScreen";
import TabStrip from "./components/TabStrip";
import TitleBar from "./components/TitleBar";
import WorkEmpty from "./components/WorkEmpty";
import AssistantPanel from "./assistant/AssistantPanel";
import TableDesigner from "./design/TableDesigner";
import { appLang } from "./lang/appLang";
import { schemaKey } from "./lang/sql/schemaCache";
import { nextQueryName, placeKey } from "./query/drafts";
import HistoryPanel from "./query/HistoryPanel";
import QueryTab, { type QueryTabDoc } from "./query/QueryTab";
import SavedQueriesList from "./query/SavedQueriesList";
import { sourceConnectionFor } from "./schema/sourceConnection";
import type { ModelDoc } from "./schema/SchemaBuilder";
import {
  type Place,
  type Selection,
  type SettingsSection,
  type VisualTabDoc,
  type WindowTab,
  type WorkTab,
  designKey,
  importKey,
  lineageKey,
  newDesignKey,
  objectTabOf,
  tabConnectionId,
  tabKey,
} from "./shell/tabs";
import { NEW_VISUAL_NAME, savedVisualModel } from "./visualquery/drafts";
import { emptyQuery } from "./visualquery/model";
import VisualQueryTab, { type VisualTabControl } from "./visualquery/VisualQueryTab";
import { useTheme } from "./theme/useTheme";
import { KeymapProvider, useCommandKeys } from "./commands/useCommandKeys";
import { PrefsProvider } from "./prefs/usePrefs";
import { objectKey } from "./objectPath";
import OneTree from "./sidebar/OneTree";
import { useTreeData } from "./sidebar/useTreeData";

/** The one prefs holder and the one command registry, around the whole app. */
export default function App() {
  return (
    <PrefsProvider>
      <KeymapProvider>
        <ToastProvider>
          <JobsProvider>
            <Workspace />
          </JobsProvider>
        </ToastProvider>
      </KeymapProvider>
    </PrefsProvider>
  );
}

function Workspace() {
  const toast = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const groupImages = useGroupImageCache(groups);
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [place, setPlace] = useState<Place>({ kind: "ungrouped" });
  // One language worker and one schema index for every query tab, for the app's lifetime.
  const lang = appLang();
  const jobs = useJobs();
  const jobsGuard = useJobsGuard({ jobs, connections });
  const { openIds, versions, openStatus, setStatus, openTracked, markOpened, markClosed, lost } = useConnectionLifecycle({
    connections,
    onClosed: (id) => {
      lang.schemas.dropConnection(id);
      removeTabs(
        (t) => objectTabOf(t)?.connectionId === id || ((t.kind === "import" || t.kind === "lineage") && t.connectionId === id),
      );
    },
    onLost: () => setNotice("That Connection is not open any more. Open it again to continue."),
  });
  const [activeId, setActiveId] = useState<ConnectionId | null>(null);
  /** The branch of the focused tree row while the tree has focus; the status bar follows it (D16). */
  const [treeBranch, setTreeBranch] = useState<ConnectionId | null>(null);
  const {
    tabs,
    windowTabs,
    activeKey,
    allTabs,
    setTabs,
    setWindowTabs,
    setActiveKey,
    tabsRef,
    lastPlaceKey,
    removeTabs,
    closeKey,
    showHome,
    showPlace,
    openSavedDoc,
    openVisualDoc,
    openSchemaTab,
    openFlowTab,
    renameFlowTab,
    schemaClose,
    schemaCloseFor,
  } = useWorkspaceTabs();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { recent, openedTimes, load: loadRecent, record } = useRecentList();
  /** Query History shows every Connection instead of the tab's (from Home's Show all history). */
  const [historyAll, setHistoryAll] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [form, setForm] = useState<Form>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const { savedQueries, load: loadSaved, reloadSaved, savedOne } = useSavedQueries({ setTabs, onError: setNotice });
  const [modelStart, setModelStart] = useState<ModelStart | null>(null);
  /** Set at startup in the last Group: Home opens if the Group restores no tabs (PR6). */
  const homeIfEmpty = useRef(false);
  const refs = useQueryTabRefs();
  const [reveal, setReveal] = useState<{
    connectionId: ConnectionId;
    database: string;
    schema: string | null;
    name: string;
    seq: number;
  } | null>(null);
  // The one tree's load state, kept here so table tabs can read row estimates from it.
  const tree = useTreeData({ connections, openIds, onNotOpen: (id) => lost(id), onRevealed: () => setReveal(null) });
  useEffect(() => {
    if (reveal) tree.reveal(reveal);
    // Once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);
  const { startup, step, startedAt, retry } = useStartup({
    loaded: ({ groups: g, connections: c, first }) => {
      setGroups(g);
      setConnections(c);
      placeNow.current = first;
      setPlace(first);
      homeIfEmpty.current = first.kind === "group";
      setWindowTabs(first.kind === "group" ? [] : [{ kind: "home" }]);
      setActiveKey(first.kind === "group" ? null : "home");
    },
    always: () => {
      loadSaved();
      loadRecent();
    },
  });

  const drafts = usePlaceDrafts({
    place,
    tabs,
    ready: startup.s === "ready",
    onRestored: (docs, visual, order) => {
      // Back in the strip order they were saved in; a draft without one keeps its kind's order.
      const at = (t: WorkTab) => {
        const i = order.indexOf(tabKey(t));
        return i < 0 ? order.length : i;
      };
      const restored = [
        ...docs.map((doc): WorkTab => ({ kind: "query", doc })),
        ...visual.map((doc): WorkTab => ({ kind: "visual", doc })),
      ]
        .map((t, i) => ({ t, i }))
        .sort((a, b) => at(a.t) - at(b.t) || a.i - b.i)
        .map((x) => x.t);
      if (restored.length > 0) {
        setTabs((t) => [...restored, ...t]);
        setActiveKey((k) => k ?? tabKey(restored[0]));
      }
      if (homeIfEmpty.current) {
        homeIfEmpty.current = false;
        // A tab you opened meanwhile stays active.
        if (restored.length === 0) showHome(true);
      }
    },
  });
  const { placeNow, visit, whenDraftsLoaded } = drafts;

  // A Connection moved to another Group leaves this place: drop it as the active one and close its tables.
  useEffect(() => {
    const here = place.kind === "group" ? place.groupId : null;
    const isHere = (id: ConnectionId) => connections.some((c) => c.id === id && c.groupId === here);
    if (activeId !== null && !isHere(activeId)) setActiveId(null);
    const away = (t: WorkTab) => {
      const o = objectTabOf(t);
      // Import and lineage tabs leave with their Connection too (its delete and move asked first).
      return (!!o && !isHere(o.connectionId)) || ((t.kind === "import" || t.kind === "lineage") && !isHere(t.connectionId));
    };
    if (tabs.some(away)) removeTabs(away);
  }, [connections, place, activeId, tabs]);

  const { dirtyKeys, gridControl, markDirty, isDirty, tableKeys, groupTableKeys, confirmLeave, leaveAll, confirmCloseUnsaved, confirmCloseFlow, dialog: leaveDialog } =
    usePendingEditsGuard({
      tabs,
      connections,
      savedQueries,
      activate: setActiveKey,
      onSavedQuerySaved: reloadSaved,
      onError: setNotice,
      // The tab is mounted (hidden or not) and knows its SQL: it saves itself.
      saveVisual: (doc) => visualControl(doc.id).current?.save() ?? Promise.resolve(false),
      // Q22: quitting while a job runs asks, and a yes cancels the jobs before the window goes.
      jobsOnClose: { running: jobsGuard.running, confirmStop: () => jobsGuard.confirmStop() },
    });
  /** Home's ask about Pending Edits: each table shows while it is asked about, then Home comes back. */
  async function askFromHome(keys: string[], then?: () => Promise<boolean>): Promise<boolean> {
    if (!keys.some(isDirty)) return then ? then() : true;
    // With `then` (a move's running imports), a Discard waits for its answer.
    const ok = await confirmLeave(keys, then ? { then } : undefined);
    showHome();
    return ok;
  }

  /** Edit Connection from any path: saving the form closes the Connection's session, so its grids' edits are asked about first. */
  async function editConnection(c: ConnectionConfig) {
    // Its running jobs are asked about when the form saves (Q43), since saving ends them.
    if (await confirmLeave(tableKeys(c.id))) setForm({ kind: "connection", connection: c });
  }

  // ---- Export dialog, Import tabs and New flow from Mermaid (step 7) ----
  /** The open Export dialog: its Connection and origin, or a running job it shows again (`attach`). */
  const [exporting, setExporting] = useState<{
    connectionId: ConnectionId;
    origin: ExportOrigin;
    attach?: JobId;
    seq: number;
  } | null>(null);
  /** The origin each export job was started from, so the status bar can open its dialog again. */
  const exportOrigins = useRef(new Map<JobId, { connectionId: ConnectionId; origin: ExportOrigin }>());
  const [mermaidOpen, setMermaidOpen] = useState(false);
  /** The job each Import tab started last, by tab key (its `onJob`). */
  const [importJobs, setImportJobs] = useState<ReadonlyMap<string, JobId>>(new Map());
  const importJobsRef = useRef(importJobs);
  importJobsRef.current = importJobs;
  const jobsNow = useRef(jobs.jobs);
  jobsNow.current = jobs.jobs;

  function openExport(connectionId: ConnectionId, origin: ExportOrigin) {
    setExporting((e) => ({ connectionId, origin, seq: (e?.seq ?? 0) + 1 }));
  }

  // A job the open dialog starts is tied to its origin, for Run in the background and the status bar.
  useEffect(() => {
    if (exporting && !exporting.attach) {
      for (const j of jobs.jobs) {
        if (j.kind === "export" && !exportOrigins.current.has(j.id) && j.connectionId === exporting.connectionId) {
          exportOrigins.current.set(j.id, { connectionId: exporting.connectionId, origin: exporting.origin });
        }
      }
    }
    const live = new Set(jobs.jobs.map((j) => j.id));
    for (const id of [...exportOrigins.current.keys()]) if (!live.has(id)) exportOrigins.current.delete(id);
  }, [jobs.jobs, exporting]);

  /** Export... on a tree row: the columns and key come from the table's design. */
  async function exportTable(s: Selection) {
    try {
      const design = await tableDesign(s.connectionId, s.path);
      const estimate = tree.estimate(s.connectionId, s.path);
      openExport(s.connectionId, {
        kind: "table",
        path: s.path,
        columns: design.columns.map((c) => c.name),
        filter: null,
        sort: null,
        selected: [],
        hasPrimaryKey: design.indexes.some((i) => i.primary),
        rowEstimate: estimate,
        estimated: estimate !== null,
      });
    } catch (e) {
      toast.show({ kind: "error", text: errorText(e, connections.find((c) => c.id === s.connectionId)?.dialect) });
    }
  }

  /** Opens an Import tab into a table or a database, or shows the one open already. */
  function openImport(connectionId: ConnectionId, target: ImportTarget) {
    const key = importKey(connectionId, target);
    setTabs((all) =>
      all.some((t) => t.kind === "import" && t.key === key)
        ? all
        : [...all, { kind: "import", key, uid: newId(), connectionId, target }],
    );
    setActiveKey(key);
  }

  /**
   * Choose Connection... or a SQL file: the tab takes the key of its new Connection and target, so a
   * later Import... finds it (Q43). When a tab is open there already, that one shows and this one goes.
   */
  function updateImport(key: string, change: { connectionId?: ConnectionId; target?: ImportTarget }) {
    const tab = tabsRef.current.find((t) => t.kind === "import" && t.key === key);
    if (!tab || tab.kind !== "import") return;
    const next = { ...tab, ...change };
    const nextKey = importKey(next.connectionId, next.target);
    if (nextKey === key) {
      setTabs((all) => all.map((t) => (t.kind === "import" && t.key === key ? next : t)));
      return;
    }
    if (tabsRef.current.some((t) => t.kind === "import" && t.key === nextKey)) {
      setTabs((all) => all.filter((t) => !(t.kind === "import" && t.key === key)));
      setActiveKey(nextKey);
      return;
    }
    setTabs((all) => all.map((t) => (t.kind === "import" && t.key === key ? { ...next, key: nextKey } : t)));
    setActiveKey((k) => (k === key ? nextKey : k));
    setImportJobs((m) => {
      const id = m.get(key);
      if (id === undefined) return m;
      const moved = new Map(m);
      moved.delete(key);
      moved.set(nextKey, id);
      return moved;
    });
  }

  // A closed Import tab lets go of its job, and an ended import no tab holds is dismissed.
  useEffect(() => {
    const open = new Set(tabs.flatMap((t) => (t.kind === "import" ? [t.key] : [])));
    if ([...importJobs.keys()].some((k) => !open.has(k))) {
      setImportJobs((m) => new Map([...m].filter(([k]) => open.has(k))));
      return;
    }
    const held = new Set(importJobs.values());
    for (const j of jobs.jobs) {
      if ((j.kind === "import" || j.kind === "scriptImport") && j.done !== null && !held.has(j.id)) jobs.dismiss(j.id);
    }
  }, [tabs, importJobs, jobs.jobs]);

  /** The job an Import tab started, while it may still run. */
  function importJobOf(key: string): JobId | null {
    return importJobsRef.current.get(key) ?? null;
  }

  /**
   * Before the place's tabs go (another Group or place, or a Connection moving away): each running
   * Import tab asks "Cancel the import and roll back?"; a No keeps everything (Q43).
   */
  async function confirmImportsLeave(only?: ConnectionId): Promise<boolean> {
    for (const [key, id] of importJobsRef.current) {
      const tab = tabsRef.current.find((t) => t.kind === "import" && t.key === key);
      if (!tab || tab.kind !== "import" || (only !== undefined && tab.connectionId !== only)) continue;
      if (!jobsNow.current.some((j) => j.id === id && j.done === null)) continue;
      setActiveKey(key);
      if (!(await jobsGuard.confirmCloseImport(id))) return false;
    }
    return true;
  }

  /** The status bar's job item: an export opens its dialog again; an import shows its tab. */
  function openJob(id: JobId) {
    const job = jobs.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.kind === "export") {
      // Without its kept origin (a reload), the job's label is enough for the running view.
      const from = exportOrigins.current.get(id) ?? { connectionId: job.connectionId, origin: originFromJob(job.label) };
      setExporting((e) => ({ ...from, attach: id, seq: (e?.seq ?? 0) + 1 }));
      return;
    }
    const held = [...importJobs].find(([, j]) => j === id)?.[0];
    const tab =
      tabsRef.current.find((t) => t.kind === "import" && t.key === held) ??
      tabsRef.current.find((t) => t.kind === "import" && t.connectionId === job.connectionId);
    if (tab) setActiveKey(tabKey(tab));
  }

  /** A New table tab its create turned into a design tab: its key then, or null when it closed instead. */
  const createdTabs = useRef(new Map<string, string | null>());

  /** Closes a tab: a table with Pending Edits or an unapplied design asks first, a Schema Model through its own Close. */
  async function closeTab(key: string) {
    const tab = [...tabs, ...windowTabs].find((t) => tabKey(t) === key);
    if (!tab) return;
    if (objectTabOf(tab) && !(await confirmLeave([key]))) return;
    // A running import asks to cancel and roll back; one with only a mapping closes at once.
    if (tab.kind === "import" && !(await jobsGuard.confirmCloseImport(importJobOf(key)))) return;
    // A New table created through the ask's Apply is its table's design tab now: that tab closes (M2).
    const created = createdTabs.current.get(key);
    if (created !== undefined) {
      createdTabs.current.delete(key);
      if (created) dropTab(created);
      return;
    }
    if (!(await confirmCloseUnsaved(tab))) return;
    if (tab.kind === "flow" && !(await confirmCloseFlow(tab.name))) return;
    const builderClose = tab.kind === "schema" ? schemaCloseFor(tab.id) : null;
    if (builderClose) builderClose();
    else dropTab(key);
  }

  /** Removes a tab at once; the right neighbour, else the left, becomes active when it was. */
  function dropTab(key: string) {
    const doc = tabs.find((t) => t.kind === "query" && tabKey(t) === key);
    if (doc?.kind === "query") {
      refs.forget(doc.doc.id);
    }
    closeKey(key);
  }

  /** Home from the switcher or Ctrl+Shift+H: an open still on its way to the place is dropped (R23). */
  function goHome() {
    drafts.dropQueued();
    showHome();
  }

  function openObject(selection: Selection) {
    if (selection.kind === "table" || selection.kind === "view") {
      record({ kind: "table", path: selection.path, object: selection.kind }, selection.connectionId);
    }
    const key = objectKey(selection.connectionId, selection.kind, selection.path);
    // Worked out on the latest tabs: a Recent open runs after drafts were restored into them.
    setTabs((all) => (all.some((t) => t.kind === "object" && t.key === key) ? all : [...all, { kind: "object", key, selection }]));
    setActiveKey(key);
  }

  /** Opens a table's design tab, or shows it when it is open already. */
  function openDesign(connectionId: ConnectionId, path: ObjectPath) {
    const key = designKey(connectionId, path);
    setTabs((all) =>
      all.some((t) => t.kind === "design" && t.key === key)
        ? all
        : [...all, { kind: "design", key, connectionId, target: { kind: "alter", path } }],
    );
    setActiveKey(key);
  }

  /** Opens a table's lineage tab, or shows the one open already (step 6+). */
  function openLineage(connectionId: ConnectionId, path: ObjectPath) {
    const key = lineageKey(connectionId, path);
    setTabs((all) => (all.some((t) => t.kind === "lineage" && t.key === key) ? all : [...all, { kind: "lineage", key, connectionId, path }]));
    setActiveKey(key);
  }

  /** Opens a New table design tab in a database (and schema) and shows it (D7). */
  function newTable(connectionId: ConnectionId, database: string, schema: string | null) {
    const id = newId();
    const key = newDesignKey(id);
    setTabs((all) => [...all, { kind: "design", key, connectionId, target: { kind: "create", scope: { database, schema }, id } }]);
    setActiveKey(key);
  }

  /** Per grid tab: bumped to load the table's new columns; a notice when that was put off. */
  const [gridVersions, setGridVersions] = useState<Record<string, number>>({});
  const [gridNotices, setGridNotices] = useState<Record<string, string>>({});
  const forgetNotice = (key: string) =>
    setGridNotices((n) => {
      if (!(key in n)) return n;
      const next = { ...n };
      delete next[key];
      return next;
    });
  // A closed grid tab takes its notice with it.
  useEffect(() => {
    const live = new Set(tabs.flatMap((t) => (t.kind === "object" ? [t.key] : [])));
    setGridNotices((n) => {
      const kept = Object.entries(n).filter(([k]) => live.has(k));
      return kept.length === Object.keys(n).length ? n : Object.fromEntries(kept);
    });
  }, [tabs]);

  /** The table's grid tab loads its new columns, after its Pending Edits are asked about; Cancel keeps it with a notice. */
  async function reloadGrid(connectionId: ConnectionId, path: ObjectPath) {
    const key = objectKey(connectionId, "table", path);
    if (!tabsRef.current.some((t) => t.kind === "object" && t.key === key)) return;
    if (await confirmLeave([key])) {
      forgetNotice(key);
      setGridVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
    } else {
      setGridNotices((n) => ({ ...n, [key]: `${path.name} changed. Reload to see its new columns.` }));
    }
  }

  /**
   * A design tab changed the database: the table's grid, the completion schema and the applied
   * Connection's tree branch load again (whichever branch is focused), and a new table is revealed.
   * A create (done, or partly run, M4) turns its tab into the new table's design tab in place, so
   * the next Apply is an ALTER and never a second CREATE.
   */
  function designApplied(key: string, connectionId: ConnectionId, path: ObjectPath, kind: "altered" | "created" | "dropped") {
    if (kind === "dropped") {
      tableDropped(connectionId, path);
      return;
    }
    lang.schemas.invalidate(connectionId, path.database);
    tree.refresh(connectionId);
    void reloadGrid(connectionId, path);
    if (kind !== "created") return;
    setReveal((r) => ({ connectionId, database: path.database, schema: path.schema, name: path.name, seq: (r?.seq ?? 0) + 1 }));
    const next = designKey(connectionId, path);
    const open = tabsRef.current.some((t) => t.kind === "design" && t.key === next);
    createdTabs.current.set(key, open ? null : next);
    setTabs((all) => {
      const at = all.findIndex((t) => t.kind === "design" && t.key === key);
      if (at < 0) return all;
      // That table's design tab is open already: it stays, and this one goes.
      if (all.some((t) => t.kind === "design" && t.key === next)) return all.filter((_, i) => i !== at);
      const copy = [...all];
      copy[at] = { kind: "design", key: next, connectionId, target: { kind: "alter", path } };
      return copy;
    });
    setActiveKey((k) => (k === key ? next : k));
  }

  /** After a drop: the table's tabs close without asking (asked before, D11), and what lists it reloads. */
  function tableDropped(connectionId: ConnectionId, path: ObjectPath) {
    const keys = new Set([objectKey(connectionId, "table", path), designKey(connectionId, path)]);
    removeTabs((t) => {
      const o = objectTabOf(t);
      return !!o && keys.has(o.key);
    });
    tree.refresh(connectionId);
    lang.schemas.invalidate(connectionId, path.database);
    // D28: Recent forgets the table, then shows the list without it.
    forgetRecent(connectionId, path).then(
      () => loadRecent(),
      (e) => {
        setNotice(errorText(e));
        loadRecent();
      },
    );
  }

  function newQuery(connectionId: ConnectionId | null, text = "", database?: string) {
    const c = connections.find((x) => x.id === connectionId) ?? null;
    const doc: QueryTabDoc = {
      id: newId(),
      name: nextQueryName(tabs.map((t) => (t.kind === "query" ? t.doc.name : ""))),
      text,
      connectionId: c?.id ?? null,
      database: database ?? c?.database ?? null,
      savedId: null,
      savedText: null,
    };
    setTabs((all) => [...all, { kind: "query", doc }]);
    setActiveKey(tabKey({ kind: "query", doc }));
  }

  /** Opens a New Visual Query tab on the Connection and database (its default one unless given). */
  function newVisualQuery(connectionId: ConnectionId, database?: string | null) {
    const c = connections.find((x) => x.id === connectionId);
    if (!c) return;
    const db = database ?? (c.dialect === "sqlite" ? "main" : c.database);
    const doc: VisualTabDoc = {
      id: newId(),
      name: NEW_VISUAL_NAME,
      connectionId: c.id,
      database: db,
      model: emptyQuery(db, c.dialect),
      savedId: null,
      savedJson: null,
    };
    setTabs((all) => [...all, { kind: "visual", doc }]);
    setActiveKey(tabKey({ kind: "visual", doc }));
  }

  function updateVisual(doc: VisualTabDoc) {
    setTabs((all) => all.map((t) => (t.kind === "visual" && t.doc.id === doc.id ? { kind: "visual", doc } : t)));
  }

  /** A copy of a Visual Query in a new unsaved tab beside it. */
  function duplicateVisual(doc: VisualTabDoc) {
    const copy: VisualTabDoc = { ...doc, id: newId(), name: `Copy of ${doc.name}`, savedId: null, savedJson: null };
    setTabs((all) => [...all, { kind: "visual", doc: copy }]);
    setActiveKey(tabKey({ kind: "visual", doc: copy }));
  }

  /** Each Visual Query tab's handle, so the tree's Add to Visual Query reaches the active one. */
  const visualControls = useRef(new Map<string, MutableRefObject<VisualTabControl | null>>());
  function visualControl(id: string): MutableRefObject<VisualTabControl | null> {
    let ref = visualControls.current.get(id);
    if (!ref) {
      ref = { current: null };
      visualControls.current.set(id, ref);
    }
    return ref;
  }
  useEffect(() => {
    const live = new Set(tabs.flatMap((t) => (t.kind === "visual" ? [t.doc.id] : [])));
    for (const id of [...visualControls.current.keys()]) if (!live.has(id)) visualControls.current.delete(id);
  }, [tabs]);

  /** Home's Show all history: Query History with every Connection, beside the place's query tab (a new one when it has none). */
  function showAllHistory() {
    const last = tabs.find((t) => tabKey(t) === lastPlaceKey.current);
    const query = last?.kind === "query" ? last : [...tabs].reverse().find((t) => t.kind === "query");
    if (query) setActiveKey(tabKey(query));
    else newQuery(activeId);
    setHistoryAll(true);
    setHistoryOpen(true);
  }

  /** Opens a Saved Query from this place (the tree or the Saved Queries list): on its "opens on" Connection when that is here, else the active one (PR1). */
  const openSavedHere = (q: SavedQuery) =>
    openSaved(q, connections.some((c) => c.id === q.connectionId && c.groupId === (place.kind === "group" ? place.groupId : null)) ? q.connectionId : activeId);

  /** Opens a Saved Query in a tab on `on`: from this place through openSavedHere, from Recent on the Connection it was recorded with. */
  function openSaved(q: SavedQuery, on: ConnectionId | null) {
    if (q.kind === "visual") {
      openSavedVisual(q);
      return;
    }
    record({ kind: "query", savedId: q.id, name: q.name }, on);
    const c = connections.find((x) => x.id === on) ?? null;
    const doc: QueryTabDoc = {
      id: newId(),
      name: q.name,
      text: q.sql,
      connectionId: c?.id ?? null,
      database: c?.database ?? null,
      savedId: q.id,
      savedText: q.sql,
    };
    // Worked out on the latest tabs, so a draft of this Saved Query restored just now is reused.
    openSavedDoc(doc);
  }

  /**
   * Opens a saved Visual Query on the Connection it remembers (none when that was removed: the tab
   * asks for one), on the model's database. A model from a newer Contura opens nothing.
   */
  function openSavedVisual(q: SavedQuery) {
    const read = savedVisualModel(q.visualJson ?? "");
    if (read.kind === "newer") {
      toast.show({ kind: "error", text: "This Visual Query was saved by a newer Contura. Update Contura to open it." });
      return;
    }
    if (read.kind === "unreadable") {
      toast.show({ kind: "error", text: "This Visual Query could not be read." });
      return;
    }
    const c = connections.find((x) => x.id === q.connectionId) ?? null;
    record({ kind: "query", savedId: q.id, name: q.name }, c?.id ?? null);
    const model = read.model;
    openVisualDoc({
      id: newId(),
      name: q.name,
      connectionId: c?.id ?? null,
      database: model.database ?? (c?.dialect === "sqlite" ? "main" : (c?.database ?? null)),
      model,
      savedId: q.id,
      savedJson: q.visualJson ?? null,
    });
  }

  /** Opens the Saved Queries list as a tab of the place (one at most) and shows it. */
  function openSavedList() {
    setTabs((all) => (all.some((t) => t.kind === "savedQueries") ? all : [...all, { kind: "savedQueries" }]));
    setActiveKey("savedQueries");
  }

  function updateDoc(doc: QueryTabDoc) {
    setTabs((all) => all.map((t) => (t.kind === "query" && t.doc.id === doc.id ? { kind: "query", doc } : t)));
  }

  // Reconciles the painted theme with the Core setting; the status bar's theme switch chooses through it.
  const theme = useTheme();

  /** Ctrl+1 to Ctrl+9: the places in the switcher's order (PR7). */
  const openPlaceAt = (n: number) => {
    const p = menuPlaces(groups)[n - 1];
    if (p) void enterPlace(p);
  };
  const activeWindow = windowTabs.find((t) => tabKey(t) === activeKey);
  const settingsActive = activeWindow?.kind === "settings";
  const dataFolder = useDataFolder(settingsActive);

  // ---- Diagrams (step 6+): the New diagram sheet, Recent's diagrams and each diagram's file actions ----
  const [newDiagramOpen, setNewDiagramOpen] = useState(false);
  const [diagrams, setDiagrams] = useState<DiagramEntry[]>([]);
  const loadDiagrams = () => {
    listDiagrams().then(setDiagrams, () => {});
  };
  // Home's Recent reads the folder each time Home shows, so saves made in diagram tabs are counted.
  useEffect(() => {
    if (activeKey === "home") loadDiagrams();
  }, [activeKey]);
  /** The open tab of diagram `name`; names are not case-sensitive on Windows. */
  const flowTabOf = (name: string) => windowTabs.find((t) => t.kind === "flow" && t.name.toLowerCase() === name.toLowerCase());
  const diagramFiles = useDiagramFileActions({
    tabOf: (name) => {
      const tab = flowTabOf(name);
      return tab?.kind === "flow" ? tab.name : null;
    },
    confirmClose: (tab) => confirmCloseFlow(tab),
    dropTab: (tab) => dropTab(`flow:${tab}`),
    openTab: (name) => openFlowTab(name),
    renameTab: (from, to) => renameFlowTab(from, to),
    onChanged: loadDiagrams,
  });
  const diagramActions = { rename: diagramFiles.rename, saveCopy: (name: string) => void diagramFiles.saveCopy(name), remove: diagramFiles.remove };
  /** The diagram tab on top, for the file commands. */
  const activeDiagram = activeWindow?.kind === "flow" ? activeWindow.name : null;
  // The app's command keys; the rest of the registry is wired as each command arrives.
  useCommandKeys({
    // A new query tab, on the active Connection.
    "query.new": () => newQuery(activeId),
    "assistant.toggle": () => {
      if (!activeWindow) setAssistantOpen((o) => !o);
    },
    "settings.open": () => openSettings(),
    "home.open": () => goHome(),
    "connection.new": () => setForm({ kind: "connection" }),
    "group.open.1": () => openPlaceAt(1),
    "group.open.2": () => openPlaceAt(2),
    "group.open.3": () => openPlaceAt(3),
    "group.open.4": () => openPlaceAt(4),
    "group.open.5": () => openPlaceAt(5),
    "group.open.6": () => openPlaceAt(6),
    "group.open.7": () => openPlaceAt(7),
    "group.open.8": () => openPlaceAt(8),
    "group.open.9": () => openPlaceAt(9),
    "flow.fromMermaid": () => setMermaidOpen(true),
    "flow.new": () => setNewDiagramOpen(true),
    "flow.saveCopy": () => {
      if (activeDiagram) void diagramFiles.saveCopy(activeDiagram);
    },
    "flow.rename": () => {
      if (activeDiagram) diagramFiles.rename(activeDiagram);
    },
    "flow.delete": () => {
      if (activeDiagram) diagramFiles.remove(activeDiagram);
    },
  });

  const askGroupId = place.kind === "group" ? place.groupId : null;
  const { askKit, chatSeed } = useAskKit({
    groupId: askGroupId,
    settingsActive,
    activeKey,
    place,
    connections,
    openPanel: () => setAssistantOpen(true),
    openAiSettings: () => openSettings("ai"),
  });
  // Each Schema Model's live source Connection, kept by tab so a card ask sees the same object between draws.
  const schemaSources = useMemo(
    () =>
      new Map(
        windowTabs.flatMap((t) =>
          t.kind === "schema" ? [[t.id, sourceConnectionFor(t.doc.connectionId, t.doc.dialect, connections)] as const] : [],
        ),
      ),
    [connections, windowTabs],
  );

  async function reload() {
    try {
      const [g, c] = await Promise.all([listGroups(), listConnections()]);
      setGroups(g);
      setConnections(c);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  /** Moves the window to another place: its tabs go, the window's tabs stay (PR5), and the place shows. */
  function goTo(next: Place) {
    drafts.leaveFor(next);
    lastPlaceKey.current = null;
    setPlace(next);
    setActiveId(null);
    setTreeBranch(null);
    setTabs([]);
    setActiveKey(null);
    refs.clear();
    setNotice(null);
    setForm({ kind: "none" });
  }

  /**
   * Shows a place: the current one at once; another after its Pending Edits are asked about,
   * remembered as the last Group unless `remember` is false. False when leaving was cancelled.
   */
  async function enterPlace(next: Place, remember = true): Promise<boolean> {
    if (placeKey(next) === placeKey(placeNow.current)) {
      showPlace();
      return true;
    }
    // Discards wait for the import ask: a No there keeps the place and its edits.
    if (!(await leaveAll({ then: () => confirmImportsLeave() }))) return false;
    goTo(next);
    if (remember) {
      try {
        await setLastGroup(next.kind === "group" ? next.groupId : null);
      } catch (e) {
        setNotice(errorText(e));
      }
    }
    return true;
  }

  /** Opens the Settings tab (one at most), scrolled to a section: the top unless asked otherwise. */
  function openSettings(section: SettingsSection = "appearance") {
    setForm({ kind: "none" });
    setWindowTabs((w) =>
      w.some((t) => t.kind === "settings")
        ? w.map((t): WindowTab => (t.kind === "settings" ? { kind: "settings", section, seq: (t.seq ?? 0) + 1 } : t))
        : [...w, { kind: "settings", section, seq: 0 }],
    );
    setActiveKey("settings");
  }

  async function openGroup(id: GroupId) {
    await enterPlace({ kind: "group", groupId: id });
  }

  /**
   * Goes to the Connection's Group (or Ungrouped) with it active, and opens it.
   * "stayed" when leaving was cancelled or the Connection is gone; "failed" when it did not open (the notice says why).
   */
  async function openConnectionAt(id: ConnectionId): Promise<"open" | "failed" | "stayed"> {
    const c = connections.find((x) => x.id === id);
    if (!c) return "stayed";
    const target = placeOf(c);
    if (placeKey(target) === placeKey(placeNow.current)) showPlace();
    else {
      if (!(await leaveAll({ then: () => confirmImportsLeave() }))) return "stayed";
      goTo(target);
    }
    setActiveId(id);
    if (openIds.has(id)) return "open";
    const here = visit.current;
    try {
      await openTracked(id);
    } catch {
      // The row says Failed, with the reason (frame 10c); no notice above the tree.
      return visit.current === here ? "failed" : "stayed";
    }
    // You went elsewhere while it opened: the Connection stays open, but nothing more opens (ruling R23).
    return visit.current === here ? "open" : "stayed";
  }

  /** Opens a model in a Schema Model tab (the open one when its file is open already), recording it in Recent when it has a file. */
  function openBuilder(doc: ModelDoc) {
    if (doc.path) record({ kind: "schemaModel", file: doc.path }, doc.connectionId);
    setModelStart(null);
    const id = newId();
    openSchemaTab({ kind: "schema", id, doc });
  }

  /** A model saved to a file for the first time, or saved as another: its tab takes the file's name. */
  function modelSavedAs(id: string, path: string) {
    setWindowTabs((w) => w.map((t) => (t.kind === "schema" && t.id === id ? { ...t, doc: { ...t.doc, path } } : t)));
  }

  function openRecent(item: RecentItem) {
    return openRecentItem(item, {
      connections,
      savedQueries,
      openConnectionAt,
      enterPlace,
      whenDraftsLoaded,
      openSaved,
      openObject,
      openBuilder,
      askDialect: (file) => setModelStart({ file }),
      notice: setNotice,
    });
  }

  async function openUngrouped() {
    await enterPlace({ kind: "ungrouped" });
  }

  const tableDrop = useTableDrop({ connections, groups, confirmLeave, onDropped: tableDropped });

  const actions = connectionActions({
    openIds,
    confirmLeave,
    tableKeys,
    openTracked,
    markClosed,
    reload,
    setActiveId,
    newQuery: (id) => newQuery(id),
    setNotice,
    historyCleared: () => setHistoryRefresh((n) => n + 1),
    confirmJobs: (id) => jobsGuard.confirmStop(id),
    confirmImports: (id) => confirmImportsLeave(id),
  });

  if (startup.s === "loading") return <LaunchScreen step={step} startedAt={startedAt} />;
  if (startup.s === "failed") return <StartupFailed message={startup.message} onRetry={retry} />;

  const group = place.kind === "group" ? groups.find((g) => g.id === place.groupId) : undefined;
  const workspaceGroupId = place.kind === "group" ? place.groupId : null;
  const placeName = group?.name ?? "Ungrouped";
  const inPlace = connections.filter((c) => c.groupId === workspaceGroupId);
  /** The Connection of the place used last: the active one, else the one opened most recently. */
  const lastUsed =
    inPlace.find((c) => c.id === activeId) ??
    [...inPlace].sort((a, b) => (openedTimes[b.id] ?? 0) - (openedTimes[a.id] ?? 0))[0] ??
    null;
  /** The active place tab; undefined while a window tab (or none) is active. */
  const current = tabs.find((t) => tabKey(t) === activeKey);
  const selection = current?.kind === "object" ? current.selection : null;
  /** D10: the active tab's Connection when it is open, else the place's first open one. */
  const activeConnection = current ? tabConnectionId(current) : null;
  const visualTarget =
    activeConnection !== null && openIds.has(activeConnection) && inPlace.some((c) => c.id === activeConnection)
      ? {
          id: activeConnection,
          // M13: from a table tab, the table's own database.
          database:
            current?.kind === "query" || current?.kind === "visual"
              ? current.doc.database
              : current
                ? (objectTabOf(current)?.path?.database ?? null)
                : null,
        }
      : (() => {
          const first = inPlace.find((c) => openIds.has(c.id));
          return first ? { id: first.id, database: null } : null;
        })();
  const activeVisual = current?.kind === "visual" ? current.doc : null;
  const statusScreen = statusScreenFor({ activeWindow, current, treeBranch, activeId, connections, openIds, versions, dataFolder, version });
  const historyFor =
    historyOpen && current?.kind === "query" ? (inPlace.find((c) => c.id === current.doc.connectionId) ?? null) : null;
  const historyAllShown = historyOpen && historyAll && current?.kind === "query";

  const assistantShown = assistantOpen && !activeWindow;
  const answerTab = current?.kind === "query" ? current.doc.id : null;
  const assistantTarget = assistantTargetFor(current, inPlace);
  const assistantSchema = assistantTarget?.database
    ? lang.client.sqlSchemaFor(schemaKey(assistantTarget.connection.id, assistantTarget.database))
    : null;
  // Read from the editor on each draw, so the Ask context follows the statement where you are typing (see the note below).
  const stmt = assistantShown && assistantTarget ? (refs.editor(assistantTarget.doc.id)?.runTarget() ?? null) : null;
  const assistantContext = assistantShown && assistantTarget ? assistantContextFor(assistantTarget, assistantSchema, stmt) : null;

  const app = (
    <div className="app">
      <TitleBar>
        <GroupSwitcher
          groups={groups}
          place={place}
          connectionCount={connections.length}
          onHome={goHome}
          onOpenGroup={(id) => void openGroup(id)}
          onOpenUngrouped={() => void openUngrouped()}
          onNewGroup={() => setForm({ kind: "newGroup" })}
          onSettings={() => openSettings()}
        />
        {/* C1: the strip is always there, with its "+", on every tab. */}
        <TabStrip
          tabs={allTabs}
          connections={connections}
          groups={groups}
          active={activeKey}
          onSelect={setActiveKey}
          onClose={(key) => void closeTab(key)}
          dirtyKeys={dirtyKeys}
          onNew={() => newQuery(activeId)}
          onNewVisual={() => visualTarget && newVisualQuery(visualTarget.id, visualTarget.database)}
          newVisualReady={visualTarget !== null}
          onNewDiagram={() => setNewDiagramOpen(true)}
          diagramActions={diagramActions}
        />
      </TitleBar>

      <div
        className={activeWindow ? "body body-home" : `body${historyFor || historyAllShown ? " body-history" : ""}${assistantShown ? " body-ai" : ""}`}
      >
        <div className="place-wrap">
          {/* The place's sidebar stays mounted under a window tab, so its tree keeps where you were. */}
          <PlaceSidebar
            group={group}
            placeName={placeName}
            hidden={!!activeWindow}
            empty={inPlace.length === 0}
            notice={notice}
            onEditGroup={() => setForm({ kind: "group" })}
            onNewConnection={() => setForm({ kind: "connection" })}
          >
            <OneTree
              connections={inPlace}
              groups={groups}
              openIds={openIds}
              saved={savedQueries}
              activeSavedId={current?.kind === "query" ? current.doc.savedId : null}
              selected={selection}
              tree={tree}
              keysActive={!activeWindow}
              onSelectObject={openObject}
              onOpenConnection={actions.openFromTree}
              onCloseConnection={(id) => void actions.closeFromTree(id)}
              onEditConnection={(c) => void editConnection(c)}
              onDuplicateConnection={(c) => setForm({ kind: "connection", duplicateOf: c })}
              onNewQuery={(id) => void actions.newQueryOn(id)}
              onNewVisualQuery={(id) => void actions.newTabOn(id, (c) => newVisualQuery(c))}
              onAddToVisualQuery={
                activeVisual?.connectionId ? (s) => visualControls.current.get(activeVisual.id)?.current?.add(s) : undefined
              }
              visualQueryConnection={activeVisual?.connectionId ?? null}
              onNewSchemaModel={(connectionId, database, schema) => setModelStart({ initial: { connectionId, database, schema } })}
              onNewTable={newTable}
              onDesignTable={(s) => openDesign(s.connectionId, s.path)}
              onShowLineage={(s) => openLineage(s.connectionId, s.path)}
              onDropTable={(id, path) => void tableDrop.drop(id, path)}
              onExportTable={(s) => void exportTable(s)}
              onImportTable={(s) => openImport(s.connectionId, { kind: "table", path: s.path })}
              onMoveConnection={(id, to) => void actions.moveFromTree(id, to)}
              onNewGroup={() => setForm({ kind: "newGroup" })}
              onClearHistory={(id) => void actions.clearHistoryFromTree(id)}
              onDeleteConnection={(id) => void actions.deleteFromTree(id)}
              onRefresh={(id) => lang.schemas.invalidate(id)}
              onOpenSaved={openSavedHere}
              onOpenSavedList={openSavedList}
              onSavedChanged={reloadSaved}
              openStatus={openStatus}
              onFocusBranch={(id) => {
                setTreeBranch(id);
                if (id !== null) setActiveId(id);
              }}
            />
          </PlaceSidebar>

          <main className="work">
            {/* Window tabs are panes of the work area like any tab; each stays mounted while hidden. */}
            <WindowPanes
              windowTabs={windowTabs}
              activeKey={activeKey}
              home={{
                groups,
                connections,
                openIds,
                onOpenGroup: openGroup,
                notice,
                recent,
                onOpenConnection: (id) => void openConnectionAt(id),
                onOpenUngrouped: () => void openUngrouped(),
                onOpenRecent: (item) => void openRecent(item),
                openedTimes,
                onRecentChanged: loadRecent,
                onShowAllHistory: showAllHistory,
                onNewDiagram: () => setNewDiagramOpen(true),
                diagrams,
                onOpenDiagram: (name) => openFlowTab(name),
                diagramActions,
                onChanged: reload,
                onBeforeMove: (id) => askFromHome(tableKeys(id), () => confirmImportsLeave(id)),
                onBeforeDeleteGroup: (id) => askFromHome(groupTableKeys(id)),
                onGroupDeleted: (id) => {
                  // The place's Group is gone: the window moves to Ungrouped, Home still showing.
                  if (placeNow.current.kind === "group" && placeNow.current.groupId === id) {
                    void enterPlace({ kind: "ungrouped" }).then((moved) => moved && showHome());
                  }
                },
              }}
              settings={{
                groupId: workspaceGroupId,
                groupName: group?.name ?? null,
                connections,
                onSection: (section) =>
                  setWindowTabs((w) => w.map((x): WindowTab => (x.kind === "settings" ? { ...x, section } : x))),
                onConnectionSaved: () => {
                  // Only the AI access changed, so open sessions and their transactions stay as they are.
                  void reload();
                },
              }}
              schema={{
                onClose: (key) => dropTab(key),
                closeRef: (id) => schemaClose(id),
                onPathChange: (id, path) => modelSavedAs(id, path),
                ask: askKit,
                sourceConnection: (id) => schemaSources.get(id),
              }}
            />
            {/* Table and view tabs stay mounted while hidden, so their Pending Edits survive a tab switch. */}
            {tabs.map((t) => {
              if (t.kind !== "object" || (t.selection.kind !== "table" && t.selection.kind !== "view")) return null;
              const s = t.selection;
              const c = connections.find((x) => x.id === s.connectionId);
              return (
                <div key={t.key} className="work-pane" hidden={t.key !== activeKey}>
                  <DataGrid
                    connectionId={s.connectionId}
                    table={s.path}
                    onClose={() => void closeTab(t.key)}
                    onNotOpen={() => lost(s.connectionId)}
                    dialect={c?.dialect}
                    readOnly={c?.readOnly ?? false}
                    kind={s.kind === "view" ? "view" : "table"}
                    production={c?.production ?? false}
                    group={c?.groupId ? groups.find((g) => g.id === c.groupId) ?? null : null}
                    onDirtyChange={(dirty) => markDirty(t.key, dirty)}
                    controlRef={gridControl(t.key)}
                    visible={t.key === activeKey}
                    connectionName={c?.name}
                    rowEstimate={s.kind === "table" ? tree.estimate(s.connectionId, s.path) : null}
                    onOpenQuery={(sql) => newQuery(s.connectionId, sql, s.path.database)}
                    onDesign={s.kind === "table" ? () => openDesign(s.connectionId, s.path) : undefined}
                    onLineage={s.kind === "table" ? () => openLineage(s.connectionId, s.path) : undefined}
                    onExport={s.kind === "table" ? (origin) => openExport(s.connectionId, origin) : undefined}
                    onImport={s.kind === "table" ? () => openImport(s.connectionId, { kind: "table", path: s.path }) : undefined}
                    version={gridVersions[t.key] ?? 0}
                    notice={gridNotices[t.key] ?? null}
                    onNoticeDone={() => forgetNotice(t.key)}
                    lang={lang}
                    ask={{
                      ...askKit,
                      connection: c
                        ? { id: c.id, name: c.name, dialect: c.dialect, database: s.path.database, access: c.aiAccess }
                        : null,
                    }}
                  />
                </div>
              );
            })}
            {/* Design tabs stay mounted while hidden too, so an unapplied design survives a tab switch. */}
            {tabs.map((t) => {
              if (t.kind !== "design") return null;
              const c = connections.find((x) => x.id === t.connectionId);
              if (!c) return null;
              return (
                <div key={t.key} className="work-pane" hidden={t.key !== activeKey}>
                  <TableDesigner
                    connection={c}
                    target={t.target}
                    group={c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
                    visible={t.key === activeKey}
                    onDirtyChange={(dirty) => markDirty(t.key, dirty)}
                    controlRef={gridControl(t.key)}
                    onApplied={(path, kind) => designApplied(t.key, c.id, path, kind)}
                    onDrop={(path) => void tableDrop.drop(c.id, path)}
                    lang={lang}
                  />
                </div>
              );
            })}
            {/* Lineage tabs stay mounted while hidden, so their drawing and panel survive a tab switch. */}
            {tabs.map((t) => {
              if (t.kind !== "lineage") return null;
              const c = connections.find((x) => x.id === t.connectionId);
              if (!c) return null;
              return (
                <div key={t.key} className="work-pane" hidden={t.key !== activeKey}>
                  <LineageTab
                    connection={c}
                    path={t.path}
                    onOpenTable={(path) => openObject({ connectionId: c.id, kind: "table", path })}
                    onAddForeignKey={(path) => openDesign(c.id, path)}
                    onOpenView={(path) => openObject({ connectionId: c.id, kind: "view", path })}
                    onOpenDiagram={(name) => openFlowTab(name)}
                  />
                </div>
              );
            })}
            {selection && selection.kind !== "table" && selection.kind !== "view" && (
              <DefinitionView
                key={objectKey(selection.connectionId, selection.kind, selection.path)}
                selection={selection}
                onClose={() => void closeTab(objectKey(selection.connectionId, selection.kind, selection.path))}
                onNotOpen={() => lost(selection.connectionId)}
              />
            )}
            {/* The Saved Queries list stays mounted while hidden, so its filter and selection survive a tab switch. */}
            {tabs.some((t) => t.kind === "savedQueries") && (
              <div className="work-pane" hidden={activeKey !== "savedQueries"}>
                <SavedQueriesList
                  queries={savedQueries}
                  connections={connections}
                  onOpen={openSavedHere}
                  onChanged={reloadSaved}
                  visible={activeKey === "savedQueries"}
                />
              </div>
            )}
            {/* Query tabs stay mounted while hidden, so their sessions and results survive a tab switch. */}
            {tabs.map((t) =>
              t.kind === "query" ? (
                <div key={t.doc.id} className="work-pane" hidden={tabKey(t) !== activeKey}>
                  <QueryTab
                    tab={t.doc}
                    connections={inPlace}
                    groups={groups}
                    openIds={openIds}
                    onConnectionOpened={(id) => markOpened(id, null)}
                    onOpenStatus={setStatus}
                    onEditConnection={(id) => {
                      const c = connections.find((x) => x.id === id);
                      if (c) void editConnection(c);
                    }}
                    onExport={(origin) => {
                      if (t.doc.connectionId) openExport(t.doc.connectionId, origin);
                    }}
                    rowEstimate={tree.estimate}
                    onChange={updateDoc}
                    onSaved={savedOne}
                    historyOpen={historyOpen}
                    onToggleHistory={() => {
                      setHistoryAll(false);
                      setHistoryOpen((o) => !o);
                    }}
                    assistantOpen={assistantShown}
                    onToggleAssistant={() => setAssistantOpen((o) => !o)}
                    editorRef={refs.editorRef(t.doc.id)}
                    runRef={refs.runRef(t.doc.id)}
                    visible={tabKey(t) === activeKey}
                    onRan={() => setHistoryRefresh((n) => n + 1)}
                    lang={lang}
                    ask={askKit}
                    onShowSaved={(id) => {
                      const doc = tabsRef.current.find((x) => x.kind === "query" && x.doc.savedId === id);
                      if (doc) setActiveKey(tabKey(doc));
                    }}
                    onShowInTree={(target) => {
                      setActiveId(target.connectionId);
                      setReveal((r) => ({
                        ...target,
                        seq: (r?.seq ?? 0) + 1,
                      }));
                    }}
                  />
                </div>
              ) : null,
            )}
            {/* Visual Query tabs stay mounted while hidden, so their canvas and preview survive a tab switch. */}
            {tabs.map((t) => {
              if (t.kind !== "visual") return null;
              const key = tabKey(t);
              const cid = t.doc.connectionId;
              const c = cid === null ? null : (connections.find((x) => x.id === cid) ?? null);
              return (
                <div key={key} className="work-pane" hidden={key !== activeKey}>
                  <VisualQueryTab
                    doc={t.doc}
                    databases={(() => {
                      const d = c ? tree.branches[c.id]?.databases : undefined;
                      return d?.s === "loaded" ? d.value : undefined;
                    })()}
                    connection={c}
                    connections={inPlace}
                    open={c !== null && openIds.has(c.id)}
                    group={c?.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
                    visible={key === activeKey}
                    lang={lang}
                    rowEstimate={(path) => (c ? tree.estimate(c.id, path) : null)}
                    onChange={updateVisual}
                    onOpenInEditor={(sql) => newQuery(cid, sql, t.doc.database ?? undefined)}
                    onSaved={savedOne}
                    savedQueries={savedQueries}
                    onOpenConnection={(id) => {
                      const target = id ?? c?.id;
                      if (target && !openIds.has(target)) void actions.openFromTree(target);
                    }}
                    onConnectionOpened={(id) => markOpened(id, null)}
                    onRan={() => setHistoryRefresh((n) => n + 1)}
                    controlRef={visualControl(t.doc.id)}
                    onDuplicate={() => duplicateVisual(t.doc)}
                    onClose={() => void closeTab(key)}
                  />
                </div>
              );
            })}
            {/* Import tabs stay mounted while hidden, so a running import keeps its view. */}
            {tabs.map((t) => {
              if (t.kind !== "import") return null;
              const c = connections.find((x) => x.id === t.connectionId);
              if (!c) return null;
              const key = t.key;
              return (
                <div key={t.uid ?? key} className="work-pane" hidden={key !== activeKey}>
                  <ImportTab
                    connection={c}
                    group={c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
                    target={t.target}
                    visible={key === activeKey}
                    writable={inPlace}
                    onRetarget={(id) => updateImport(key, { connectionId: id })}
                    onTargetChange={(target) => updateImport(key, { target })}
                    onOpenTable={(path) => openObject({ connectionId: c.id, kind: "table", path })}
                    onJob={(id) => setImportJobs((m) => new Map(m).set(key, id))}
                  />
                </div>
              );
            })}
            {!current && !activeWindow && (
              <WorkEmpty
                lastConnection={lastUsed}
                anyOpen={inPlace.some((c) => openIds.has(c.id))}
                onNewQuery={() => newQuery(lastUsed?.id ?? activeId)}
                onOpen={(c) => void actions.openFromTree(c.id)}
              />
            )}
          </main>
          {(historyAllShown || historyFor) && current?.kind === "query" && (
            <HistoryPanel
              key={historyAllShown ? "all" : "connection"}
              connections={connections}
              scopeConnection={historyFor ?? inPlace.find((c) => c.id === current.doc.connectionId) ?? null}
              initialScope={historyAllShown ? "all" : "connection"}
              refreshKey={historyRefresh}
              onInsert={(sql) => refs.editor(current.doc.id)?.insert(sql)}
              onRun={(sql) => void refs.runner(current.doc.id)?.(sql)}
              onClose={() => {
                setHistoryAll(false);
                setHistoryOpen(false);
              }}
            />
          )}
          {assistantShown && (
            <AssistantPanel
              place={placeKey(place)}
              groupId={workspaceGroupId}
              context={assistantContext}
              schema={assistantSchema}
              onOpenSettings={() => openSettings("ai")}
              seed={chatSeed}
              connections={connections}
              onClose={() => setAssistantOpen(false)}
              onInsert={answerTab ? (sql) => refs.editor(answerTab)?.insert(answerText(sql)) : undefined}
              onRun={
                answerTab
                  ? async (sql) => {
                      // The answer goes into the editor first, then runs through the tab's runner (the Production and Read-only checks).
                      refs.editor(answerTab)?.insert(answerText(sql));
                      return (await refs.runner(answerTab)?.(sql)) ?? { ran: false };
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      <StatusBar
        screen={statusScreen}
        theme={theme.choice}
        onTheme={theme.choose}
        jobs={
          <JobStatusItem
            jobs={jobs.jobs}
            onOpen={openJob}
            onEnded={jobs.dismiss}
            dialectOf={(id) => connections.find((c) => c.id === id)?.dialect}
          />
        }
      />

      <FormDialogs
        form={form}
        group={group}
        groups={groups}
        connections={connections}
        openIds={openIds}
        workspaceGroupId={workspaceGroupId}
        onCloseForm={() => setForm({ kind: "none" })}
        reload={reload}
        confirmGroupLeave={(id) => confirmLeave(groupTableKeys(id))}
        beforeConnectionSave={(id) => jobsGuard.confirmStop(id)}
        onGroupDeleted={() => {
          // The Group is gone: the window moves to Ungrouped and shows Home.
          void enterPlace({ kind: "ungrouped" }).then((moved) => moved && showHome());
        }}
        onConnectionSaved={(saved, edited) => {
          // Saving closes the Connection's session, so it must be opened again.
          if (edited) markClosed(saved.id);
        }}
      />
      {leaveDialog}
      {jobsGuard.dialog}
      {exporting &&
        (() => {
          const c = connections.find((x) => x.id === exporting.connectionId);
          if (!c) return null;
          return (
            <ExportDialog
              key={exporting.seq}
              connection={c}
              group={c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
              origin={exporting.origin}
              attach={exporting.attach}
              onClose={() => setExporting(null)}
            />
          );
        })()}
      {mermaidOpen && (
        <MermaidImportDialog
          groups={groups}
          defaultGroup={workspaceGroupId}
          lang={lang.client}
          onClose={() => setMermaidOpen(false)}
          beforeReplace={diagramFiles.beforeReplace}
          onCreated={(name) => {
            setMermaidOpen(false);
            // The flow is saved in the diagrams folder by name: open it in its tab.
            openFlowTab(name);
            loadDiagrams();
          }}
        />
      )}
      {newDiagramOpen && (
        <NewDiagramSheet
          onClose={() => setNewDiagramOpen(false)}
          beforeReplace={diagramFiles.beforeReplace}
          onCreated={(name) => {
            setNewDiagramOpen(false);
            openFlowTab(name);
            focusFlowText(name);
            loadDiagrams();
          }}
          onMermaid={() => {
            setNewDiagramOpen(false);
            setMermaidOpen(true);
          }}
          onOpenDiagram={(name) => {
            setNewDiagramOpen(false);
            openFlowTab(name);
          }}
        />
      )}
      {diagramFiles.dialog}
      {tableDrop.dialog}
      <StartModelDialog
        modelStart={modelStart}
        connections={connections}
        openIds={openIds}
        onStartModel={openBuilder}
        onCancelModel={() => setModelStart(null)}
      />
    </div>
  );
  return <GroupImagesProvider value={groupImages}>{app}</GroupImagesProvider>;
}
