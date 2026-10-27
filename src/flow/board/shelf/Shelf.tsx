// The Shelf (decisions 2 to 5): the board's one Add panel, a non-modal dialog under the toolbar. One search owns
// focus (an editable combobox, APG); the left side picks from the Diagrams, Icons and Shapes tabs, or, while
// searching with no tab pinned, from one list grouped Diagrams, Icons, Shapes. A click or Enter adds; a drag drops
// where released, and the panel fades while it runs (Miro) so the drop point shows.
import { type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../../../components/Icon";
import Kbd from "../../../components/Kbd";
import { motionMs } from "../../../diagram/motion";
import type { DiagramKind } from "../../../lang/flow/model";
import { searchKinds } from "../catalog/search";
import type { TemplateFilter } from "../catalog/templates";
import { KIND_HEAD, KIND_ICON } from "../chips";
import { IconTile, iconTip } from "./BasicIconsTab";
import DiagramsTab from "./DiagramsTab";
import { SHELF_GROUP_ICONS, ShelfIconContext, type ShelfIconSource, shelfIconSource } from "./iconSource";
import { isListKey, Nothing, ShelfOption, useOptionList } from "./list";
import { codeId, ShapeRowBody, shapeRow, shapeRows, showsCode } from "./ShapesTab";
import { SHELF_TABS, type ShelfTabDef } from "./tabs";
import TemplatesSide, { TEMPLATE_FILTERS } from "./TemplatesSide";
import { SHELF_DRAG_TYPE, type ShelfGroup, type ShelfItem, type ShelfTabProps } from "./types";

type Point = { x: number; y: number };
export type ShelfCloseReason = "escape" | "outside" | "toggle" | "add";

interface Props {
  id: string;
  /** "board": the Add panel. "new": the New diagram catalog: Diagrams and the templates side by side, and nothing drags. */
  host: "board" | "new";
  frameKind: DiagramKind | null;
  initialQuery?: string;
  /** Every change of the search text, for the New diagram catalog's Back (it reopens with the search kept). */
  onQuery?(query: string): void;
  initialTab?: string;
  tabs?: readonly ShelfTabDef[];
  /** The one icon source the Icons count, the Icons tab and the search read (decision 6's seam by default). */
  source?: ShelfIconSource;
  /** `at` is a board point; without it the add lands in the middle of the view. */
  onAdd(item: ShelfItem, at?: Point): void;
  onDragStart?(item: ShelfItem): void;
  onDragEnd?(): void;
  onClose(reason: ShelfCloseReason): void;
  /** Why an item cannot be added now, or null: its row shows disabled with the reason (a shape that needs a selection). */
  disabled?(item: ShelfItem): string | null;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The left side's groups for `query` (decision 4): empty groups left out. */
export function shelfGroups(query: string, frameKind: DiagramKind | null, icons: ShelfIconSource): ShelfGroup[] {
  const groups: ShelfGroup[] = [];
  const kinds = searchKinds(query);
  if (kinds.length) groups.push({ label: "Diagrams", items: kinds });
  const total = icons.count(query) ?? 0;
  if (total) groups.push({ label: "Icons", items: icons.results(query, SHELF_GROUP_ICONS), total });
  const { kind, loose } = shapeRows(query, frameKind);
  if (kind.length + loose.length) groups.push({ label: "Shapes", items: [...kind, ...loose].map((r) => r.item) });
  return groups;
}

/** One option of the grouped list: an item, or the Icons group's "Show all" row. */
type Entry = { item: ShelfItem } | { showAll: number };

interface GroupedProps {
  query: string;
  groups: ShelfGroup[];
  registerKeys(handler: (e: KeyboardEvent) => boolean): void;
  setActiveDescendant(id: string | undefined): void;
  add(item: ShelfItem): void;
  beginDrag(item: ShelfItem, e: DragEvent): void;
  /** Pins the Icons tab with the query kept; null when the registry has no Icons tab. */
  showAllIcons: (() => void) | null;
  listboxId: string;
  disabled?(item: ShelfItem): string | null;
}

/** The grouped list while searching with no tab pinned: it handles its own keys, as no tab body is mounted (C16). */
function GroupedList({ query, groups, registerKeys, setActiveDescendant, add, beginDrag, showAllIcons, listboxId, disabled }: GroupedProps) {
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const g of groups) {
      if (g.label === "Diagrams") for (const diagram of g.items) out.push({ item: { kind: "diagram", diagram } });
      else if (g.label === "Shapes") for (const item of g.items) out.push({ item });
      else {
        for (const hit of g.items) out.push({ item: { kind: "icon", name: hit.name } });
        if (showAllIcons && g.total > g.items.length) out.push({ showAll: g.total });
      }
    }
    return out;
  }, [groups, showAllIcons]);
  const { active, optionId } = useOptionList({
    n: entries.length,
    reset: query,
    registerKeys,
    setActiveDescendant,
    pick: (i) => {
      const e = entries[i];
      if ("item" in e) add(e.item);
      else showAllIcons?.();
    },
  });
  if (entries.length === 0) return <Nothing query={query} />;

  let at = 0;
  const option = (
    item: ShelfItem,
    label: string,
    className: string,
    body: ReactNode,
    extra: { drag?: boolean; title?: string; name?: string; disabled?: string | null; describedBy?: string } = {},
  ) => {
    const i = at++;
    return (
      <ShelfOption
        key={i}
        id={optionId(i)}
        active={i === active}
        label={label}
        item={item}
        drag={extra.drag ?? true}
        title={extra.title}
        name={extra.name}
        className={className}
        add={add}
        beginDrag={beginDrag}
        disabled={extra.disabled}
        describedBy={extra.describedBy}
      >
        {body}
      </ShelfOption>
    );
  };
  const showAll = (total: number, run: () => void) => {
    const i = at++;
    return (
      <div
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        className={i === active ? "flow-shelf-row flow-shelf-all is-active" : "flow-shelf-row flow-shelf-all"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run}
      >
        {`Show all ${fmt(total)} icons`}
      </div>
    );
  };
  return (
    <div id={listboxId} role="listbox" aria-label="Results" className="flow-shelf-rows">
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <div className="flow-shelf-heading" aria-hidden="true">
            {g.label}
          </div>
          {g.label === "Diagrams" &&
            g.items.map((kind) =>
              option(
                { kind: "diagram", diagram: kind },
                KIND_HEAD[kind].name,
                "flow-shelf-row",
                <>
                  <Icon name={KIND_ICON[kind]} size={16} />
                  <span className="flow-shelf-row-name">{KIND_HEAD[kind].name}</span>
                  <span className="flow-shelf-row-line">{KIND_HEAD[kind].line}</span>
                </>,
              ),
            )}
          {g.label === "Icons" && (
            <>
              <div className="flow-shelf-tiles">
                {g.items.map((hit) =>
                  option({ kind: "icon", name: hit.name }, hit.title || hit.name, "flow-shelf-tile", <IconTile name={hit.name} />, {
                    title: iconTip(hit),
                    name: hit.name,
                  }),
                )}
              </div>
              {showAllIcons && g.total > g.items.length && showAll(g.total, showAllIcons)}
            </>
          )}
          {g.label === "Shapes" &&
            g.items.map((item) => {
              const row = shapeRow(item as Extract<ShelfItem, { kind: "shape" | "sketch" }>);
              const why = disabled?.(item) ?? null;
              const id = optionId(at);
              return option(item, row.label, "flow-shelf-row", <ShapeRowBody row={row} why={why} id={id} />, {
                drag: row.drag,
                disabled: why,
                describedBy: showsCode(row, why) ? codeId(id) : undefined,
              });
            })}
        </div>
      ))}
    </div>
  );
}

export default function Shelf({
  id,
  host,
  frameKind,
  initialQuery = "",
  onQuery,
  initialTab,
  tabs = SHELF_TABS,
  source = shelfIconSource,
  onAdd,
  onDragStart,
  onDragEnd,
  onClose,
  disabled,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState(() => (tabs.some((t) => t.id === initialTab) ? initialTab! : tabs[0].id));
  /** A tab pressed while searching: its body shows the query instead of the grouped list. */
  const [pinned, setPinned] = useState(false);
  const [leftActive, setActiveId] = useState<string | undefined>();
  const [rightActive, setRightActive] = useState<string | undefined>();
  /** Which side Up, Down and Enter act on (Tab switches); the search keeps focus either way. */
  const [side, setSide] = useState<"left" | "right">("left");
  /** The polite announcement of the side Tab moved to; the search keeps focus, so nothing else says it. */
  const [said, setSaid] = useState("");
  const [filter, setFilter] = useState<TemplateFilter>("all");
  const [dragging, setDragging] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<ShelfIconSource | null>(() => (source.count("") !== null ? source : null));
  const iconsLoaded = loadedFrom === source;
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const latest = useRef({ onAdd, onDragStart, onDragEnd, onClose });
  latest.current = { onAdd, onDragStart, onDragEnd, onClose };
  const queryOut = useRef(onQuery);
  queryOut.current = onQuery;
  useEffect(() => {
    queryOut.current?.(query);
  }, [query]);

  const board = host === "board";
  const searching = query.trim() !== "";
  const grouped = board && searching && !pinned;
  const activeId = side === "right" ? rightActive : leftActive;
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    if (iconsLoaded) return;
    let live = true;
    source.load().then(
      () => live && setLoadedFrom(source),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [source, iconsLoaded]);

  // A press outside closes it; a press on its opener (Add, More shapes) is the opener's toggle, and a sublayer
  // opened from inside counts as inside.
  useEffect(() => {
    if (!board) return;
    const onDown = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Node) || root.current?.contains(t)) return;
      if (t instanceof Element && (t.closest(`[aria-controls="${CSS.escape(id)}"]`) || t.closest("[data-sublayer]"))) return;
      latest.current.onClose("outside");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [board, id]);

  /** The key handler of the list that owns the keys now: the mounted tab body's, or the grouped list's. */
  const keys = useRef<{ owner: string; handler: (e: KeyboardEvent) => boolean } | null>(null);
  const owner = grouped ? "grouped" : board ? `tab:${current.id}` : "new";
  const registerKeys = useCallback((handler: (e: KeyboardEvent) => boolean) => {
    keys.current = { owner, handler };
  }, [owner]);

  const rightKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const registerRightKeys = useCallback((handler: (e: KeyboardEvent) => boolean) => {
    rightKeys.current = handler;
  }, []);

  const add = useCallback((item: ShelfItem, at?: Point) => (at ? latest.current.onAdd(item, at) : latest.current.onAdd(item)), []);

  const dragTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(dragTimer.current), []);
  const beginDrag = useCallback(
    (item: ShelfItem, e: DragEvent) => {
      if (!board) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData(SHELF_DRAG_TYPE, JSON.stringify(item));
      e.dataTransfer.effectAllowed = "copy";
      latest.current.onDragStart?.(item);
      // The fade waits a tick: the browser takes the drag image after dragstart, and it should not be faded.
      window.clearTimeout(dragTimer.current);
      dragTimer.current = window.setTimeout(() => setDragging(true), 0);
    },
    [board],
  );
  const endDrag = () => {
    window.clearTimeout(dragTimer.current);
    setDragging(false);
    latest.current.onDragEnd?.();
  };

  const selectTab = (next: string) => {
    setTab(next);
    if (searching) setPinned(true);
  };
  const step = (by: 1 | -1) => {
    const at = grouped ? (by > 0 ? -1 : 0) : tabs.indexOf(current);
    selectTab(tabs[(at + by + tabs.length) % tabs.length].id);
  };
  const stepFilter = (by: 1 | -1) => {
    const at = TEMPLATE_FILTERS.findIndex((f) => f.value === filter);
    setFilter(TEMPLATE_FILTERS[(at + by + TEMPLATE_FILTERS.length) % TEMPLATE_FILTERS.length].value);
  };
  const showAllIcons = useMemo(
    () => (tabs.some((t) => t.id === "icons") ? () => (setTab("icons"), setPinned(true)) : null),
    [tabs],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // In the New diagram catalog an Esc with nothing typed is its Dialog's (B1's Dialog stack).
      if (!board && query === "") return;
      // The board's own Esc (disarm, deselect) must not also run.
      e.preventDefault();
      e.stopPropagation();
      if (query !== "") {
        setQuery("");
        setPinned(false);
      } else latest.current.onClose("escape");
      return;
    }
    if (e.target !== search.current) return;
    // Tab and Shift+Tab switch sides (spec); the board's panel has no other tab stop that matters while searching.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // A dialog around the catalog must not also move focus with its own Tab trap.
      e.stopPropagation();
      const next = side === "left" ? "right" : "left";
      setSide(next);
      setSaid(next === "right" ? "Templates" : board ? "Diagrams, icons and shapes" : "Diagrams");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      const by = e.key === "PageDown" ? 1 : -1;
      if (side === "left") step(by);
      else if (!searching) stepFilter(by);
      return;
    }
    if (!isListKey(e)) return;
    if (side === "right") {
      if (rightKeys.current?.(e)) e.preventDefault();
      return;
    }
    const k = keys.current;
    if (k && k.owner === owner && k.handler(e)) e.preventDefault();
  };

  /** One focus owner (decision 3): a press on the panel's icons, headings, notes or padding leaves focus in the search. */
  const keepFocus = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest?.("input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])")) return;
    // A tile that drags: WebKit starts no drag from a prevented mousedown (m2), so the press goes ahead and the search
    // takes focus back when it ends, by a release or by the end of the drag.
    if (t.closest?.('[draggable="true"]')) {
      pressedTile.current = true;
      return;
    }
    e.preventDefault();
  };
  const pressedTile = useRef(false);
  const refocus = () => {
    if (!pressedTile.current) return;
    pressedTile.current = false;
    search.current?.focus({ preventScroll: true });
  };

  const counts = useMemo(
    () => tabs.map((t) => t.count(query, frameKind, source)),
    // iconsLoaded: the Icons count arrives with the pack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, query, frameKind, source, iconsLoaded],
  );
  const groups = useMemo(
    () => (grouped ? shelfGroups(query, frameKind, source) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grouped, query, frameKind, source, iconsLoaded],
  );

  /** The active listbox: the grouped list or the mounted body gives its listbox this id. */
  const listId = `${id}-list`;
  const rightId = `${id}-templates`;
  const tabId = (t: ShelfTabDef) => `${id}-tab-${t.id}`;
  const body: ShelfTabProps = { listboxId: listId, query, active: true, registerKeys, add, beginDrag, setActiveDescendant: setActiveId, frameKind, disabled };

  return (
    <ShelfIconContext.Provider value={source}>
      <div
        ref={root}
        id={id}
        className={board ? "flow-shelf" : "flow-shelf is-new"}
        role={board ? "dialog" : undefined}
        aria-label={board ? "Add to the board" : undefined}
        data-dragging={dragging ? "" : undefined}
        data-side={board ? side : undefined}
        style={{ animationDuration: `${motionMs("menu")}ms` }}
        onKeyDown={onKeyDown}
        onMouseDown={keepFocus}
        onMouseUp={refocus}
        onDragEnd={() => {
          endDrag();
          refocus();
        }}
      >
        <div role="status" aria-live="polite" className="visually-hidden">
          {said}
        </div>
        <div className="flow-shelf-search">
          <Icon name="search" size={16} />
          <input
            ref={search}
            className="flow-shelf-input"
            type="text"
            role="combobox"
            aria-label="Search diagrams, templates, icons and shapes"
            placeholder="Search diagrams, templates and icons"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={side === "right" ? rightId : listId}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim() === "") setPinned(false);
            }}
          />
        </div>
        <div className="flow-shelf-pick">
          {board ? (
            <div role="tablist" aria-label="Pick" aria-orientation="vertical" className="flow-shelf-tabs">
              {tabs.map((t, i) => {
                const n = counts[i];
                const selected = !grouped && t.id === current.id;
                return (
                  <button
                    key={t.id}
                    id={tabId(t)}
                    type="button"
                    role="tab"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-controls={listId}
                    aria-label={n === null ? t.label : `${t.label}, ${fmt(n)}`}
                    className={selected ? "flow-shelf-tab is-selected" : "flow-shelf-tab"}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectTab(t.id)}
                  >
                    <Icon name={t.icon} size={16} />
                    <span className="flow-shelf-tab-name">{t.label}</span>
                    {n !== null && <span className="flow-shelf-count">{fmt(n)}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <h3 className="flow-shelf-title">Diagrams</h3>
          )}
          <div className="flow-shelf-list">
            {!board ? (
              <DiagramsTab {...body} still />
            ) : grouped ? (
              <GroupedList
                query={query}
                groups={groups}
                registerKeys={registerKeys}
                setActiveDescendant={setActiveId}
                add={add}
                beginDrag={beginDrag}
                showAllIcons={showAllIcons}
                listboxId={listId}
                disabled={disabled}
              />
            ) : (
              <div key={current.id} data-shelf-body className="flow-shelf-body" role="tabpanel" aria-labelledby={tabId(current)}>
                <current.Body {...body} />
              </div>
            )}
          </div>
          <TemplatesSide
            query={query}
            filter={filter}
            setFilter={setFilter}
            registerKeys={registerRightKeys}
            setActiveDescendant={setRightActive}
            add={add}
            beginDrag={beginDrag}
            listboxId={rightId}
            still={!board}
          />
        </div>
        {board && (
          <div className="flow-shelf-foot">
            <span>Click adds it in the middle of the view, or drag it onto the board.</span>
            <span className="flow-shelf-keys">
              <Kbd keys="Tab" /> switches sides <Kbd keys="Up" /> <Kbd keys="Down" /> move <Kbd keys="Enter" /> adds <Kbd keys="Esc" /> closes
            </span>
          </div>
        )}
      </div>
    </ShelfIconContext.Provider>
  );
}
