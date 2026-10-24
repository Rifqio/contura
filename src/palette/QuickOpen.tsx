import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keysFromEvent } from "../commands/keys";
import type { CommandId } from "../commands/registry";
import DbMark from "../components/DbMark";
import FeatureIcon from "../components/FeatureIcon";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import type { HighlightPart } from "./fuzzy";
import { type PaletteCommand, type PaletteRow, type QuickItem, type QuickItemKind, type QuickRow, createQuickSearch, modeOf, paletteRows } from "./entries";

export interface QuickOpenProps {
  /** The text it opens with: "" for Quick Open, ">" for the Command Palette. */
  initial: string;
  /** Bumped when Quick Open or the palette is asked for again while open: the box starts over with `initial`. */
  seq: number;
  all: readonly QuickItem[];
  /** No Connection is open, so no table, view or routine can be searched: an empty result then says how to get some. */
  noOpenConnection?: boolean;
  recentIds: readonly string[];
  /** The commands that can run now, with their keys from the live keymap. */
  commands: readonly PaletteCommand[];
  recentCommands: readonly CommandId[];
  /** The live keys of Quick Open and the palette: pressed in the box they move down or switch mode (VS Code). */
  quickOpenKeys: readonly string[];
  paletteKeys: readonly string[];
  /** Opens an item: "enter" in a kept tab that becomes active, "behind" without leaving the tab you are on. */
  onOpen(item: QuickItem, how: "enter" | "behind"): void;
  /** Runs a command; focus is back where it was when this is called. */
  onRun(id: CommandId): void;
  onClose(): void;
}

/** VS Code shows about ten rows; Page Up and Page Down move by one less. */
const PAGE = 10;

const KIND_ICON: Record<Exclude<QuickItemKind, "model">, IconName> = {
  table: "table",
  view: "view",
  function: "routine",
  procedure: "routine",
  trigger: "trigger",
  saved: "fileQuery",
  visual: "visualQuery",
  flow: "flow",
};

const HELP = [
  { prefix: "", label: "…", text: "Go to a table, view, routine, Saved Query or diagram" },
  { prefix: ">", label: ">", text: "Show and run commands" },
];

type Row = { kind: "item"; row: QuickRow } | { kind: "command"; row: PaletteRow } | { kind: "help"; prefix: string; label: string; text: string };

function Marked({ parts }: { parts: HighlightPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <b key={i} className="qo-hit">
            {p.text}
          </b>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Where focus can go back to: an element still on screen, not inside a hidden pane. */
const canFocus = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && !el.closest("[hidden]");

/**
 * Quick Open and the Command Palette, one box as in VS Code: names to open, or with `>` typed first the commands.
 * It sits at the top centre under the title bar, with no scrim; Esc or a click outside closes it and focus goes back.
 */
export default function QuickOpen(p: QuickOpenProps) {
  // Read while drawing the first time, before the box takes focus.
  const [from] = useState(() => document.activeElement);
  const [text, setText] = useState(p.initial);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;

  const mode = modeOf(text);
  // Made once per list (as the box opens); each key then only scores.
  const search = useMemo(() => createQuickSearch(p.all, p.recentIds), [p.all, p.recentIds]);
  const rows: Row[] = useMemo(() => {
    if (mode === "help") return HELP.map((h) => ({ kind: "help" as const, ...h }));
    if (mode === "commands") return paletteRows(p.commands, p.recentCommands, text.slice(1)).map((row) => ({ kind: "command" as const, row }));
    return search.rows(text).map((row) => ({ kind: "item" as const, row }));
  }, [mode, text, p.commands, p.recentCommands, search]);
  const at = rows.length === 0 ? -1 : Math.min(sel, rows.length - 1);

  // Asked for again while open: start over.
  const firstSeq = useRef(p.seq);
  useEffect(() => {
    if (p.seq === firstSeq.current) return;
    firstSeq.current = p.seq;
    setText(p.initial);
    setSel(0);
  }, [p.seq, p.initial]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [p.seq]);

  // The keyboard selection stays in view; the wheel scrolls freely until the next key.
  useEffect(() => {
    if (at < 0) return;
    list.current?.querySelector(`#qo-${at}`)?.scrollIntoView?.({ block: "nearest" });
  }, [at, rows]);

  const restoreFocus = () => {
    if (canFocus(from)) from.focus({ preventScroll: true });
  };

  // A press outside closes it; the press goes on to what it was on.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      restoreFocus();
      latest.current.onClose();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
    // `from` is fixed for the box's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function accept(row: Row | undefined, how: "enter" | "behind") {
    if (!row) return;
    if (row.kind === "help") {
      setText(row.prefix);
      setSel(0);
      return;
    }
    if (row.kind === "command") {
      restoreFocus();
      p.onClose();
      p.onRun(row.row.id);
      return;
    }
    if (how === "enter") p.onClose();
    p.onOpen(row.row.item, how);
  }

  const move = (by: number, wrap: boolean) => {
    if (rows.length === 0) return;
    const next = at + by;
    setSel(wrap ? (next + rows.length) % rows.length : Math.max(0, Math.min(rows.length - 1, next)));
  };

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const keys = keysFromEvent(e.nativeEvent);
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (keys && p.paletteKeys.includes(keys)) {
      done();
      if (mode === "commands") move(1, true);
      else {
        setText(">");
        setSel(0);
      }
      return;
    }
    if (keys && p.quickOpenKeys.includes(keys)) {
      done();
      if (mode === "open") move(1, true);
      else {
        setText("");
        setSel(0);
      }
      return;
    }
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    switch (e.key) {
      case "Escape":
        done();
        restoreFocus();
        p.onClose();
        return;
      case "ArrowDown":
        if (!plain) return;
        done();
        move(1, true);
        return;
      case "ArrowUp":
        if (!plain) return;
        done();
        move(-1, true);
        return;
      case "PageDown":
        done();
        move(PAGE - 1, false);
        return;
      case "PageUp":
        done();
        move(-(PAGE - 1), false);
        return;
      case "Enter":
        done();
        // Ctrl+Enter is not bound (no convention fits a window without split editors).
        if (plain) accept(rows[at], "enter");
        return;
      case "ArrowRight": {
        const el = e.currentTarget;
        const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
        if (plain && atEnd && rows[at]?.kind === "item") {
          done();
          accept(rows[at], "behind");
        }
        return;
      }
      case "Tab":
        // Focus stays in the box, as in VS Code.
        done();
        return;
    }
  }

  const title = mode === "commands" ? "Command Palette" : "Quick Open";
  const sectionOf = (r: Row) => (r.kind === "help" ? null : r.row.section);
  let body: ReactNode;
  if (rows.length === 0) {
    body = (
      <div className="qo-empty" role="status">
        {mode === "commands" ? "No matching commands" : p.noOpenConnection ? "No matching results. Open a Connection to search its tables." : "No matching results"}
      </div>
    );
  } else {
    body = (
      <div className="qo-list" id="qo-list" role="listbox" aria-label={`${title} results`} ref={list}>
        {rows.map((r, i) => {
          const section = sectionOf(r);
          return (
            <div
              key={r.kind === "item" ? r.row.item.id : r.kind === "command" ? r.row.id : r.prefix}
              id={`qo-${i}`}
              role="option"
              aria-selected={i === at}
              className={["qo-row", i === at && "qo-row-on", section && i > 0 && "qo-row-section"].filter(Boolean).join(" ")}
              // The box keeps focus: a press on a row must not take it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(r, "enter")}
            >
              <RowContent row={r} />
              {section && <span className="qo-section">{section}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="qo" role="dialog" aria-label={title} ref={panel}>
      <input
        ref={input}
        className="input qo-input"
        data-keys-own=""
        role="combobox"
        aria-label="Search by name, or type > for commands"
        aria-expanded={rows.length > 0}
        aria-controls="qo-list"
        aria-autocomplete="list"
        aria-activedescendant={at >= 0 ? `qo-${at}` : undefined}
        placeholder={mode === "open" ? "Search tables, views, routines, Saved Queries and diagrams (> for commands, ? for help)" : undefined}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKeyDown}
      />
      {body}
    </div>
  );
}

function RowContent({ row }: { row: Row }) {
  if (row.kind === "help") {
    return (
      <>
        <Icon name="info" className="qo-icon" />
        <span className="qo-label">{row.label}</span>
        <span className="qo-desc">{row.text}</span>
      </>
    );
  }
  if (row.kind === "command") {
    const r = row.row;
    return (
      <>
        <span className="qo-label">
          <Marked parts={r.label} />
        </span>
        <span className="qo-desc">{r.note}</span>
        {r.keys && (
          <span className="qo-keys">
            <Kbd keys={r.keys} />
          </span>
        )}
      </>
    );
  }
  const { item, label, description } = row.row;
  const c = item.connection;
  return (
    <>
      {item.kind === "model" ? <FeatureIcon name="model" size={16} className="qo-icon" /> : <Icon name={KIND_ICON[item.kind]} className="qo-icon" />}
      <span className="qo-label">
        <Marked parts={label} />
      </span>
      <span className="qo-desc">
        <Marked parts={description} />
      </span>
      {c && (
        <span className={c.open ? "qo-conn" : "qo-conn qo-conn-closed"}>
          <DbMark dialect={c.dialect} open={c.open} size={14} label={null} />
          {c.name}
          <SafetyTag connection={c} small />
          {!c.open && <span>closed</span>}
        </span>
      )}
    </>
  );
}
