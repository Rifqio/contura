import { useCallback, useEffect, useState } from "react";
import {
  errorText,
  isNotOpen,
  lastGroup,
  listConnections,
  listGroups,
  objectDefinition,
  openConnection,
  setLastGroup,
} from "./api/client";
import type { ConnectionConfig, ConnectionId, Group, GroupId, ObjectKind, ObjectPath } from "./api/types";
import ConnectionForm from "./components/ConnectionForm";
import ConnectionList from "./components/ConnectionList";
import DataGrid from "./components/DataGrid";
import GroupForm from "./components/GroupForm";
import GroupSwitcher, { type Place } from "./components/GroupSwitcher";
import Home from "./components/Home";
import Icon from "./components/Icon";
import ObjectTree from "./components/ObjectTree";
import { objectKey, objectPrefix } from "./objectPath";

interface Selection {
  connectionId: ConnectionId;
  kind: ObjectKind;
  path: ObjectPath;
}

type Form = { kind: "none" } | { kind: "group" } | { kind: "connection"; connection?: ConnectionConfig };

type Startup = { s: "loading" } | { s: "ready" } | { s: "failed"; message: string };

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

export default function App() {
  const [startup, setStartup] = useState<Startup>({ s: "loading" });
  const [groups, setGroups] = useState<Group[]>([]);
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [place, setPlace] = useState<Place>({ kind: "home" });
  const [openIds, setOpenIds] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [activeId, setActiveId] = useState<ConnectionId | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<Form>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);

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
  }, []);

  useEffect(() => {
    start();
  }, [start]);

  // A Connection moved to another Group leaves this place: drop it as the active one and release its grid.
  useEffect(() => {
    if (place.kind === "home") return;
    const here = place.kind === "group" ? place.groupId : null;
    const isHere = (id: ConnectionId) => connections.some((c) => c.id === id && c.groupId === here);
    if (activeId !== null && !isHere(activeId)) setActiveId(null);
    if (selection !== null && !isHere(selection.connectionId)) setSelection(null);
  }, [connections, place, activeId, selection]);

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
    setOpenIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    setSelection((s) => (s?.connectionId === id ? null : s));
  }

  function lost(id: ConnectionId) {
    markClosed(id);
    setNotice("That Connection is not open any more. Open it again to continue.");
  }

  function goTo(next: Place) {
    setPlace(next);
    setActiveId(null);
    setSelection(null);
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
        {selection && (
          <span className="title-bar-object">
            <Icon name={selection.kind === "table" ? "table" : selection.kind === "view" ? "view" : "routine"} />
            {selection.path.name}
          </span>
        )}
      </header>

      <div className={place.kind === "home" ? "body body-home" : "body"}>
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

        {place.kind === "home" ? (
          <main className="home-main">
            <Home
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
                    onSelect={(kind, path) => setSelection({ connectionId: active.id, kind, path })}
                    onNotOpen={() => lost(active.id)}
                  />
                </div>
              )}
            </aside>

            <main className="work">
              {selection ? (
                selection.kind === "table" || selection.kind === "view" ? (
                  <DataGrid
                    key={objectKey(selection.connectionId, selection.kind, selection.path)}
                    connectionId={selection.connectionId}
                    table={selection.path}
                    onClose={() => setSelection(null)}
                    onNotOpen={() => lost(selection.connectionId)}
                  />
                ) : (
                  <DefinitionView
                    key={objectKey(selection.connectionId, selection.kind, selection.path)}
                    selection={selection}
                    onClose={() => setSelection(null)}
                    onNotOpen={() => lost(selection.connectionId)}
                  />
                )
              ) : (
                <div className="work-empty">
                  <p className="muted">
                    {active
                      ? "Choose a table or view to see its rows, or a routine or trigger to see its definition."
                      : inPlace.length > 0
                        ? "Open a Connection to browse its databases."
                        : "Add a Connection to start browsing."}
                  </p>
                </div>
              )}
            </main>
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
    </div>
  );
}
