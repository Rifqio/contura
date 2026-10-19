import { useEffect, useRef, useState, type DragEvent } from "react";
import { connectionTarget, DIALECT_LABEL, errorText, moveConnection, shortenPath, suggestedConnections } from "../api/client";
import type { ConnectionConfig, ConnectionId, DiagramEntry, Group, GroupId, RecentItem, SuggestedConnection } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import type { DiagramMenuActions } from "../flow/DiagramMenu";
import { lastOpened, lastOpenedText } from "../home/recent";
import RecentColumn from "../home/RecentColumn";
import ConnectionForm from "./ConnectionForm";
import DbMark from "./DbMark";
import GroupBadge from "./GroupBadge";
import GroupForm from "./GroupForm";
import Icon from "./Icon";
import Kbd from "./Kbd";
import Menu, { type MenuItem } from "./Menu";
import SafetyTag from "./SafetyTag";

interface Props {
  groups: Group[];
  connections: ConnectionConfig[];
  /** Connections that are open now; their database marks show in colour and their rows say "Open". */
  openIds: ReadonlySet<ConnectionId>;
  /** What was opened lately, newest first; feeds the Recent column and each row's last-opened time. */
  recent: RecentItem[];
  /** Opens the Group and remembers it for the next start. */
  onOpenGroup: (id: GroupId) => void;
  /** Goes to the Connection's Group (or Ungrouped) and opens it there. */
  onOpenConnection: (id: ConnectionId) => void;
  /** Opens the Ungrouped place, from the Ungrouped card's name. */
  onOpenUngrouped: () => void;
  /** Reopens a Recent item where it was. */
  onOpenRecent: (item: RecentItem) => void;
  /** Groups or Connections changed; reload them. */
  onChanged: () => void;
  /** An app-level error to show, such as a failed reload. */
  notice?: string | null;
  /** When each Connection was last opened (ms), for rows Recent has nothing about. */
  openedTimes?: Record<ConnectionId, number>;
  /** Recent was cleared or restored; reload it. */
  onRecentChanged?: () => void;
  /** Opens Query History with scope All. */
  onShowAllHistory: () => void;
  /** The clock the times are measured from; tests fix it. */
  now?: Date;
  /** Home is the tab on screen: only then does it take Filter (Ctrl+Shift+F). */
  active?: boolean;
  /** Before a Connection moves to another Group: its tables' Pending Edits are asked about; false keeps it where it is. */
  onBeforeMove?: (id: ConnectionId) => Promise<boolean>;
  /** Before a Group is deleted: its Connections' tables' Pending Edits are asked about; false keeps the Group. */
  onBeforeDeleteGroup?: (id: GroupId) => Promise<boolean>;
  /** A Group was deleted from Home. */
  onGroupDeleted?: (id: GroupId) => void;
  /** Opens the New diagram sheet (frame 6+.6); without it the button is hidden. */
  onNewDiagram?: () => void;
  /** The diagrams folder, newest first, for the Recent column. */
  diagrams?: DiagramEntry[];
  onOpenDiagram?: (name: string) => void;
  /** A diagram row's right-click menu in Recent. */
  diagramActions?: DiagramMenuActions;
}

export function connectionCountText(n: number): string {
  if (n === 0) return "No Connections";
  return n === 1 ? "1 Connection" : `${n} Connections`;
}

/** "9 Connections in 3 Groups, 1 Ungrouped". */
export function homeCountText(connections: number, groups: number, ungrouped: number): string {
  const all = connectionCountText(connections);
  if (groups === 0) return ungrouped === 0 ? all : `${all}, all Ungrouped`;
  const inGroups = `${all} in ${groups === 1 ? "1 Group" : `${groups} Groups`}`;
  return ungrouped === 0 ? inGroups : `${inGroups}, ${ungrouped} Ungrouped`;
}

type Form =
  | { kind: "none" }
  | { kind: "group"; group?: Group }
  | { kind: "connection"; prefill?: SuggestedConnection; groupId?: GroupId | null };

/** One card on Home: a Group, or Ungrouped when `group` is null. */
type Card = { group: Group | null; name: string; rows: ConnectionConfig[]; total: number };

function matches(c: ConnectionConfig, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return c.name.toLowerCase().includes(f) || connectionTarget(c).toLowerCase().includes(f);
}

export default function Home({
  groups,
  connections,
  openIds,
  recent,
  onOpenGroup,
  onOpenConnection,
  onOpenUngrouped,
  onOpenRecent,
  onChanged,
  notice,
  openedTimes = {},
  onRecentChanged = () => {},
  onShowAllHistory,
  now = new Date(),
  active = true,
  onBeforeMove,
  onBeforeDeleteGroup,
  onGroupDeleted,
  onNewDiagram,
  diagrams,
  onOpenDiagram,
  diagramActions,
}: Props) {
  const [suggestions, setSuggestions] = useState<SuggestedConnection[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({ kind: "none" });
  const [filter, setFilter] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragging = useRef<ConnectionConfig | null>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    suggestedConnections()
      .then((s) => live && setSuggestions(s))
      .catch((e) => live && setSuggestionError(errorText(e)));
    return () => {
      live = false;
    };
  }, [connections]);

  const keys = useKeymap().map;
  const filterKey = hintFor(keys, "tree.filter");
  const newConnectionKey = hintFor(keys, "connection.new");
  const newDiagramKey = hintFor(keys, "flow.new");
  const empty = groups.length === 0 && connections.length === 0;

  // Filter (Ctrl+Shift+F) moves into the filter, while Home is the tab on screen; otherwise the tree's filter takes it.
  useCommandKeys(active ? { "tree.filter": () => filterBox.current?.focus() } : {}, { region: root });

  const ungrouped = connections.filter((c) => c.groupId === null);
  const query = filter.trim();
  const cards: Card[] = [
    ...groups.map((g) => {
      const mine = connections.filter((c) => c.groupId === g.id);
      return { group: g, name: g.name, rows: mine.filter((c) => matches(c, query)), total: mine.length };
    }),
    { group: null, name: "Ungrouped", rows: ungrouped.filter((c) => matches(c, query)), total: ungrouped.length },
  ];
  // A filter hides the cards it leaves empty.
  const shown = query ? cards.filter((card) => card.rows.length > 0) : cards;

  async function move(c: ConnectionConfig, to: GroupId | null) {
    if (c.groupId === to) return;
    setMoveError(null);
    // Its open tables leave with it, so their Pending Edits are asked about first (D4).
    if (onBeforeMove && !(await onBeforeMove(c.id))) return;
    try {
      await moveConnection(c.id, to);
      onChanged();
    } catch (e) {
      setMoveError(errorText(e));
    }
  }

  function groupMenu(card: Card): MenuItem[] {
    const g = card.group;
    return [
      {
        key: "new-connection",
        label: "New Connection here",
        onSelect: () => setForm({ kind: "connection", groupId: g?.id ?? null }),
      },
      ...(g ? [{ key: "edit", label: "Edit Group", onSelect: () => setForm({ kind: "group", group: g }) }] : []),
    ];
  }

  function cardDrop(card: Card) {
    const key = card.group?.id ?? "ungrouped";
    const to = card.group?.id ?? null;
    const accepts = () => dragging.current !== null && dragging.current.groupId !== to;
    return {
      onDragOver: (e: DragEvent) => {
        if (!accepts()) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setDropOn(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDropOn(null);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDropOn(null);
        const c = dragging.current;
        dragging.current = null;
        if (c && c.groupId !== to) void move(c, to);
      },
    };
  }

  function row(c: ConnectionConfig) {
    const isOpen = openIds.has(c.id);
    const label = `${c.name}, ${isOpen ? "open" : "closed"}`;
    const when = lastOpened(recent, c.id) ?? openedTimes[c.id] ?? null;
    const target = connectionTarget(c);
    return (
      <li
        key={c.id}
        className="list-row"
        title={label}
        draggable
        onDragStart={(e) => {
          dragging.current = c;
          try {
            e.dataTransfer.setData("text/plain", c.id);
            e.dataTransfer.effectAllowed = "move";
          } catch {
            // Some hosts give no data transfer; the ref still carries the Connection.
          }
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDropOn(null);
        }}
      >
        <DbMark dialect={c.dialect} open={isOpen} />
        <span className="list-row-main">
          <button type="button" className="list-row-name" aria-label={label} onClick={() => onOpenConnection(c.id)}>
            {c.name}
          </button>
          <SafetyTag connection={c} small />
        </span>
        <span className="list-row-when">
          {isOpen && <span className="list-row-state">Open</span>}
          {when !== null && <span>{lastOpenedText(when, now)}</span>}
        </span>
        <span className="list-row-target" title={target}>
          {shortenPath(target)}
          {c.dialect !== "sqlite" && c.database ? ` · ${c.database}` : ""}
        </span>
      </li>
    );
  }

  const suggestionBox = (suggestions.length > 0 || suggestionError) && (
    <section className="home-suggested" aria-label="Found on this PC">
      <p className="home-suggested-head">
        <Icon name="search" size={14} />
        Found on this PC in Laragon. Nothing is saved until you add it.
      </p>
      {suggestionError ? (
        <p className="error-text">{suggestionError}</p>
      ) : (
        <ul className="home-suggested-list" aria-label="Suggested Connections">
          {suggestions.map((s) => {
            const title = s.version ? `${DIALECT_LABEL[s.dialect]} ${s.version}` : DIALECT_LABEL[s.dialect];
            return (
              <li key={`${s.dialect}:${s.host}:${s.port}`} className="home-suggested-row">
                <DbMark dialect={s.dialect} open />
                <span className="home-suggested-name">{title}</span>
                <span className="home-suggested-target">
                  {s.host}:{s.port}
                </span>
                <button
                  type="button"
                  className="button button-small"
                  aria-label={`Add ${title}`}
                  onClick={() => setForm({ kind: "connection", prefill: s, groupId: null })}
                >
                  Add
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <div className="home" ref={root}>
      <div className="home-content">
        {!empty && (
          <header className="home-header">
            <div className="home-heading">
              <h1>Home</h1>
              <p className="home-count">{homeCountText(connections.length, groups.length, ungrouped.length)}</p>
            </div>
            <div className="home-actions">
              <label className="home-filter">
                <Icon name="search" size={14} />
                <input
                  ref={filterBox}
                  type="search"
                  aria-label="Filter Connections"
                  placeholder="Filter Connections"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && filter) {
                      e.preventDefault();
                      setFilter("");
                    }
                  }}
                />
                {filterKey && <Kbd keys={filterKey} />}
              </label>
              <button type="button" className="button" onClick={() => setForm({ kind: "group" })}>
                <Icon name="folder" size={14} />
                New Group
              </button>
              {onNewDiagram && (
                <button type="button" className="button" aria-label="New diagram" onClick={onNewDiagram}>
                  <Icon name="flow" size={14} />
                  New diagram
                  {newDiagramKey && <Kbd keys={newDiagramKey} />}
                </button>
              )}
              <button type="button" className="button button-primary" aria-label="New Connection" onClick={() => setForm({ kind: "connection" })}>
                <Icon name="plus" size={14} />
                New Connection
                {newConnectionKey && <Kbd keys={newConnectionKey} />}
              </button>
            </div>
          </header>
        )}

        {notice && (
          <p className="error-text" role="alert">
            {notice}
          </p>
        )}
        {moveError && (
          <p className="error-text" role="alert">
            {moveError}
          </p>
        )}

        {empty ? (
          <div className="home-empty">
            <div className="home-empty-box">
              <Icon name="plug" size={20} className="home-empty-icon" />
              <h2>No Connections yet</h2>
              <p>Add a Connection to browse, query and change a database.</p>
              <button type="button" className="button button-primary" aria-label="New Connection" onClick={() => setForm({ kind: "connection" })}>
                <Icon name="plus" size={14} />
                New Connection
                {newConnectionKey && <Kbd keys={newConnectionKey} />}
              </button>
            </div>
            {suggestionBox}
          </div>
        ) : (
          <div className="home-scroll">
            {shown.length === 0 ? (
              <p className="muted">No Connections match "{query}".</p>
            ) : (
              <div className="group-cards">
                {shown.map((card) => {
                  const key = card.group?.id ?? "ungrouped";
                  return (
                    <section
                      key={key}
                      className={dropOn === key ? "group-card group-card-drop" : "group-card"}
                      aria-label={card.name}
                      {...cardDrop(card)}
                    >
                      <header className="group-card-head">
                        <GroupBadge id={card.group?.id} name={card.name} color={card.group?.color ?? null} size={20} />
                        <button
                          type="button"
                          className="group-card-name"
                          aria-label={`Open ${card.name}`}
                          onClick={() => (card.group ? onOpenGroup(card.group.id) : onOpenUngrouped())}
                        >
                          {card.name}
                        </button>
                        <span className="group-card-count">{connectionCountText(card.total)}</span>
                        <Menu
                          label={`Actions for ${card.name}`}
                          align="end"
                          items={groupMenu(card)}
                          trigger={(props) => (
                            <button
                              type="button"
                              className="icon-button group-card-more"
                              aria-label={`Group actions for ${card.name}`}
                              title="Group actions"
                              {...props}
                            >
                              <Icon name="moreHorizontal" size={14} />
                            </button>
                          )}
                        />
                      </header>
                      {card.rows.length > 0 && (
                        <ul className="group-card-rows" aria-label={`${card.name} Connections`}>
                          {card.rows.map(row)}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
            <p className="home-hint">Drag a Connection onto another card to move it to that Group.</p>
            {suggestionBox}
          </div>
        )}
      </div>

      {(!empty || (diagrams?.length ?? 0) > 0) && <RecentColumn
          items={recent}
          connections={connections}
          openIds={openIds}
          now={now}
          onOpen={onOpenRecent}
          diagrams={diagrams}
          onOpenDiagram={onOpenDiagram}
          diagramActions={diagramActions}
          onClear={onRecentChanged}
          onShowAllHistory={onShowAllHistory}
        />}

      {form.kind === "group" && (
        <GroupForm
          group={form.group}
          connections={form.group ? connections.filter((c) => c.groupId === form.group!.id) : []}
          openIds={openIds}
          onChanged={onChanged}
          onSaved={() => {
            setForm({ kind: "none" });
            onChanged();
          }}
          onBeforeDelete={form.group && onBeforeDeleteGroup ? () => onBeforeDeleteGroup(form.group!.id) : undefined}
          onDeleted={() => {
            const gone = form.group?.id;
            setForm({ kind: "none" });
            onChanged();
            if (gone) onGroupDeleted?.(gone);
          }}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
      {form.kind === "connection" && (
        <ConnectionForm
          prefill={form.prefill}
          groups={groups}
          defaultGroupId={form.groupId ?? null}
          onSaved={() => {
            setForm({ kind: "none" });
            onChanged();
          }}
          onCancel={() => setForm({ kind: "none" })}
        />
      )}
    </div>
  );
}
