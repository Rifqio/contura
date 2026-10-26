// The icon picker (frame 6+.5, "Choosing an icon"): one search over every packed set, provider prefix first (the
// same order as completion after `icon:`), the matches in a 4-column grid with the best one highlighted. Arrows
// move the highlight, Enter or a click picks, Esc or a click away cancels. Only the icons the grid shows are
// loaded, and each is an <img> from a data: URL (ruling P7).
import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import type { IconEntry } from "../api/types";
import { providerOf, rankIcons } from "../lang/flow/iconRank";
import { iconEntries, useIcon } from "./icons";

/** The grid shows this many matches at most, so a short search never loads hundreds of icons. */
export const PICKER_LIMIT = 48;
const COLUMNS = 4;

interface Props {
  /** The search to start with, such as the icon the node has now. */
  initial?: string;
  onPick(name: string): void;
  onCancel(): void;
  style?: CSSProperties;
}

/** A search as icon names are written: lower case, spaces as dashes. */
function normalise(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, "-");
}

function Tile({ name }: { name: string }) {
  const { url, missing, failed, outline } = useIcon(name);
  return (
    <span className="icon-picker-tile is-bare">
      {url && !missing && !failed && <img className={outline ? "icon-hairline" : undefined} src={url} alt="" draggable={false} />}
    </span>
  );
}

export default function IconPicker({ initial = "", onPick, onCancel, style }: Props) {
  const [query, setQuery] = useState(initial);
  const [entries, setEntries] = useState<IconEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const latest = useRef({ onCancel });
  latest.current = { onCancel };

  useEffect(() => {
    let live = true;
    iconEntries().then(
      (e) => live && setEntries(e),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // A press outside the picker cancels it, as a menu does.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as globalThis.Node)) latest.current.onCancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const names = useMemo(() => entries?.map((e) => e.name) ?? [], [entries]);
  const titles = useMemo(() => new Map(entries?.map((e) => [e.name, e.title]) ?? []), [entries]);
  const q = normalise(query);
  const matches = useMemo(() => rankIcons(names, q, PICKER_LIMIT), [names, q]);
  const shown = Math.min(active, Math.max(0, matches.length - 1));
  // The typed provider prefix is left off the labels (frame 6+.5: "aws-dyn" shows "dynamodb").
  const typedProvider = providerOf(q);
  const label = (name: string) => (typedProvider && providerOf(name) === typedProvider ? name.slice(typedProvider.length + 1) : name);
  const optionId = (i: number) => `${id}-icon-${i}`;

  function onKey(e: React.KeyboardEvent) {
    const move = (by: number) => {
      e.preventDefault();
      if (matches.length > 0) setActive(Math.max(0, Math.min(matches.length - 1, shown + by)));
    };
    if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowDown") move(COLUMNS);
    else if (e.key === "ArrowUp") move(-COLUMNS);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[shown]) onPick(matches[shown]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <div ref={root} className="icon-picker nodrag nopan" role="dialog" aria-label="Choose an icon" style={style}>
      <input
        className="input icon-picker-search"
        type="search"
        role="searchbox"
        aria-label="Search icons"
        placeholder="Search every icon set"
        value={query}
        autoFocus
        spellCheck={false}
        aria-controls={`${id}-grid`}
        aria-activedescendant={matches.length > 0 ? optionId(shown) : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {failed ? (
        <p className="icon-picker-note" role="alert">
          Couldn't read the icon list.
        </p>
      ) : entries === null ? (
        <p className="icon-picker-note">Reading the icon list</p>
      ) : matches.length === 0 ? (
        <p className="icon-picker-note">{`No icon matches "${query.trim()}".`}</p>
      ) : (
        <div id={`${id}-grid`} className="icon-picker-grid" role="listbox" aria-label="Icons">
          {matches.map((name, i) => (
            <div
              key={name}
              id={optionId(i)}
              role="option"
              aria-selected={i === shown}
              className={i === shown ? "icon-picker-item is-active" : "icon-picker-item"}
              data-name={name}
              title={titles.get(name) && titles.get(name) !== name ? `${titles.get(name)} (${name})` : name}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(name)}
            >
              <Tile name={name} />
              <span className="icon-picker-name">{label(name)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
