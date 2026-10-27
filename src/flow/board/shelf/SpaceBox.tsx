// The Space box (decision 19): a Space tap or `/` over the canvas opens a small search at the pointer, a non-modal
// dialog with an editable combobox (APG) and at most 8 rows. Enter drops the pick at the crosshair; Tab grows it into
// the Shelf with the search kept; Esc or a press outside closes it. It opens 12 px right and below the pointer, flipped
// to stay inside the canvas (`placeBox`).
import { useStore } from "@xyflow/react";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Icon from "../../../components/Icon";
import Kbd from "../../../components/Kbd";
import { motionMs } from "../../../diagram/motion";
import { useIcon } from "../../icons";
import type { ShelfIconSource } from "./iconSource";
import { spaceResults } from "./spaceResults";
import type { ShelfItem } from "./types";

type Point = { x: number; y: number };
export type SpaceBoxCloseReason = "escape" | "outside";

/** How far from the pointer the box opens. */
const GAP = 12;

/**
 * Where the box's top-left goes, in the canvas's own coordinates: `GAP` right and below `at`, flipped left or up where
 * it would pass the canvas's edge, and held inside the canvas (at 0, 0 when the canvas is smaller than the box).
 */
export function placeBox(at: Point, size: { w: number; h: number }, bounds: { w: number; h: number }): Point {
  const axis = (p: number, s: number, b: number) => {
    const v = p + GAP + s > b ? p - GAP - s : p + GAP;
    return Math.max(0, Math.min(v, b - s));
  };
  return { x: axis(at.x, size.w, bounds.w), y: axis(at.y, size.h, bounds.h) };
}

interface Props {
  /** The pointer, in the canvas's own coordinates. */
  at: Point;
  /** The canvas's size. */
  bounds: { w: number; h: number };
  initialQuery?: string;
  /** The Shelf's one icon source (decision 6). */
  icons: ShelfIconSource;
  onPick(item: ShelfItem): void;
  /** Tab: the Shelf opens with this search. */
  onShelf(query: string): void;
  onClose(reason: SpaceBoxCloseReason): void;
}

/**
 * Inside the canvas's React Flow: calls `onMoved` once the view pans or zooms from where it was when this mounted (a
 * wheel, a fit, a glide). Figma and Miro close an insert popover then: its crosshair would no longer mark the drop.
 */
export function ViewMoved({ onMoved }: { onMoved(): void }) {
  const t = useStore((s) => s.transform);
  const first = useRef(t);
  const moved = useRef(onMoved);
  moved.current = onMoved;
  useEffect(() => {
    const f = first.current;
    if (t[0] !== f[0] || t[1] !== f[1] || t[2] !== f[2]) moved.current();
  }, [t]);
  return null;
}

/** A pack icon's image, through the shared cache. */
function PackIcon({ name }: { name: string }) {
  const { url, missing, failed, outline } = useIcon(name);
  return <span className="flow-space-image">{url && !missing && !failed && <img className={outline ? "icon-hairline" : undefined} src={url} alt="" draggable={false} />}</span>;
}

export default function SpaceBox({ at, bounds, initialQuery = "", icons, onPick, onShelf, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [loadedFrom, setLoadedFrom] = useState<ShelfIconSource | null>(() => (icons.count("") !== null ? icons : null));
  const iconsLoaded = loadedFrom === icons;
  const [place, setPlace] = useState<Point>(() => ({ x: at.x + GAP, y: at.y + GAP }));
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ onClose });
  latest.current = { onClose };
  const id = useId();
  const listId = `${id}list`;
  const optionId = (i: number) => `${id}o${i}`;

  const rows = useMemo(
    () => spaceResults(query, icons),
    // iconsLoaded: the icons arrive with the pack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, icons, iconsLoaded],
  );
  const at0 = rows.length ? Math.min(active, rows.length - 1) : -1;

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (iconsLoaded) return;
    let live = true;
    icons.load().then(
      () => live && setLoadedFrom(icons),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [icons, iconsLoaded]);

  // Placed once per open, when its size is known: its height is fixed (the list keeps room for 8 rows), so typing and
  // the icons arriving never move its search.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const p = placeBox(at, { w: el.offsetWidth, h: el.offsetHeight }, bounds);
    setPlace((was) => (was.x === p.x && was.y === p.y ? was : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at.x, at.y, bounds.w, bounds.h]);

  // A press outside closes it.
  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && root.current?.contains(t)) return;
      latest.current.onClose("outside");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // The board's own Esc (disarm, deselect) must not also run.
      e.preventDefault();
      e.stopPropagation();
      onClose("escape");
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onShelf(query);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = rows.length;
      if (n) setActive(((at0 + (e.key === "ArrowDown" ? 1 : -1)) % n + n) % n);
      return;
    }
    // An Enter that ends an IME composition is the input's.
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (at0 >= 0) onPick(rows[at0].item);
    }
  };

  /** One focus owner: a press anywhere in the box leaves focus in the search. */
  const keepFocus = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== input.current) e.preventDefault();
  };

  return (
    <>
      <span className="flow-space-cross" aria-hidden="true" style={{ left: `${at.x}px`, top: `${at.y}px` }} />
      <div
        ref={root}
        className="flow-space-box"
        role="dialog"
        aria-label="Add here"
        style={{ left: `${place.x}px`, top: `${place.y}px`, maxHeight: `${bounds.h}px`, animationDuration: `${motionMs("menu")}ms` }}
        onKeyDown={onKeyDown}
        onMouseDown={keepFocus}
      >
        <div className="flow-space-search">
          <Icon name="search" size={14} />
          <input
            ref={input}
            className="flow-space-input"
            type="text"
            role="combobox"
            aria-label="Search diagrams, templates and icons"
            placeholder="Add a diagram, template or icon"
            aria-expanded={rows.length > 0}
            aria-autocomplete="list"
            aria-controls={rows.length ? listId : undefined}
            aria-activedescendant={at0 >= 0 ? optionId(at0) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div className="flow-space-list">
          {rows.length ? (
            <div id={listId} role="listbox" aria-label="Results" className="flow-space-rows">
              {rows.map((r, i) => (
                <div
                  key={`${r.item.kind}:${r.name}:${i}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === at0}
                  aria-label={r.name}
                  aria-describedby={`${optionId(i)}t`}
                  className={i === at0 ? "flow-space-row is-active" : "flow-space-row"}
                  onPointerMove={() => i !== at0 && setActive(i)}
                  onClick={() => onPick(r.item)}
                >
                  {"app" in r.icon ? <Icon name={r.icon.app} size={16} /> : <PackIcon name={r.icon.pack} />}
                  <span className="flow-space-name">{r.name}</span>
                  <span id={`${optionId(i)}t`} className="flow-space-tag">
                    {r.tag}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="flow-space-empty">Nothing matches. Tab opens the full Shelf.</p>
          )}
        </div>
        <p className="flow-space-foot">
          <span>Drops it at the crosshair</span>
          <span>
            <Kbd keys="Enter" /> adds <Kbd keys="Tab" /> full Shelf <Kbd keys="Esc" /> closes
          </span>
        </p>
      </div>
    </>
  );
}
