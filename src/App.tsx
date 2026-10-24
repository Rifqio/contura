import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aiContextChanged,
  errorText,
  fileName,
  firstStartGuide,
  firstStartGuideSeen,
  forgetRecent,
  listConnections,
  listDiagrams,
  listGroups,
  saveConnection,
  setLastGroup,
  tableDesign,
} from "./api/client";
import type { ConnectionConfig, ConnectionId, DiagramEntry, Group, GroupId, JobId, ObjectPath, RecentItem, RestoreTarget, SavedQuery } from "./api/types";
import BackupDialog from "./backup/BackupDialog";
import RestoreDialog, { type RestoreRun, restoreErrorText } from "./backup/RestoreDialog";
import { restoreStoppedText, restoredText, runStatements } from "./backup/backupText";
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
import { useClosedTabs } from "./app/useClosedTabs";
import { type ClosedTab, withoutGoneConnection } from "./shell/closedTabs";
import PlaceSidebar from "./app/PlaceSidebar";
import WindowPanes from "./app/WindowPanes";
import { FormDialogs, StartModelDialog, type Form, type ModelStart } from "./app/WorkspaceDialogs";
import { featureGroups } from "./app/features";
import FeatureBar from "./components/FeatureBar";
import FeatureIcon from "./components/FeatureIcon";
import { hintFor } from "./commands/keymap";
import { useKeymap } from "./commands/useCommandKeys";
import { usePlaceDrafts } from "./app/usePlaceDrafts";
import { answerText, useQueryTabRefs } from "./app/queryTabRefs";
import { useAskKit } from "./app/useAskKit";
import { useDataFolder } from "./app/useDataFolder";
import { useSavedQueries } from "./app/useSavedQueries";
import { useStartup } from "./app/useStartup";
import { type RecentEnv, openRecentItem } from "./app/openRecent";
import { placeOf } from "./app/places";
import { useRecentList } from "./app/useRecentList";
import { useTableDrop } from "./app/useTableDrop";
import { useWorkspaceTabs } from "./app/useWorkspaceTabs";
import LaunchScreen from "./components/LaunchScreen";
import TabStrip from "./components/TabStrip";
import TitleBar from "./components/TitleBar";
import WorkEmpty from "./components/WorkEmpty";
import AssistantPanel from "./assistant/AssistantPanel";
import type { InsertTarget } from "./assistant/InsertDiff";
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
  moveTab,
  openSettingsTab,
  placeObject,
  tabConnectionId,
  tabKey,
  withRestored,
} from "./shell/tabs";
import { NEW_VISUAL_NAME, savedVisualModel } from "./visualquery/drafts";
import { emptyQuery } from "./visualquery/model";
import VisualQueryTab, { type VisualTabControl } from "./visualquery/VisualQueryTab";
import { useTheme } from "./theme/useTheme";
import { type CommandHandlers, KeymapProvider, useCommandKeys } from "./commands/useCommandKeys";
import { pressedKeys } from "./commands/keys";
import { backKeyApplies, useFkNav } from "./app/useFkNav";
import { PrefsProvider, useUngroupedLabel } from "./prefs/usePrefs";
import { objectKey } from "./objectPath";
import OneTree from "./sidebar/OneTree";
import { useTreeData } from "./sidebar/useTreeData";
import { unsavedFlows } from "./flow/flowRegistry";
import { isUnsaved } from "./shell/tabs";
import { pendingWork } from "./update/pendingWork";
import { setRestartGuard } from "./update/restartGuard";
import { flushColumnOrders } from "./grid/columnOrderStore";
import FirstStartGuide, { GUIDE_AGAIN, type GuideResult } from "./guide/FirstStartGuide";
import UpdatePill from "./update/UpdatePill";
import { recordStep, RecordStepContext, tabSteps } from "./assistant/recentSteps";
import { dailyCheck, loadUpdates } from "./update/updateStore";
import { cyclePane, focusWorkArea, rememberPaneFocus } from "./app/panes";
import { COMMANDS, type CommandId } from "./commands/registry";
import QuickOpen from "./palette/QuickOpen";
import { type PaletteCommand, type QuickItem, quickItems, savedItemId } from "./palette/entries";
import { objectNames } from "./palette/nameIndex";
import { readRecentCommands, rememberCommand } from "./palette/recentCommands";

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
  const { label: ungroupedLabel } = useUngroupedLabel();
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
    openTransferTab,
    setTransferMeta,
    openCompareTab,
    setCompareMeta,
    schemaClose,
    schemaCloseFor,
  } = useWorkspaceTabs();
  const [historyOpen, setHistoryOpen] = useState(false);
  const { map: keymap, available: commandAvailable, invoke: invokeCommand } = useKeymap();
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
  // F6 returns to where focus last was in each pane.
  useEffect(() => rememberPaneFocus(document), []);
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

  /**
   * The tab strip as Recent steps last saw it (spec 7.1). Tabs that come back by themselves (a place's saved tabs, the
   * Home opened at startup) are added to it before they show, so they are no step; a key that was already open
   * changes nothing, and the next tab the user opens is still one.
   */
  const stepStrip = useRef<{ place: string; keys: string[]; active: string | null } | null>(null);
  const tabsCameBack = (keys: string[]) => {
    const s = stepStrip.current;
    if (!s || keys.length === 0) return;
    s.keys = [...new Set([...s.keys, ...keys])];
    // The first one is made active only when none was, as the restore does.
    if (s.active === null) s.active = keys[0];
  };
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
        tabsCameBack(restored.map(tabKey));
        setTabs((t) => withRestored(t, restored));
        setActiveKey((k) => k ?? tabKey(restored[0]));
      }
      if (homeIfEmpty.current) {
        homeIfEmpty.current = false;
        // A tab you opened meanwhile stays active.
        if (restored.length === 0) {
          // Home opened for the user at startup is no step either.
          tabsCameBack(["home"]);
          showHome(true);
        }
      }
    },
  });
  const { placeNow, visit, whenDraftsLoaded } = drafts;

  // Recent steps (spec 7.1): a tab added to the strip is opened, an open tab made active is gone to. A place change
  // swaps the place's tabs and a restore brings back saved ones; neither is a step.
  const stepPlace = placeKey(place);
  const stripKeys = allTabs.map(tabKey);
  const stripKey = stripKeys.join("\n");
  useEffect(() => {
    const was = stepStrip.current;
    stepStrip.current = { place: stepPlace, keys: stripKeys, active: activeKey };
    if (!was || was.place !== stepPlace || startup.s !== "ready") return;
    for (const s of tabSteps(was.keys, was.active, allTabs, activeKey)) recordStep(stepPlace, s);
    // The strip's keys, the active key and the place are what changes a step; the tabs are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripKey, activeKey, stepPlace, startup.s]);

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

  /** A preview table tab becomes a kept tab (a double click on it, or working in it, G15). */
  const keepTab = useCallback(
    (key: string) =>
      setTabs((all) =>
        all.some((t) => t.kind === "object" && t.key === key && t.preview)
          ? all.map((t) => (t.kind === "object" && t.key === key && t.preview ? { ...t, preview: false } : t))
          : all,
      ),
    [],
  );
  const dirtyRef = useRef<ReadonlySet<string>>(new Set());
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
  dirtyRef.current = dirtyKeys;
  // UX step 8 (G8): followed Foreign Keys, and Back and Forward over them.
  const fkNav = useFkNav({
    tabs,
    setTabs,
    activeKey,
    setActiveKey,
    dirty: () => dirtyRef.current,
    control: (key) => gridControl(key).current,
    place: placeKey(place),
    say: (text) => toast.show({ kind: "info", text }),
  });
  // Alt+Left acts only where the rulings let it (a strip tab keeps its move); Ctrl+Alt+Left everywhere.
  const navKeys: CommandHandlers = {};
  for (const [id, run] of [
    ["nav.back", fkNav.back],
    ["nav.forward", fkNav.forward],
  ] as const) {
    Object.defineProperty(navKeys, id, { enumerable: true, get: () => (backKeyApplies(pressedKeys(), document.activeElement) ? run : undefined) });
  }
  useCommandKeys(navKeys);
  // ADR 0026: an update's restart asks about unsaved work first, as quitting does, and about unsaved tabs.
  useEffect(() =>
    setRestartGuard({
      pending: () => pendingWork({ tabs: [...tabs, ...windowTabs], isDirty, flows: unsavedFlows(), jobsRunning: jobsGuard.running() }),
      resolve: async () => {
        for (const name of unsavedFlows()) if (!(await confirmCloseFlow(name))) return false;
        for (const t of [...tabs, ...windowTabs].filter(isUnsaved)) if (!(await confirmCloseUnsaved(t))) return false;
        const keys = tableKeys();
        const jobsAsk = jobsGuard.running() ? { then: () => jobsGuard.confirmStop() } : undefined;
        if (keys.some(isDirty)) return confirmLeave(keys, jobsAsk);
        return jobsAsk ? jobsAsk.then() : true;
      },
      flush: () => Promise.all([drafts.flush(), flushColumnOrders()]).then(() => {}),
    }),
  );
  // The first start guide: on its own only in a data folder this start made; mounted only while open.
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => {
    let live = true;
    firstStartGuide()
      .then((open) => live && open && setGuideOpen(true))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  function closeGuide(result: GuideResult) {
    setGuideOpen(false);
    void firstStartGuideSeen().catch(() => {});
    if (result.error) toast.show({ kind: "error", text: result.error });
    else
      toast.show({
        kind: result.skipped ? "info" : "success",
        text: (
          <span className="guide-toast">
            <b>{result.skipped ? "Guide skipped" : "Contura is ready"}</b>
            <span>{GUIDE_AGAIN}</span>
          </span>
        ),
      });
    if (result.dialect) setForm({ kind: "connection", dialect: result.dialect });
  }
  // Update checks: off until the user turns them on; the Core runs the daily one at most once a day.
  useEffect(() => {
    void loadUpdates();
    const hourly = setInterval(() => void dailyCheck(), 60 * 60 * 1000);
    return () => clearInterval(hourly);
  }, []);
  // Item 8: the tab on top tells which database is in use on its Connection.
  useEffect(() => {
    const t = tabs.find((x) => tabKey(x) === activeKey);
    if (!t) return;
    const cid = tabConnectionId(t);
    const db = t.kind === "query" || t.kind === "visual" ? t.doc.database : (objectTabOf(t)?.path?.database ?? null);
    if (cid !== null && db) lastDatabase.current.set(cid, db);
  }, [activeKey, tabs]);

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
  /** The open Backup or Restore dialog (step 9), from the tree's menus. */
  const [backingUp, setBackingUp] = useState<{ connectionId: ConnectionId; database: string; schema: string | null } | null>(null);
  const [restoring, setRestoring] = useState<{ target: RestoreTarget; attach?: { id: JobId; run: RestoreRun }; seq: number } | null>(null);
  /** Each Restore started, so one in the background still ends right and the status bar can open it again. */
  const restoreRuns = useRef(new Map<JobId, { target: RestoreTarget; run: RestoreRun }>());
  const restoresEnded = useRef(new Set<JobId>());
  /** The job each Import tab started last, by tab key (its `onJob`). */
  const [importJobs, setImportJobs] = useState<ReadonlyMap<string, JobId>>(new Map());
  const importJobsRef = useRef(importJobs);
  importJobsRef.current = importJobs;
  /** The running job of each Data Transfer tab, by tab id, so closing it asks first. */
  const transferJobs = useRef(new Map<string, JobId>());
  /** Each Schema Compare tab's Apply job while it runs. */
  const compareJobs = useRef(new Map<string, JobId>());
  const jobsNow = useRef(jobs.jobs);
  jobsNow.current = jobs.jobs;

  /** A Restore ended: the tree refreshes and the completion schema cache is invalidated. */
  function restoreDone(connectionId: ConnectionId) {
    tree.refresh(connectionId);
    lang.schemas.invalidate(connectionId);
    schemaMayHaveChanged(connectionId);
  }

  /** The AI Context is checked again on the next Ask; a failure here changes nothing the user sees. */
  function schemaMayHaveChanged(connectionId: ConnectionId) {
    void aiContextChanged(connectionId).catch(() => {});
  }

  /** SQLite "Add it as a Connection" (R4): the Core returns the new file; the Connection is added here. */
  async function addRestoredFile(file: string, groupId: GroupId | null) {
    try {
      await saveConnection({
        id: null,
        name: fileName(file).replace(/\.[^.]+$/, ""),
        dialect: "sqlite",
        file,
        host: "",
        port: 0,
        user: "",
        database: null,
        ssl: { mode: "disable" },
        password: { t: "clear" },
        groupId,
        queryTimeoutSecs: null,
        aiAccess: "never",
        production: false,
        readOnly: false,
      });
      await reload();
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  // A Restore that ended in the background: its end work and toast, once (its dialog is closed).
  useEffect(() => {
    for (const j of jobs.jobs) {
      if (j.kind !== "restore" || !j.background || !j.done || restoresEnded.current.has(j.id)) continue;
      restoresEnded.current.add(j.id);
      const kept = restoreRuns.current.get(j.id);
      const c = connections.find((x) => x.id === j.connectionId);
      const done = j.done;
      if ("report" in done) {
        restoreDone(j.connectionId);
        const r = done.report.restore;
        if (kept?.run.addConnection && r?.newFile) void addRestoredFile(r.newFile, c?.groupId ?? null);
        toast.show({
          kind: "success",
          text: r
            ? restoredText(kept?.run.source ?? j.subject ?? null, c?.dialect === "sqlite" ? fileName(r.database) : r.database, r.tables, r.rows, done.report.elapsedMs, r.countsMatch)
            : (kept ? `Restored ${kept.run.source} into ${kept.run.into}.` : "Restored."),
        });
      } else if (done.error.kind === "cancelled") {
        const newName = kept?.run.mode === "newDatabase" ? (c?.dialect === "sqlite" ? fileName(kept.run.into) : kept.run.into) : null;
        toast.show({ kind: "info", text: restoreStoppedText(c?.dialect ?? "postgres", newName, j.statementsDone, kept ? runStatements(kept.run.check, kept.run.runAsIs ?? false) : null) });
      } else {
        toast.show({ kind: "error", text: c ? restoreErrorText(done.error, c) : errorText(done.error) });
      }
      restoreRuns.current.delete(j.id);
      jobs.dismiss(j.id);
    }
    // Reacts to the job list only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.jobs]);

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
    // Backup and Restore show their progress in the status bar only once their dialog is closed.
    if (job.kind === "restore") {
      const kept = restoreRuns.current.get(id);
      if (kept) setRestoring((r) => ({ target: kept.target, attach: { id, run: kept.run }, seq: (r?.seq ?? 0) + 1 }));
      return;
    }
    if (job.kind === "backup" || job.kind === "restoreCheck") return;
    if (job.kind === "transfer") {
      const tab = [...transferJobs.current].find(([, j]) => j === id)?.[0];
      if (tab) setActiveKey(`transfer:${tab}`);
      return;
    }
    const held = [...importJobs].find(([, j]) => j === id)?.[0];
    const tab =
      tabsRef.current.find((t) => t.kind === "import" && t.key === held) ??
      tabsRef.current.find((t) => t.kind === "import" && t.connectionId === job.connectionId);
    if (tab) setActiveKey(tabKey(tab));
  }

  const closed = useClosedTabs({
    connections,
    open: openClosed,
    note: (text) => toast.show({ kind: "info", text }),
  });

  /** A New table tab its create turned into a design tab: its key then, or null when it closed instead. */
  const createdTabs = useRef(new Map<string, string | null>());

  /** Closes a tab: a table with Pending Edits or an unapplied design asks first, a Schema Model through its own Close. */
  async function closeTab(key: string): Promise<boolean> {
    const tab = [...tabs, ...windowTabs].find((t) => tabKey(t) === key);
    if (!tab) return false;
    if (objectTabOf(tab) && !(await confirmLeave([key]))) return false;
    // A running import asks to cancel and roll back; one with only a mapping closes at once.
    if (tab.kind === "import" && !(await jobsGuard.confirmCloseImport(importJobOf(key)))) return false;
    // A running transfer asks "Cancel the transfer and roll back?"; one only set up closes at once.
    if (tab.kind === "transfer" && !(await jobsGuard.confirmCloseTransfer(transferJobs.current.get(tab.id) ?? null))) return false;
    // A compare whose Apply runs asks "Cancel Apply?" (R6).
    if (tab.kind === "compare" && !(await jobsGuard.confirmCloseCompare(compareJobs.current.get(tab.id) ?? null))) return false;
    // A New table created through the ask's Apply is its table's design tab now: that tab closes (M2).
    const created = createdTabs.current.get(key);
    if (created !== undefined) {
      createdTabs.current.delete(key);
      if (created) dropTab(created);
      return true;
    }
    if (!(await confirmCloseUnsaved(tab))) return false;
    if (tab.kind === "flow" && !(await confirmCloseFlow(tab.name))) return false;
    closed.remember(tab);
    const builderClose = tab.kind === "schema" ? schemaCloseFor(tab.id) : null;
    // A Schema Model closes through its own ask; Cancel there keeps the tab and answers false.
    if (builderClose) return builderClose();
    dropTab(key);
    return true;
  }

  /**
   * Closes several tabs one after another, each through its own unsaved-changes ask (so no work is lost); the first
   * one kept (Cancel) stops the rest. The tab the menu was opened on stays and is shown.
   */
  async function closeTabs(keys: string[], keep: string) {
    const hadActive = keys.includes(activeKey ?? "");
    for (const key of keys) if (!(await closeTab(key))) return;
    // Only once every ask is through: a Cancel leaves the tab that was shown where it was.
    if (hadActive) setActiveKey(keep);
  }

  /** Shows a tab Reopen closed tab took off the stack: by its object, so a table is read again. */
  function openClosed(shown: ClosedTab) {
    const { closed: c, note } = withoutGoneConnection(shown, new Set(connections.map((x) => x.id)));
    if (note) toast.show({ kind: "info", text: note });
    switch (c.kind) {
      case "object":
        return openObject(c.selection, { newTab: true });
      case "design":
        return openDesign(c.connectionId, c.path);
      case "lineage":
        return openLineage(c.connectionId, c.path);
      case "flow":
        return openFlowTab(c.name);
      case "savedQueries":
        return openSavedList();
      case "query":
      case "visual": {
        if (c.kind === "query" && c.tooLarge) toast.show({ kind: "info", text: "This query was too large to keep after closing." });
        const tab: WorkTab = c.kind === "query" ? { kind: "query", doc: c.doc } : { kind: "visual", doc: c.doc };
        setTabs((all) => (all.some((t) => tabKey(t) === tabKey(tab)) ? all : [...all, tab]));
        setActiveKey(tabKey(tab));
      }
    }
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

  /** Opens a table (or another object): a single click reuses the preview tab, a double click (`newTab`) keeps its own (item 1). */
  function openObject(selection: Selection, opts: { newTab?: boolean } = {}) {
    // Item 12: opening or browsing a table is not history; Recent lists a table once its data is saved or its design applied.
    const key = objectKey(selection.connectionId, selection.kind, selection.path);
    // Worked out on the latest tabs: a Recent open runs after drafts were restored into them.
    setTabs((all) => placeObject(all, selection, key, opts.newTab ?? false, dirtyRef.current));
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
    record({ kind: "table", path, object: "table" }, connectionId);
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

  /** Item 8: the database used last on each Connection (a tab shown, a tree row picked), for new query tabs. */
  const lastDatabase = useRef(new Map<ConnectionId, string>());
  function newQuery(connectionId: ConnectionId | null, text = "", database?: string) {
    const c = connections.find((x) => x.id === connectionId) ?? null;
    if (database === undefined && c) database = lastDatabase.current.get(c.id);
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

  /** Ctrl+Alt+1 to Ctrl+Alt+9: the places in the switcher's order (PR7). */
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

  // ---- Quick Open and the Command Palette (UX step 6, S1): one box, `>` typed first for the commands ----
  const [quick, setQuick] = useState<{ initial: string; seq: number; commands: PaletteCommand[]; recentCommands: CommandId[] } | null>(null);
  /** Set when Quick Open opens a tab in front: focus goes into it once it shows (VS Code). */
  const focusWork = useRef(false);
  /** Bumped with each open from Quick Open, so the focus effect runs even when no tab changed. */
  const [focusTick, setFocusTick] = useState(0);
  const placeNameOf = (p: Place) => (p.kind === "group" ? (groups.find((g) => g.id === p.groupId)?.name ?? null) : ungroupedLabel);
  function showQuick(initial: string) {
    loadDiagrams();
    focusWork.current = false;
    const places = menuPlaces(groups);
    const note = (id: CommandId) => {
      const n = /^group\.open\.(\d)$/.exec(id);
      const p = n ? places[Number(n[1]) - 1] : undefined;
      return p ? placeNameOf(p) : null;
    };
    // Read now, while focus is still where the key was pressed: an editor's commands show only for its tab.
    const commands = COMMANDS.filter((c) => commandAvailable(c.id)).map((c) => ({ command: c, keys: hintFor(keymap, c.id), note: note(c.id) }));
    setQuick((q) => ({ initial, seq: (q?.seq ?? 0) + 1, commands, recentCommands: readRecentCommands() }));
  }
  /** The item the active tab shows, which Recent leaves out. */
  const activeItemId = (() => {
    const t = [...tabs, ...windowTabs].find((x) => tabKey(x) === activeKey);
    if ((t?.kind === "query" || t?.kind === "visual") && t.doc.savedId) return savedItemId(t.doc.savedId);
    return activeKey;
  })();
  const quickList = useMemo(
    () =>
      quick ? quickItems({ connections, openIds, names: objectNames, savedQueries, diagrams, recent, activeId: activeItemId }) : null,
    // The index is read again whenever the tree loads (its branches change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quick?.seq, connections, openIds, savedQueries, diagrams, recent, activeItemId, tree.branches],
  );
  /** Opens a Quick Open item through the app's own open paths; `behind` keeps the tab you are on. */
  function openQuickItem(item: QuickItem, how: "enter" | "behind") {
    const was = activeKey;
    const behind = how === "behind";
    const shown = <T extends unknown[]>(open: (...a: T) => void) => (...a: T) => {
      if (!behind) {
        focusWork.current = true;
        setFocusTick((n) => n + 1);
      }
      open(...a);
      if (behind && was !== null) setActiveKey(was);
    };
    const t = item.target;
    // Chosen by name, so meant: a kept tab, never a preview (VS Code's Quick Open).
    const keptObject = shown((selection: Selection) => openObject(selection, { newTab: true }));
    if (t.kind === "flow") return shown(openFlowTab)(t.name);
    if (t.kind === "saved") return shown(openSavedHere)(t.query);
    if (t.kind === "object") {
      const c = connections.find((x) => x.id === t.connectionId);
      if (c && openIds.has(c.id) && placeKey(placeOf(c)) === placeKey(placeNow.current)) {
        return keptObject({ connectionId: c.id, kind: t.object, path: t.path });
      }
    }
    // A closed Connection (or one in another place) opens first, as Recent does.
    const item_: RecentItem =
      t.kind === "recent" ? t.item : { target: { kind: "table", path: t.path, object: t.object }, connectionId: t.connectionId, openedAtMs: 0 };
    void openRecentItem(item_, { ...recentEnv(), openObject: keptObject, openSaved: shown(openSaved), openBuilder: shown(openBuilder) });
  }
  useEffect(() => {
    // Once, after the open's own render: an open that changed nothing (the tab was already shown) still lands in it.
    if (!focusWork.current) return;
    focusWork.current = false;
    focusWorkArea();
  }, [focusTick]);

  // The app's command keys; the rest of the registry is wired as each command arrives.
  useCommandKeys({
    // S1: VS Code's Quick Open (Ctrl+P, and Ctrl+K as Edge's search) and Command Palette (Ctrl+Shift+P).
    "quickOpen.show": () => showQuick(""),
    "palette.show": () => showQuick(">"),
    // Query History from anywhere a Connection is open, as the feature bar's History (keyless; the palette runs it).
    ...(openIds.size > 0
      ? {
          "history.toggle": () => {
            const shownTab = tabs.find((x) => tabKey(x) === activeKey);
            if (shownTab?.kind === "query") {
              setHistoryAll(false);
              setHistoryOpen((o) => !o);
            } else showAllHistory();
          },
        }
      : {}),
    // A new query tab, on the active Connection.
    "query.new": () => newQuery(activeId),
    // The panel follows every tab but a diagram, which has its own assistant (ADR 0023).
    "assistant.toggle": () => {
      if (activeWindow?.kind === "flow") {
        // S11: the key always answers.
        toast.show({ kind: "info", text: "A diagram has its own Assistant, so the Ask panel stays closed here." });
        return;
      }
      setAssistantOpen((o) => !o);
    },
    "settings.open": () => openSettings(),
    "tab.reopen": () => void closed.reopen(),
    "home.open": () => goHome(),
    "pane.next": () => cyclePane(1),
    "pane.previous": () => cyclePane(-1),
    "connection.new": () => setForm({ kind: "connection" }),
    // Only the places that exist, so the palette lists those alone.
    ...Object.fromEntries(menuPlaces(groups).slice(0, 9).map((_, i) => [`group.open.${i + 1}`, () => openPlaceAt(i + 1)])),
    "flow.fromMermaid": () => setMermaidOpen(true),
    "flow.new": () => setNewDiagramOpen(true),
    ...(activeDiagram
      ? {
          "flow.saveCopy": () => void diagramFiles.saveCopy(activeDiagram),
          "flow.rename": () => diagramFiles.rename(activeDiagram),
          "flow.delete": () => diagramFiles.remove(activeDiagram),
        }
      : {}),
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
    openQuery: (connectionId, text, database) => newQuery(connectionId, text, database ?? undefined),
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
    closed.clear();
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

  /**
   * Opens the Settings tab (one at most). With a section (and a `row` in it) it goes there; without one an open tab
   * keeps the page it shows, and a new tab starts on Appearance.
   */
  function openSettings(section?: SettingsSection, row?: string) {
    setForm({ kind: "none" });
    setWindowTabs((w) => openSettingsTab(w, section, row));
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

  /** How Recent (and Quick Open, for a closed Connection) reaches the place, the Connection and the item. */
  function recentEnv(): RecentEnv {
    return {
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
    };
  }

  function openRecent(item: RecentItem) {
    return openRecentItem(item, recentEnv());
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
    toast: (t) => toast.show(t),
    confirmJobs: (id) => jobsGuard.confirmStop(id),
    confirmImports: (id) => confirmImportsLeave(id),
  });

  if (startup.s === "loading") return <LaunchScreen step={step} startedAt={startedAt} />;
  if (startup.s === "failed") return <StartupFailed message={startup.message} onRetry={retry} />;

  const group = place.kind === "group" ? groups.find((g) => g.id === place.groupId) : undefined;
  const workspaceGroupId = place.kind === "group" ? place.groupId : null;
  const placeName = group?.name ?? ungroupedLabel;
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

  const assistantShown = assistantOpen && activeWindow?.kind !== "flow";
  // An answer's SQL goes into the active query tab, through the Insert diff.
  const answerTarget: InsertTarget | null =
    current?.kind === "query" ? { editor: () => refs.editor(current.doc.id), name: current.doc.name } : null;
  // Every tab but a diagram has a target; the screen's own fields come through the tab registry (tabAsk.ts).
  const assistantTab = activeWindow ?? current;
  const assistantTarget = assistantTargetFor(assistantTab, inPlace, connections);
  const assistantSchema =
    assistantTarget?.doc && assistantTarget.connection && assistantTarget.database
      ? lang.client.sqlSchemaFor(schemaKey(assistantTarget.connection.id, assistantTarget.database))
      : null;
  // Read from the editor on each draw, so the Ask context follows the statement where you are typing (see the note below).
  const stmt = assistantShown && assistantTarget?.doc ? (refs.editor(assistantTarget.doc.id)?.runTarget() ?? null) : null;
  const assistantContext = assistantShown && assistantTarget ? assistantContextFor(assistantTarget, assistantSchema, stmt) : null;

  // ---- The feature bar (item 16): each feature on the open Connection and database, or off saying why ----
  const featureConn = visualTarget ? connections.find((c) => c.id === visualTarget.id) : undefined;
  const featureDb = featureConn
    ? (visualTarget?.database ?? (featureConn.dialect === "sqlite" ? "main" : featureConn.database) ?? null)
    : null;
  const featureTarget = featureConn && featureDb ? { connectionId: featureConn.id, database: featureDb, schema: null } : null;
  const features = featureGroups({
    target: featureTarget,
    postgres: featureConn?.dialect === "postgres",
    table: selection?.kind === "table",
    keys: { newQuery: hintFor(keymap, "query.new"), diagram: hintFor(keymap, "flow.new"), ask: hintFor(keymap, "assistant.toggle") },
    askReady: activeWindow?.kind !== "flow",
    newQuery: () => newQuery(activeId),
    newVisualQuery: () => visualTarget && newVisualQuery(visualTarget.id, visualTarget.database),
    newTable: () => featureTarget && newTable(featureTarget.connectionId, featureTarget.database, null),
    importInto: () => featureTarget && openImport(featureTarget.connectionId, { kind: "database", database: featureTarget.database }),
    exportTable: () => selection && void exportTable(selection),
    transfer: () =>
      featureTarget &&
      openTransferTab({ connectionId: featureTarget.connectionId, database: featureTarget.database, schema: null, table: selection?.kind === "table" ? selection.path.name : null }),
    backup: () => featureTarget && featureConn?.dialect !== "postgres" && setBackingUp(featureTarget),
    restore: () => featureTarget && setRestoring((r) => ({ target: featureTarget, seq: (r?.seq ?? 0) + 1 })),
    compare: () => featureTarget && openCompareTab({ source: { kind: "database", ...featureTarget }, target: null }),
    newModel: () => setModelStart(featureTarget ? { initial: featureTarget } : {}),
    newDiagram: () => setNewDiagramOpen(true),
    history: () => (current?.kind === "query" ? (setHistoryAll(false), setHistoryOpen((o) => !o)) : showAllHistory()),
    ask: () => setAssistantOpen((o) => !o),
  });

  const app = (
    <div className="app">
      <TitleBar>
        {/* Item 13: Home, in words, at the start of the title bar. */}
        <button
          type="button"
          className="title-home"
          aria-current={activeKey === "home" ? "page" : undefined}
          title={hintFor(keymap, "home.open") ? `Home (${hintFor(keymap, "home.open")})` : "Home"}
          onClick={goHome}
        >
          <FeatureIcon name="home" size={18} />
          Home
        </button>
        <span className="title-divider" aria-hidden="true" />
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
          active={activeKey}
          onSelect={setActiveKey}
          onClose={(key) => void closeTab(key)}
          onReorder={(from, to) => {
            if (tabs.some((t) => tabKey(t) === from) && tabs.some((t) => tabKey(t) === to)) setTabs((all) => moveTab(all, from, to));
            else setWindowTabs((all) => moveTab(all, from, to));
          }}
          onKeep={keepTab}
          onCloseMany={(keys, keep) => void closeTabs(keys, keep)}
          onReopen={() => void closed.reopen()}
          canReopen={closed.count > 0}
          dirtyKeys={dirtyKeys}
          onNew={() => newQuery(activeId)}
          onNewVisual={() => visualTarget && newVisualQuery(visualTarget.id, visualTarget.database)}
          newVisualReady={visualTarget !== null}
          onNewDiagram={() => setNewDiagramOpen(true)}
          onNewModel={() => setModelStart(featureTarget ? { initial: featureTarget } : {})}
          newQueryWhere={(() => {
            const c = connections.find((x) => x.id === activeId);
            const db = current?.kind === "query" ? current.doc.database : (c?.database ?? null);
            return c ? `On ${c.name}${db ? `, ${db}` : ""}` : null;
          })()}
          diagramActions={diagramActions}
        />
      </TitleBar>
      <FeatureBar groups={features.groups} end={features.end} />

      <div
        className={
          activeWindow
            ? `body body-home${assistantShown ? " body-ai" : ""}`
            : `body${historyFor || historyAllShown ? " body-history" : ""}${assistantShown ? " body-ai" : ""}`
        }
      >
        <div className="place-wrap">
          {/* The place's sidebar stays mounted under a window tab, so its tree keeps where you were. */}
          <PlaceSidebar
            group={group}
            groups={groups}
            placeName={placeName}
            hidden={!!activeWindow}
            empty={inPlace.length === 0}
            notice={notice}
            onEditGroup={() => setForm({ kind: "group" })}
            onRenamed={() => void reload()}
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
              onTransfer={openTransferTab}
              onCompare={(side) => openCompareTab({ source: { kind: "database", ...side }, target: null })}
              onBackup={setBackingUp}
              onRestore={(target) => setRestoring((r) => ({ target, seq: (r?.seq ?? 0) + 1 }))}
              onMoveConnection={(id, to) => void actions.moveFromTree(id, to)}
              onNewGroup={() => setForm({ kind: "newGroup" })}
              onClearHistory={(id) => void actions.clearHistoryFromTree(id)}
              onDeleteConnection={(id) => void actions.deleteFromTree(id)}
              onRefresh={(id) => {
                lang.schemas.invalidate(id);
                schemaMayHaveChanged(id);
              }}
              onResync={(id) => void actions.resyncFromTree(id)}
              onOpenSaved={openSavedHere}
              onOpenSavedList={openSavedList}
              onSavedChanged={reloadSaved}
              openStatus={openStatus}
              onUseDatabase={(id, db) => lastDatabase.current.set(id, db)}
              onFocusBranch={(id) => {
                setTreeBranch(id);
                if (id !== null) setActiveId(id);
              }}
            />
          </PlaceSidebar>

          <main className="work" data-pane>
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
                onSettings: () => openSettings(),
                onNewDiagram: () => setNewDiagramOpen(true),
                diagrams,
                onOpenDiagram: (name) => openFlowTab(name),
                diagramActions,
                onShowGuide: () => setGuideOpen(true),
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
                onSection: (section, aiPage) =>
                  setWindowTabs((w) => w.map((x): WindowTab => (x.kind === "settings" ? { ...x, section, aiPage, row: undefined } : x))),
                onConnectionSaved: () => {
                  // Only the AI access changed, so open sessions and their transactions stay as they are.
                  void reload();
                },
                onShowGuide: () => setGuideOpen(true),
              }}
              schema={{
                onClose: (key) => dropTab(key),
                closeRef: (id) => schemaClose(id),
                onPathChange: (id, path) => modelSavedAs(id, path),
                ask: askKit,
                sourceConnection: (id) => schemaSources.get(id),
                onApplyToConnection: (source) => openCompareTab({ source: { kind: "model", ...source }, target: null }),
              }}
              transfer={{
                connections,
                groups,
                onMeta: setTransferMeta,
                onJob: (id, job) => {
                  if (job) transferJobs.current.set(id, job);
                  else transferJobs.current.delete(id);
                },
                onOpenInEditor: (side, sql) => newQuery(side.connectionId, sql, side.database),
                onOpenTarget: ({ connectionId, ...path }) => {
                  lang.schemas.invalidate(connectionId, path.database);
                  tree.refresh(connectionId);
                  setReveal((r) => ({ connectionId, database: path.database, schema: path.schema, name: path.name, seq: (r?.seq ?? 0) + 1 }));
                },
              }}
              flow={{ onOpenSettings: () => openSettings("ai", "tools") }}
              compare={{
                connections,
                groups,
                onMeta: setCompareMeta,
                onOpenInEditor: (target, sql) => newQuery(target.connectionId, sql, target.database),
                onApplied: (target, tables, dropped) => {
                  // The target's tree and completion schemas load again; open table tabs get the table-changed event,
                  // and the tabs of dropped tables close.
                  lang.schemas.invalidate(target.connectionId, target.database);
                  tree.refresh(target.connectionId);
                  for (const path of tables) void reloadGrid(target.connectionId, path);
                  for (const path of dropped) tableDropped(target.connectionId, path);
                },
                onJob: (id, job) => {
                  if (job) compareJobs.current.set(id, job);
                  else compareJobs.current.delete(id);
                },
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
                    askKey={t.key}
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
                    onWorked={t.preview ? () => keepTab(t.key) : undefined}
                    controlRef={gridControl(t.key)}
                    visible={t.key === activeKey}
                    connectionName={c?.name}
                    rowEstimate={s.kind === "table" ? tree.estimate(s.connectionId, s.path) : null}
                    onOpenQuery={(sql) => newQuery(s.connectionId, sql, s.path.database)}
                    onDesign={s.kind === "table" ? () => openDesign(s.connectionId, s.path) : undefined}
                    onLineage={s.kind === "table" ? () => openLineage(s.connectionId, s.path) : undefined}
                    onExport={s.kind === "table" ? (origin) => openExport(s.connectionId, origin) : undefined}
                    onImport={s.kind === "table" ? () => openImport(s.connectionId, { kind: "table", path: s.path }) : undefined}
                    onTransfer={
                      s.kind === "table"
                        ? () => openTransferTab({ connectionId: s.connectionId, database: s.path.database, schema: s.path.schema, table: s.path.name })
                        : undefined
                    }
                    version={gridVersions[t.key] ?? 0}
                    onSaved={() => record({ kind: "table", path: s.path, object: s.kind === "view" ? "view" : "table" }, s.connectionId)}
                    open={openIds.has(s.connectionId)}
                    onFollow={s.kind === "table" ? (req) => fkNav.follow(t.key, req) : undefined}
                    jump={fkNav.jumpFor(t.key)}
                    nav={s.kind === "table" ? { ...fkNav.nav, onBack: fkNav.back, onForward: fkNav.forward } : undefined}
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
                    askKey={t.key}
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
                    askKey={key}
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
                    askKey={key}
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
              placeName={placeName}
              groupId={workspaceGroupId}
              context={assistantContext}
              tabKey={assistantTab && assistantTab.kind !== "flow" ? tabKey(assistantTab) : null}
              schema={assistantSchema}
              onOpenSettings={() => openSettings("ai")}
              seed={chatSeed}
              connections={connections}
              onClose={() => setAssistantOpen(false)}
              insertTarget={answerTarget}
              onOpenInNewTab={(sql, c) => newQuery(c?.id ?? null, answerText(sql), c?.database ?? undefined)}
              openIds={openIds}
            />
          )}
        </div>
      </div>

      <StatusBar
        screen={statusScreen}
        theme={theme.choice}
        onTheme={theme.choose}
        onSettings={() => openSettings()}
        settingsKey={hintFor(keymap, "settings.open") ?? undefined}
        jobs={
          <>
            <UpdatePill onOpen={() => openSettings("updates")} />
            <JobStatusItem
              jobs={jobs.jobs}
              onOpen={openJob}
              onEnded={jobs.dismiss}
              dialectOf={(id) => connections.find((c) => c.id === id)?.dialect}
            />
          </>
        }
      />

      {guideOpen && <FirstStartGuide theme={theme.choice} effective={theme.effective} onTheme={theme.choose} onClose={closeGuide} />}
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
      {backingUp &&
        (() => {
          const c = connections.find((x) => x.id === backingUp.connectionId);
          if (!c) return null;
          return (
            <BackupDialog
              connection={c}
              group={c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
              database={backingUp.database}
              schema={backingUp.schema}
              onClose={() => setBackingUp(null)}
            />
          );
        })()}
      {restoring &&
        (() => {
          const c = connections.find((x) => x.id === restoring.target.connectionId);
          if (!c) return null;
          return (
            <RestoreDialog
              key={restoring.seq}
              connection={c}
              group={c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null}
              target={restoring.target}
              attach={restoring.attach}
              onStarted={(id, run) => restoreRuns.current.set(id, { target: restoring.target, run })}
              onClose={() => setRestoring(null)}
              onRestored={() => restoreDone(c.id)}
              onOpenInTree={(database) => {
                if (c.dialect === "sqlite") return;
                const schema = c.dialect === "postgres" ? restoring.target.schema : null;
                setReveal((r) => ({ connectionId: c.id, database, schema, name: "", seq: (r?.seq ?? 0) + 1 }));
              }}
              onAddConnection={(file) => addRestoredFile(file, c.groupId)}
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
      {quick && quickList && (
        <QuickOpen
          initial={quick.initial}
          seq={quick.seq}
          all={quickList.all}
          noOpenConnection={openIds.size === 0}
          recentIds={quickList.recentIds}
          commands={quick.commands}
          recentCommands={quick.recentCommands}
          quickOpenKeys={keymap.get("quickOpen.show") ?? []}
          paletteKeys={keymap.get("palette.show") ?? []}
          onOpen={openQuickItem}
          onRun={(id) => {
            rememberCommand(id);
            invokeCommand(id);
          }}
          onClose={() => setQuick(null)}
        />
      )}
      <StartModelDialog
        modelStart={modelStart}
        connections={connections}
        openIds={openIds}
        onStartModel={openBuilder}
        onCancelModel={() => setModelStart(null)}
      />
    </div>
  );
  return (
    <GroupImagesProvider value={groupImages}>
      <RecordStepContext.Provider value={stepPlace}>{app}</RecordStepContext.Provider>
    </GroupImagesProvider>
  );
}
