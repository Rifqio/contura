import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionConfig } from "../api/types";
import { hintFor, withHint } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import { type MenuItem } from "./Menu";
import { type DiagramMenuActions, diagramMenuItems, PlacedMenu, type PlacedMenuState } from "../flow/DiagramMenu";
import { useUnsavedFlows } from "../flow/flowRegistry";
import { type AnyTab, isUnsaved, stripSegment, tabConnectionId, tabKey } from "../shell/tabs";
import FeatureIcon, { type FeatureIconName } from "./FeatureIcon";
import Icon, { type IconName } from "./Icon";
import NewTabMenu, { type NewTabSection } from "./NewTabMenu";
import SafetyTag from "./SafetyTag";

export type { Selection, WorkTab } from "../shell/tabs";

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function tabName(t: AnyTab): string {
  switch (t.kind) {
    case "home":
      return "Home";
    case "settings":
      return "Settings";
    case "schema":
      return t.doc.path ? basename(t.doc.path) : "untitled.dbml";
    case "flow":
      return `${t.name}.flow`;
    case "transfer":
    case "compare":
      return t.title;
    case "query":
    case "visual":
      return t.doc.name;
    case "savedQueries":
      return "Saved Queries";
    case "object":
      return t.selection.path.name;
    case "design":
      // D23: "New table" until it is created.
      return t.target.kind === "alter" ? `${t.target.path.name} design` : "New table";
    case "import":
      return `Import into ${t.target.kind === "table" ? t.target.path.name : t.target.database}`;
    case "lineage":
      return `${t.path.name} lineage`;
  }
}

/**
 * Item 42: one icon per tab, the feature's own (item 16) at 16 px. Settings, Saved Queries and lineage have no
 * feature icon, so they keep their line icon; still one.
 */
function iconOf(t: AnyTab): { feature: FeatureIconName } | { icon: IconName } {
  switch (t.kind) {
    case "home":
      return { feature: "home" };
    case "settings":
      return { icon: "gear" };
    case "schema":
      return { feature: "model" };
    case "flow":
      return { feature: "diagram" };
    case "transfer":
      return { feature: "transfer" };
    case "compare":
      return { feature: "compare" };
    case "query":
      return { feature: "query" };
    case "visual":
      return { feature: "vquery" };
    case "savedQueries":
      return { icon: "bookmark" };
    case "object":
      return { feature: t.selection.kind === "table" ? "table" : t.selection.kind === "view" ? "view" : "function" };
    case "design":
      return { feature: "designer" };
    case "import":
      return { feature: "import" };
    case "lineage":
      return { icon: "flow" };
  }
}

/** Item 48: tabs are at most this wide, and share the strip evenly below it. */
export const TAB_MAX = 220;
/**
 * The active tab keeps its name, its unsaved mark and its close button at this width: icon 16, name 3ch, the mark
 * and the gaps need 66 px beside the 12 + 6 px padding and the 20 px close (at 96 px the mark sat under the close).
 */
export const TAB_ACTIVE_MIN = 112;
/** An icon-only tab is never narrower than this. */
const TAB_ICON_ONLY = 36;
/** Below these shares, inactive tabs hide their close until hover (narrow), then keep only their icon (compact). */
const NARROW_BELOW = 150;
const COMPACT_BELOW = 84;

export type TabDensity = "normal" | "narrow" | "compact";

/** Item 48: each tab's width when `n` tabs share `room` px, Edge style. */
export function tabWidths(room: number, n: number, hasActive: boolean): { density: TabDensity; width: number; activeWidth: number } {
  const per = n > 0 ? room / n : TAB_MAX;
  if (!Number.isFinite(per) || per >= TAB_MAX) return { density: "normal", width: TAB_MAX, activeWidth: TAB_MAX };
  const density: TabDensity = per < COMPACT_BELOW ? "compact" : per < NARROW_BELOW ? "narrow" : "normal";
  if (!hasActive || n === 1) {
    const w = Math.max(Math.floor(per), TAB_ICON_ONLY);
    return { density, width: w, activeWidth: hasActive ? Math.max(w, TAB_ACTIVE_MIN) : w };
  }
  const activeWidth = Math.max(Math.floor(per), TAB_ACTIVE_MIN);
  const width = Math.max(Math.floor((room - activeWidth) / (n - 1)), TAB_ICON_ONLY);
  return { density, width, activeWidth };
}

/**
 * The room the tabs share: the strip's width less the buttons after the list. One ResizeObserver on the strip,
 * none per tab; it goes on unmount. Null until measured (and where there is no ResizeObserver).
 */
function useStripRoom(strip: React.RefObject<HTMLDivElement | null>, list: React.RefObject<HTMLDivElement | null>): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      let others = 0;
      for (const c of Array.from(el.children)) {
        if (c === list.current || !(c instanceof HTMLElement)) continue;
        const cs = getComputedStyle(c);
        if (cs.position === "absolute" || cs.position === "fixed") continue;
        others += c.offsetWidth + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
      }
      const ls = list.current ? getComputedStyle(list.current) : null;
      const pad = ls ? (parseFloat(ls.paddingLeft) || 0) + (parseFloat(ls.paddingRight) || 0) : 0;
      setRoom(Math.max(0, Math.floor(el.clientWidth - others - pad)));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [strip, list]);
  return room;
}

interface Props {
  /** Every tab, in strip order. */
  tabs: AnyTab[];
  /** The active tab's key; null when none is. */
  active: string | null;
  onSelect(key: string): void;
  onClose(key: string): void;
  onNew(): void;
  /** The chevron menu's New Visual Query (D10). */
  onNewVisual?(): void;
  /** False while no Connection is open: New Visual Query is off and says why. */
  newVisualReady?: boolean;
  /** The chevron menu's New diagram (frame 6+.6). */
  onNewDiagram?(): void;
  /** A diagram tab's right-click menu: Rename, Save a copy as, Delete. */
  diagramActions?: DiagramMenuActions;
  /** Lets a query tab show the Production or Read-only mark of its Connection. */
  connections?: ConnectionConfig[];
  /** Table and design tabs (by key) with Pending Edits or an unapplied design. */
  dirtyKeys?: ReadonlySet<string>;
  /** Item 7: a tab dragged along the strip and dropped where `to` was. */
  onReorder?(from: string, to: string): void;
  /** A double click on a preview tab keeps it (item 1); the tab menu's Keep open does too. */
  onKeep?(key: string): void;
  /** The tab menu's Close other tabs and Close tabs to the right: `keys` close one after another, `keep` stays. */
  onCloseMany?(keys: string[], keep: string): void;
  /** Ctrl+Shift+T and the tab menu's Reopen closed tab. */
  onReopen?(): void;
  /** False when no closed tab waits, which turns Reopen closed tab off. */
  canReopen?: boolean;
  /** The new tab menu's New Schema Model (item 34). */
  onNewModel?(): void;
  /** Where New query opens, for its line in the new tab menu ("On kestrel-main, shop"). */
  newQueryWhere?: string | null;
}

/** Starts a drag after this many pixels, so a click never moves a tab. */
const DRAG_PX = 5;
/** The gap between tabs: none since item 48 (a divider sits between them instead). */
const TAB_GAP = 0;

interface DragState {
  key: string;
  dx: number;
  /** The tab whose place it takes on drop, or null while it is still in its own. */
  to: string | null;
}

/**
 * Item 7: tabs move along the strip as Chrome's do. The dragged tab follows the pointer; the tabs it passes slide
 * over by its width (120 ms); on release the list is reordered. A tab moves only among its own part of the strip.
 */
function useTabDrag(tabs: AnyTab[], onReorder?: (from: string, to: string) => void) {
  const [state, setState] = useState<DragState | null>(null);
  const [settling, setSettling] = useState(false);
  const boxes = useRef<{ key: string; left: number; width: number; seg: string }[]>([]);
  /** A drag just ended: the click that its release brings must not select the tab. */
  const dragged = useRef(false);

  function down(e: React.PointerEvent<HTMLElement>, key: string) {
    dragged.current = false;
    if (!onReorder || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".work-tab-close")) return;
    const tab = tabs.find((t) => tabKey(t) === key);
    if (!tab || stripSegment(tab) === "home") return;
    const strip = e.currentTarget.parentElement;
    const seg = stripSegment(tab);
    boxes.current = Array.from(strip?.querySelectorAll<HTMLElement>(".work-tab") ?? []).map((el) => {
      const r = el.getBoundingClientRect();
      const t = tabs.find((x) => tabKey(x) === el.dataset.key);
      return { key: el.dataset.key ?? "", left: r.left, width: r.width, seg: t ? stripSegment(t) : "" };
    });
    const startX = e.clientX;
    let started = false;
    let last: DragState | null = null;
    const me = boxes.current.find((b) => b.key === key);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!started && Math.abs(dx) < DRAG_PX) return;
      started = true;
      const mine = boxes.current.filter((b) => b.seg === seg);
      const from = mine.findIndex((b) => b.key === key);
      const centre = (me?.left ?? 0) + (me?.width ?? 0) / 2 + dx;
      let to: string | null = null;
      mine.forEach((b, i) => {
        const mid = b.left + b.width / 2;
        if (i > from && centre > mid) to = b.key;
        if (i < from && centre < mid && to === null) to = b.key;
      });
      last = { key, dx, to };
      setState(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!started) return;
      dragged.current = true;
      const done = last;
      // The moved tabs take their new places at once: no slide back from where they were shifted to.
      setSettling(true);
      setState(null);
      if (done?.to) onReorder?.(done.key, done.to);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** The shift of each tab while a drag runs: the dragged one with the pointer, the passed ones by its width. */
  function styleOf(key: string): React.CSSProperties | undefined {
    if (!state) return undefined;
    if (key === state.key) return { transform: `translateX(${state.dx}px)` };
    if (state.to === null) return undefined;
    const all = boxes.current;
    const from = all.findIndex((b) => b.key === state.key);
    const to = all.findIndex((b) => b.key === state.to);
    const at = all.findIndex((b) => b.key === key);
    const width = (all[from]?.width ?? 0) + TAB_GAP;
    if (to > from && at > from && at <= to) return { transform: `translateX(${-width}px)` };
    if (to < from && at < from && at >= to) return { transform: `translateX(${width}px)` };
    return undefined;
  }

  /** True once for the click that ends a drag. */
  function endedDrag(): boolean {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }

  /** Alt+Left and Alt+Right: the keyboard's way to move a tab one place within its own part of the strip. */
  function step(key: string, by: -1 | 1): boolean {
    if (!onReorder) return false;
    const tab = tabs.find((t) => tabKey(t) === key);
    if (!tab || stripSegment(tab) === "home") return false;
    const seg = stripSegment(tab);
    const mine = tabs.filter((t) => stripSegment(t) === seg).map(tabKey);
    const to = mine[mine.indexOf(key) + by];
    if (to === undefined) return false;
    onReorder(key, to);
    return true;
  }

  return { state, settling, down, styleOf, endedDrag, step };
}

/** The new tab menu's two sections (frame NewTab): Write and Draw. */
function newTabSections(o: {
  map: ReturnType<typeof useKeymap>["map"];
  onNew(): void;
  onNewVisual(): void;
  newVisualReady: boolean;
  onNewDiagram?(): void;
  onNewModel?(): void;
  newQueryWhere: string | null;
}): NewTabSection[] {
  const draw: NewTabSection["items"] = [
    ...(o.onNewDiagram
      ? [
          {
            key: "diagram",
            icon: "diagram" as const,
            label: "New diagram",
            description: "A .flow file: data flow, flowchart, cloud",
            shortcut: hintFor(o.map, "flow.new"),
            onSelect: o.onNewDiagram,
          },
        ]
      : []),
    ...(o.onNewModel
      ? [{ key: "model", icon: "model" as const, label: "New Schema Model", description: "Design tables in DBML before they exist", onSelect: o.onNewModel }]
      : []),
  ];
  return [
    {
      title: "Write",
      items: [
        {
          key: "query",
          icon: "query",
          label: "New query",
          description: o.newQueryWhere ?? "A blank SQL editor",
          shortcut: hintFor(o.map, "query.new"),
          onSelect: o.onNew,
        },
        {
          key: "visual",
          icon: "vquery",
          label: "New Visual Query",
          description: "Pick tables and columns, see the SQL",
          disabledWhy: o.newVisualReady ? null : "Open a Connection first",
          onSelect: o.onNewVisual,
        },
      ],
    },
    ...(draw.length > 0 ? [{ title: "Draw", items: draw }] : []),
  ];
}

/** The open tabs of the window and its place, in the title bar. Ctrl+W closes; Ctrl+Tab, Ctrl+PageDown and Ctrl+Shift+Tab, Ctrl+PageUp move. */
export default function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
  onNewVisual,
  newVisualReady = true,
  onNewDiagram,
  diagramActions,
  connections = [],
  dirtyKeys,
  onNewModel,
  newQueryWhere = null,
  onKeep,
  onCloseMany,
  onReopen,
  canReopen = false,
  onReorder,
}: Props) {
  const drag = useTabDrag(tabs, onReorder);
  const [newMenu, setNewMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const { map } = useKeymap();
  /** Diagram tabs whose save is still to come or failed. */
  const unsavedFlows = useUnsavedFlows();
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  const keys = tabs.map(tabKey);
  const list = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const room = useStripRoom(stripRef, list);
  const sizes = tabWidths(room ?? Number.POSITIVE_INFINITY, tabs.length, active !== null && keys.includes(active));
  /** The tab moved by Alt+Left or Alt+Right keeps focus in its new place. */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    const el = Array.from(list.current?.querySelectorAll<HTMLElement>(".work-tab") ?? []).find((t) => t.dataset.key === key);
    el?.querySelector<HTMLElement>(".work-tab-button")?.focus();
  }, [tabs]);
  // NF1: the strip scrolls without a bar; the active tab is brought into view when it is picked or opened.
  useEffect(() => {
    if (active === null) return;
    const el = Array.from(list.current?.querySelectorAll<HTMLElement>(".work-tab") ?? []).find((t) => t.dataset.key === active);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  /** S3: the Chrome and Edge tab menu: Close, Close other tabs, Close tabs to the right, Reopen closed tab, Keep open, Copy name. */
  function tabMenuItems(t: AnyTab): MenuItem[] {
    const key = tabKey(t);
    const at = keys.indexOf(key);
    const others = keys.filter((k) => k !== key);
    const right = keys.slice(at + 1);
    return [
      { key: "close", label: "Close", icon: <Icon name="close" />, shortcut: hintFor(map, "tab.close") ?? undefined, onSelect: () => onClose(key) },
      { key: "others", label: "Close other tabs", disabled: others.length === 0 || !onCloseMany, onSelect: () => onCloseMany?.(others, key) },
      { key: "right", label: "Close tabs to the right", disabled: right.length === 0 || !onCloseMany, onSelect: () => onCloseMany?.(right, key) },
      {
        key: "reopen",
        label: "Reopen closed tab",
        shortcut: hintFor(map, "tab.reopen") ?? undefined,
        separatorBefore: true,
        disabled: !canReopen || !onReopen,
        onSelect: () => onReopen?.(),
      },
      ...(t.kind === "object" && t.preview ? [{ key: "keep", label: "Keep open", onSelect: () => onKeep?.(key) }] : []),
      { key: "copy", label: "Copy name", icon: <Icon name="copy" />, separatorBefore: true, onSelect: () => void navigator.clipboard?.writeText(tabName(t)).catch(() => {}) },
    ];
  }
  const step = (by: number) => {
    if (keys.length === 0) return;
    const at = active === null ? -1 : keys.indexOf(active);
    const next = at < 0 ? (by > 0 ? 0 : keys.length - 1) : (at + by + keys.length) % keys.length;
    onSelect(keys[next]);
  };
  useCommandKeys({
    "tab.close": () => {
      if (active !== null && keys.includes(active)) onClose(active);
    },
    "tab.next": () => step(1),
    "tab.previous": () => step(-1),
    // Edge: Ctrl+1 to Ctrl+8 go to that tab, Ctrl+9 to the last; a number past the last tab does nothing.
    ...Object.fromEntries(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => [
        `tab.goto.${n}`,
        () => {
          const key = n === "9" ? keys[keys.length - 1] : keys[Number(n) - 1];
          if (key !== undefined) onSelect(key);
        },
      ]),
    ),
  });
  return (
    // Bare drag regions: Tauri drags only on direct clicks, so the tabs and buttons inside stay clickable.
    <div className="tab-strip" data-tauri-drag-region ref={stripRef}>
      <div
        role="tablist"
        aria-label="Open tabs"
        className={["tab-list", sizes.density !== "normal" && "tab-list-narrow", sizes.density === "compact" && "tab-list-compact"].filter(Boolean).join(" ")}
        style={{ "--tab-w": `${sizes.width}px`, "--tab-active-w": `${sizes.activeWidth}px` } as React.CSSProperties}
        data-tauri-drag-region
        ref={list}
        // With no scrollbar, the wheel scrolls the strip sideways.
        onWheel={(e) => {
          const el = e.currentTarget;
          if (e.deltaX === 0 && e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => {
          const key = tabKey(t);
          const on = key === active;
          const name = tabName(t);
          const isSaved = (t.kind === "query" || t.kind === "visual") && t.doc.savedId !== null;
          const dirty =
            isUnsaved(t) || ((t.kind === "object" || t.kind === "design") && !!dirtyKeys?.has(t.key)) || (t.kind === "flow" && unsavedFlows.has(t.name));
          const cid = tabConnectionId(t);
          const owner = cid === null ? undefined : connections.find((c) => c.id === cid);
          // R8: the chip shows PROD; the spoken name keeps the word.
          const label = [
            name,
            dirty ? "unsaved changes" : null,
            owner?.production ? "Production" : null,
            owner?.readOnly ? "Read-only" : null,
          ]
            .filter(Boolean)
            .join(", ");
          const icon = iconOf(t);
          // A Saved Query's tab shows no kind word; its tooltip says what it is and where it opens.
          const tip =
            isSaved && owner
              ? `${name}, Saved Query on ${owner.name}`
              : t.kind === "object" && t.preview
                ? `${name}. Preview: the next table you open replaces it. Double-click to keep it.`
                : name;
          return (
            <div
              key={key}
              data-key={key}
              className={[
                "work-tab",
                on && "work-tab-on",
                t.kind === "object" && t.preview && "work-tab-preview",
                drag.state?.key === key && "work-tab-dragging",
                drag.settling && "work-tab-settling",
              ]
                .filter(Boolean)
                .join(" ")}
              style={drag.styleOf(key)}
              onPointerDown={(e) => {
                // As in Edge: pressing a tab shows it at once, so a drag moves the tab being looked at.
                if (e.button === 0 && !on && !(e.target as HTMLElement).closest(".work-tab-close")) onSelect(key);
                drag.down(e, key);
              }}
              onDoubleClick={() => {
                if (t.kind === "object" && t.preview) onKeep?.(key);
              }}
              // A middle click closes the tab under the pointer; holding it down must not start autoscroll.
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(key);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const items = tabMenuItems(t);
                // A diagram's file actions follow the tab actions.
                const diagram = t.kind === "flow" && diagramActions ? diagramMenuItems(t.name, diagramActions).map((m, i) => (i === 0 ? { ...m, separatorBefore: true } : m)) : [];
                setMenu({ x: e.clientX, y: e.clientY, label: name, items: [...items, ...diagram] });
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={label}
                className="work-tab-button"
                title={tip}
                onClick={() => {
                  if (!drag.endedDrag()) onSelect(key);
                }}
                onKeyDown={(e) => {
                  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  if (drag.step(key, e.key === "ArrowLeft" ? -1 : 1)) {
                    e.preventDefault();
                    refocus.current = key;
                  }
                }}
              >
                {"feature" in icon ? <FeatureIcon name={icon.feature} size={16} /> : <Icon name={icon.icon} size={16} />}
                {owner && <SafetyTag connection={owner} small />}
                <span className="work-tab-name">{name}</span>
                {dirty && (
                  <span className="work-tab-unsaved" role="img" aria-label="Unsaved changes">
                    *
                  </span>
                )}
              </button>
              <button
                type="button"
                className="icon-button work-tab-close"
                aria-label={`Close ${name}`}
                title={withHint(`Close ${name}`, on ? hintFor(map, "tab.close") : null)}
                onClick={() => onClose(key)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-button tab-strip-new" aria-label="New query" title={withHint("New query", hintFor(map, "query.new"))} onClick={onNew}>
        <Icon name="plus" />
      </button>
      {onNewVisual && (
        // D10 and item 34: the kinds of new tab, beside New query, each with its large feature icon.
        <>
          <button
            ref={more}
            type="button"
            className="icon-button tab-strip-more"
            aria-label="More new tabs"
            title="More new tabs"
            aria-haspopup="menu"
            aria-expanded={newMenu}
            onClick={() => setNewMenu((o) => !o)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          {newMenu && (
            <NewTabMenu
              anchor={more}
              onClose={() => {
                setNewMenu(false);
                more.current?.focus();
              }}
              sections={newTabSections({
                map,
                onNew,
                onNewVisual,
                newVisualReady,
                onNewDiagram,
                onNewModel,
                newQueryWhere,
              })}
            />
          )}
        </>
      )}
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
