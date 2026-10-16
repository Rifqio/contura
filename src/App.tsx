import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  errorText,
  isNotOpen,
  lastGroup,
  listConnections,
  listGroups,
  listSavedQueries,
  loadQueryTabs,
  objectDefinition,
  openConnection,
  saveQueryTabs,
  setLastGroup,
} from "./api/client";
import type { ConnectionConfig, ConnectionId, Group, GroupId, SavedQuery } from "./api/types";
import ConnectionForm from "./components/ConnectionForm";
import ConnectionList from "./components/ConnectionList";
import DataGrid from "./components/DataGrid";
import GroupForm from "./components/GroupForm";
import GroupSwitcher, { type Place } from "./components/GroupSwitcher";
import Home from "./components/Home";
import Icon from "./components/Icon";
import ObjectTree from "./components/ObjectTree";
import TabStrip, { type Selection, type WorkTab } from "./components/TabStrip";
import { appLang } from "./lang/appLang";
import { nextQueryName, parseDrafts, placeKey, serializeDrafts } from "./query/drafts";
import HistoryPanel from "./query/HistoryPanel";
import QueryTab, { type QueryTabDoc } from "./query/QueryTab";
import SavedQueries from "./query/SavedQueries";
import type { SqlEditorApi } from "./query/SqlEditor";
import SchemaBuilder, { type ModelDoc } from "./schema/SchemaBuilder";
import StartModel from "./schema/StartModel";
import { objectKey, objectPrefix } from "./objectPath";

type Form = { kind: "none" } | { kind: "group" } | { kind: "connection"; connection?: ConnectionConfig };

type Startup = { s: "loading" } | { s: "ready" } | { s: "failed"; message: string };

/** How long typing pauses before the query tab drafts are saved. */
const DRAFT_SAVE_MS = 500;

function DefinitionView({
  selection,
  onClose,
  onNotOpen,
}: {
  selection: Selection;
  onClose: () => void;
  onNotOpen: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    objectDefinition(selection.connectionId, selection.kind, selection.path)
      .then((t) => live && setText(t))
      .catch((e) => {
        if (!live) return;
        if (isNotOpen(e)) onNotOpen();
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // The parent re-keys this view per object.
  }, []);

  return (
    <section className="grid-view" aria-label={`Definition of ${selection.path.name}`}>
      <div className="toolbar">
        <Icon name={selection.kind === "trigger" ? "trigger" : "routine"} className="muted" />
        <h2 className="toolbar-title">
          <span className="muted">{objectPrefix(selection.path)}</span>
          {selection.path.name}
        </h2>
        <span className="toolbar-meta">{selection.kind}</span>
        <button type="button" className="icon-button" aria-label={`Close ${selection.path.name}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="grid-scroll">
        {error ? (
          <p className="state-panel error-text" role="alert">
            {error}
          </p>
        ) : text === null ? (
          <p className="state-panel muted">Loading the definition…</p>
        ) : (
          <pre className="definition">{text}</pre>
        )}
      </div>
    </section>
  );
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export default function App() {
  const [startup, setStartup] = useState<Startup>({ s: "loading" });
  const [groups, setGroups] = useState<Group[]>([]);
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [place, setPlace] = useState<Place>({ kind: "home" });
  const [openIds, setOpenIds] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [activeId, setActiveId] = useState<ConnectionId | null>(null);
  const [tabs, setTabs] = useState<WorkTab[]>([]);
  const [activeTab, setActiveTab] = useState(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [form, setForm] = useState<Form>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [schema, setSchema] = useState<
    | { kind: "start"; initial?: { connectionId: ConnectionId; database: string; schema: string | null } }
    | { kind: "builder"; doc: ModelDoc }
    | null
  >(null);
  const editorRefs = useRef(new Map<string, MutableRefObject<SqlEditorApi | null>>());
  // One language worker and one schema index for every query tab, for the app's lifetime.
  const lang = appLang();
  const [reveal, setReveal] = useState<{
    connectionId: ConnectionId;
    database: string;
    schema: string | null;
    name: string;
    seq: number;
  } | null>(null);
  /** The place whose drafts are loaded, so saving never overwrites drafts not yet read. */
  const draftsLoaded = useRef<string | null>(null);

  const start = useCallback(async () => {
    setStartup({ s: "loading" });
    try {
      const [g, c, last] = await Promise.all([listGroups(), listConnections(), lastGroup()]);
      setGroups(g);
      setConnections(c);
      setPlace(last && g.some((x) => x.id === last) ? { kind: "group", groupId: last } : { kind: "home" });
      setStartup({ s: "ready" });
    } catch (e) {
      setStartup({ s: "failed", message: errorText(e) });
    }
    // Saved Queries are a convenience at startup: without them the app still works.
    listSavedQueries()
      .then(setSavedQueries)
      .catch(() => setSavedQueries([]));
  }, []);

  useEffect(() => {
    start();
  }, [start]);

  const draftKey = place.kind === "home" ? null : placeKey(place);
  const queryDocs = tabs.flatMap((t) => (t.kind === "query" ? [t.doc] : []));
  const draftsJson = serializeDrafts(queryDocs);

  // Entering a place brings back its query tabs.
  useEffect(() => {
    if (!draftKey || startup.s !== "ready") return;
    let live = true;
    draftsLoaded.current = null;
    loadQueryTabs(draftKey)
      .then((json) => {
        if (!live) return;
        const docs = json ? parseDrafts(json) : [];
        if (docs.length > 0) {
          setTabs((t) => [...docs.map((doc): WorkTab => ({ kind: "query", doc })), ...t]);
          setActiveTab((a) => (a < 0 ? 0 : a + docs.length));
        }
        draftsLoaded.current = draftKey;
      })
      .catch(() => {
        if (live) draftsLoaded.current = draftKey;
      });
    return () => {
      live = false;
    };
  }, [draftKey, startup.s]);

  useEffect(() => {
    if (!draftKey || draftsLoaded.current !== draftKey) return;
    const t = setTimeout(() => void saveQueryTabs(draftKey, draftsJson).catch(() => {}), DRAFT_SAVE_MS);
    return () => clearTimeout(t);
  }, [draftsJson, draftKey]);

  // A Connection moved to another Group leaves this place: drop it as the active one and close its tables.
  useEffect(() => {
    if (place.kind === "home") return;
    const here = place.kind === "group" ? place.groupId : null;
    const isHere = (id: ConnectionId) => connections.some((c) => c.id === id && c.groupId === here);
    if (activeId !== null && !isHere(activeId)) setActiveId(null);
    if (tabs.some((t) => t.kind === "object" && !isHere(t.selection.connectionId))) {
      removeTabs((t) => t.kind === "object" && !isHere(t.selection.connectionId));
    }
  }, [connections, place, activeId, tabs]);

  /** Removes matching tabs, keeping the active tab when it stays. */
  function removeTabs(drop: (t: WorkTab) => boolean) {
    setTabs((all) => {
      const kept = all.filter((t) => !drop(t));
      setActiveTab((a) => {
        const current = all[a];
        if (current && !drop(current)) return kept.indexOf(current);
        return kept.length === 0 ? -1 : Math.min(Math.max(a, 0), kept.length - 1);
      });
      return kept;
    });
  }

  function closeTab(i: number) {
    const tab = tabs[i];
    if (tab?.kind === "query") editorRefs.current.delete(tab.doc.id);
    setTabs((all) => all.filter((_, j) => j !== i));
    setActiveTab((a) => {
      const left = tabs.length - 1;
      if (left === 0) return -1;
      if (i < a) return a - 1;
      if (i === a) return Math.min(i, left - 1);
      return a;
    });
  }

  function openObject(selection: Selection) {
    const key = objectKey(selection.connectionId, selection.kind, selection.path);
    const found = tabs.findIndex((t) => t.kind === "object" && t.key === key);
    if (found >= 0) {
      setActiveTab(found);
      return;
    }
    setTabs((all) => [...all, { kind: "object", key, selection }]);
    setActiveTab(tabs.length);
  }

  function newQuery(connectionId: ConnectionId | null, text = "") {
    const c = connections.find((x) => x.id === connectionId) ?? null;
    const doc: QueryTabDoc = {
      id: newId(),
      name: nextQueryName(tabs.map((t) => (t.kind === "query" ? t.doc.name : ""))),
      text,
      connectionId: c?.id ?? null,
      database: c?.database ?? null,
      savedId: null,
      savedText: null,
    };
    setTabs((all) => [...all, { kind: "query", doc }]);
    setActiveTab(tabs.length);
  }

  function openSaved(q: SavedQuery) {
    const found = tabs.findIndex((t) => t.kind === "query" && t.doc.savedId === q.id);
    if (found >= 0) {
      setActiveTab(found);
      return;
    }
    const c = connections.find((x) => x.id === activeId) ?? null;
    const doc: QueryTabDoc = {
      id: newId(),
      name: q.name,
      text: q.sql,
      connectionId: c?.id ?? null,
      database: c?.database ?? null,
      savedId: q.id,
      savedText: q.sql,
    };
    setTabs((all) => [...all, { kind: "query", doc }]);
    setActiveTab(tabs.length);
  }

  function reloadSaved() {
    listSavedQueries()
      .then((all) => {
        setSavedQueries(all);
        // A renamed Saved Query renames its open tab; a deleted one leaves the tab as a plain query.
        setTabs((ts) =>
          ts.map((t) => {
            if (t.kind !== "query" || !t.doc.savedId) return t;
            const q = all.find((x) => x.id === t.doc.savedId);
            return { kind: "query", doc: q ? { ...t.doc, name: q.name } : { ...t.doc, savedId: null, savedText: null } };
          }),
        );
      })
      .catch((e) => setNotice(errorText(e)));
  }

  function updateDoc(doc: QueryTabDoc) {
    setTabs((all) => all.map((t) => (t.kind === "query" && t.doc.id === doc.id ? { kind: "query", doc } : t)));
  }

  function editorRef(id: string): MutableRefObject<SqlEditorApi | null> {
    let r = editorRefs.current.get(id);
    if (!r) {
      r = { current: null };
      editorRefs.current.set(id, r);
    }
    return r;
  }

  // Ctrl+T opens a new query tab, on the active Connection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t" && place.kind !== "home") {
        e.preventDefault();
        newQuery(activeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function reload() {
    try {
      const [g, c] = await Promise.all([listGroups(), listConnections()]);
      setGroups(g);
      setConnections(c);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  function markClosed(id: ConnectionId) {
    lang.schemas.dropConnection(id);
    setOpenIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    removeTabs((t) => t.kind === "object" && t.selection.connectionId === id);
  }

  function lost(id: ConnectionId) {
    markClosed(id);
    setNotice("That Connection is not open any more. Open it again to continue.");
  }

  function goTo(next: Place) {
    // Save this place's drafts now: the debounced save would be cancelled by the switch.
    if (draftKey && draftsLoaded.current === draftKey) void saveQueryTabs(draftKey, draftsJson).catch(() => {});
    draftsLoaded.current = null;
    setPlace(next);
    setActiveId(null);
    setTabs([]);
    setActiveTab(-1);
    editorRefs.current.clear();
    setNotice(null);
    setForm({ kind: "none" });
  }

  async function openGroup(id: GroupId) {
    goTo({ kind: "group", groupId: id });
    try {
      await setLastGroup(id);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  async function openFromHome(id: ConnectionId) {
    goTo({ kind: "ungrouped" });
    setActiveId(id);
    try {
      await openConnection(id);
      setOpenIds((ids) => new Set(ids).add(id));
    } catch (e) {
      setNotice(errorText(e, connections.find((c) => c.id === id)?.dialect));
    }
  }

  async function openUngrouped() {
    goTo({ kind: "ungrouped" });
    try {
      await setLastGroup(null);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  async function goHome() {
    goTo({ kind: "home" });
    try {
      await setLastGroup(null);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  async function newQueryOn(id: ConnectionId) {
    setActiveId(id);
    newQuery(id);
    if (openIds.has(id)) return;
    try {
      await openConnection(id);
      setOpenIds((ids) => new Set(ids).add(id));
    } catch (e) {
      setNotice(errorText(e, connections.find((c) => c.id === id)?.dialect));
    }
  }

  if (startup.s === "loading") {
    return (
      <div className="app-message">
        <p className="muted">Loading your Groups and Connections…</p>
      </div>
    );
  }
  if (startup.s === "failed") {
    return (
      <div className="app-message" role="alert">
        <p className="error-text">{startup.message}</p>
        <button type="button" className="button" onClick={start}>
          Try again
        </button>
      </div>
    );
  }

  const group = place.kind === "group" ? groups.find((g) => g.id === place.groupId) : undefined;
  const workspaceGroupId = place.kind === "group" ? place.groupId : null;
  const placeName = group?.name ?? "Ungrouped";
  const inPlace = connections.filter((c) => c.groupId === workspaceGroupId);
  const active = connections.find((c) => c.id === activeId && openIds.has(c.id));
  const current = tabs[activeTab];
  const selection = current?.kind === "object" ? current.selection : null;
  const historyFor =
    historyOpen && current?.kind === "query" ? (inPlace.find((c) => c.id === current.doc.connectionId) ?? null) : null;

  return (
    <div className="app">
      <header className="title-bar">
        <GroupSwitcher
          groups={groups}
          place={place}
          onHome={goHome}
          onOpenGroup={openGroup}
          onOpenUngrouped={openUngrouped}
        />
        {place.kind !== "home" && !schema && (
          <TabStrip
            tabs={tabs}
            active={activeTab}
            onSelect={setActiveTab}
            onClose={closeTab}
            onNew={() => newQuery(activeId)}
          />
        )}
      </header>

      <div className={place.kind === "home" ? "body body-home" : historyFor ? "body body-history" : "body"}>
        <nav className="rail" aria-label="Sections">
          <button
            type="button"
            className={place.kind === "home" ? "rail-button rail-button-on" : "rail-button"}
            aria-label="Home"
            title="Home"
            aria-current={place.kind === "home" ? "page" : undefined}
            onClick={goHome}
          >
            <Icon name="home" />
          </button>
          <button
            type="button"
            className={place.kind !== "home" ? "rail-button rail-button-on" : "rail-button"}
            aria-label="Connections"
            title="Connections"
            aria-current={place.kind !== "home" ? "page" : undefined}
            onClick={() => place.kind === "home" && goTo({ kind: "ungrouped" })}
          >
            <Icon name="database" />
          </button>
        </nav>

        {schema?.kind === "builder" ? (
          <main className="schema-main">
            <SchemaBuilder doc={schema.doc} onClose={() => setSchema(null)} />
          </main>
        ) : place.kind === "home" ? (
          <main className="home-main">
            <Home
              onNewSchemaModel={() => setSchema({ kind: "start" })}
              groups={groups}
              connections={connections}
              onOpenGroup={openGroup}
              notice={notice}
              onOpenUngrouped={openFromHome}
              onChanged={reload}
            />
          </main>
        ) : (
          <>
            <aside className="side" aria-label={`${placeName} Connections`}>
              <div className="side-header">
                <h2 className="side-title">{placeName}</h2>
                {group && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Edit ${group.name}`}
                    title="Edit Group"
                    onClick={() => setForm({ kind: "group" })}
                  >
                    <Icon name="edit" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="New Connection"
                  title="New Connection"
                  onClick={() => setForm({ kind: "connection" })}
                >
                  <Icon name="plus" />
                </button>
              </div>
              {inPlace.length === 0 && (
                <div className="side-empty">
                  <p className="muted">No Connections in {placeName} yet.</p>
                  <button type="button" className="button button-small" onClick={() => setForm({ kind: "connection" })}>
                    New Connection
                  </button>
                </div>
              )}
              <ConnectionList
                groupId={workspaceGroupId}
                groups={groups}
                connections={connections}
                openIds={openIds}
                activeId={activeId}
                onActivate={(id) => {
                  setActiveId(id);
                  setNotice(null);
                }}
                onOpened={(id) => {
                  setOpenIds((ids) => new Set(ids).add(id));
                  setActiveId(id);
                  setNotice(null);
                }}
                onClosed={markClosed}
                onEdit={(c) => setForm({ kind: "connection", connection: c })}
                onChanged={reload}
                onNewQuery={(id) => void newQueryOn(id)}
                onHistoryCleared={() => setHistoryRefresh((n) => n + 1)}
              />
              {notice && (
                <p className="error-text side-notice" role="alert">
                  {notice}
                </p>
              )}
              {active && (
                <div className="side-tree">
                  <h3 className="tree-section-label">{active.name}</h3>
                  <ObjectTree
                    key={active.id}
                    connectionId={active.id}
                    dialect={active.dialect}
                    // A SQLite file holds one database, so its objects show at once.
                    defaultDatabase={active.dialect === "sqlite" ? "main" : active.database}
                    selected={selection?.connectionId === active.id ? selection : null}
                    onSelect={(kind, path) => openObject({ connectionId: active.id, kind, path })}
                    onNotOpen={() => lost(active.id)}
                    onReverseEngineer={(database, s) =>
                      setSchema({ kind: "start", initial: { connectionId: active.id, database, schema: s } })
                    }
                    reveal={reveal?.connectionId === active.id ? reveal : null}
                    onRefresh={() => lang.schemas.invalidate(active.id)}
                    onRevealed={() => setReveal(null)}
                  />
                </div>
              )}
              <SavedQueries
                items={savedQueries}
                activeId={current?.kind === "query" ? current.doc.savedId : null}
                onOpen={openSaved}
                onChanged={reloadSaved}
              />
            </aside>

            <main className="work">
              {selection &&
                (selection.kind === "table" || selection.kind === "view" ? (
                  <DataGrid
                    key={objectKey(selection.connectionId, selection.kind, selection.path)}
                    connectionId={selection.connectionId}
                    table={selection.path}
                    onClose={() => closeTab(activeTab)}
                    onNotOpen={() => lost(selection.connectionId)}
                    dialect={connections.find((c) => c.id === selection.connectionId)?.dialect}
                    lang={lang}
                  />
                ) : (
                  <DefinitionView
                    key={objectKey(selection.connectionId, selection.kind, selection.path)}
                    selection={selection}
                    onClose={() => closeTab(activeTab)}
                    onNotOpen={() => lost(selection.connectionId)}
                  />
                ))}
              {/* Query tabs stay mounted while hidden, so their sessions and results survive a tab switch. */}
              {tabs.map((t, i) =>
                t.kind === "query" ? (
                  <div key={t.doc.id} className="work-pane" hidden={i !== activeTab}>
                    <QueryTab
                      tab={t.doc}
                      connections={inPlace}
                      openIds={openIds}
                      onChange={updateDoc}
                      onSaved={(q) =>
                        setSavedQueries((all) =>
                          [...all.filter((x) => x.id !== q.id), q].sort((a, b) =>
                            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
                          ),
                        )
                      }
                      historyOpen={historyOpen}
                      onToggleHistory={() => setHistoryOpen((o) => !o)}
                      editorRef={editorRef(t.doc.id)}
                      onRan={() => setHistoryRefresh((n) => n + 1)}
                      lang={lang}
                      onShowInTree={(target) => {
                        setActiveId(target.connectionId);
                        setReveal((r) => ({ ...target, seq: (r?.seq ?? 0) + 1 }));
                      }}
                    />
                  </div>
                ) : null,
              )}
              {!current && (
                <div className="work-empty">
                  <p className="muted">
                    {active
                      ? "Choose a table or view to see its rows, or press Ctrl+T for a new query."
                      : inPlace.length > 0
                        ? "Open a Connection to browse its databases."
                        : "Add a Connection to start browsing."}
                  </p>
                </div>
              )}
            </main>
            {historyFor && current?.kind === "query" && (
              <HistoryPanel
                connectionId={historyFor.id}
                connectionName={historyFor.name}
                refreshKey={historyRefresh}
                onInsert={(sql) => editorRefs.current.get(current.doc.id)?.current?.insert(sql)}
                onOpenInNewTab={(sql) => newQuery(historyFor.id, sql)}
                onClose={() => setHistoryOpen(false)}
              />
            )}
          </>
        )}
      </div>

      {form.kind === "group" && group && (
        <GroupForm
          group={group}
          connectionCount={inPlace.length}
          onSaved={() => {
            setForm({ kind: "none" });
            reload();
          }}
          onDeleted={() => {
            setForm({ kind: "none" });
            reload();
            goHome();
          }}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
      {form.kind === "connection" && (
        <ConnectionForm
          connection={form.connection}
          groups={groups}
          defaultGroupId={workspaceGroupId}
          onSaved={(saved) => {
            // Saving closes the Connection's session, so it must be opened again.
            if (form.connection) markClosed(saved.id);
            setForm({ kind: "none" });
            reload();
          }}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
      {schema?.kind === "start" && (
        <StartModel
          connections={connections}
          openIds={openIds}
          initial={schema.initial}
          onStart={(doc) => setSchema({ kind: "builder", doc })}
          onCancel={() => setSchema(null)}
        />
      )}
    </div>
  );
}
