import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useOpenSignal } from "./useOpenSignal";
import { aiSearchThreads, errorText } from "../api/client";
import type { ConnectionConfig, ThreadSummary } from "../api/types";
import DbMark from "../components/DbMark";
import Icon from "../components/Icon";
import { agoText } from "../format/units";
import { HEAD_PX, LIST_PX, type ListItem, ROW_PX, groupByDay, rowTime, rowWindow } from "./historyList";

interface Props {
  /** The drafts place key the search runs in. */
  place: string;
  /** What the place is called in the confirmation; the key when absent. */
  placeName?: string;
  /** The place's chats, from the place load: opening the popover makes no call (P31). */
  threads: ThreadSummary[];
  currentId: string | null;
  /** An answer is being written: nothing here may change the open chat. */
  busy: boolean;
  /** The Connections, for each row's tag: its name and its DbMark. */
  connections: readonly ConnectionConfig[];
  /** The panel's width in px; the popover is 360 px or this when smaller. */
  width?: number;
  onOpen(id: string): void;
  /** The Core's row once the title is kept, or the refusal note. */
  onRename(id: string, title: string): Promise<ThreadSummary | string>;
  onDelete(id: string): void;
  onClearAll(): void;
  /** The second line of a chat that never worked in a database; null draws no second line (board chats). */
  emptyPlace?: string | null;
  /** A slash command: `n` counts the requests; "clear" opens the popover on the current chat's Delete question. */
  command?: { n: number; kind: "open" | "clear" };
}

/** The question under Clear all: what goes, then Clear and Cancel. */
function ConfirmClear({ text, onClear, onCancel }: { text: string; onClear(): void; onCancel(): void }) {
  return (
    <div className="history-confirm" role="alert">
      <p>{text}</p>
      <div className="history-confirm-actions">
        <button type="button" className="button button-small button-danger" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A row's Delete question, in the row itself: Cancel takes the focus, Esc cancels. */
function AskDelete({ title, onDelete, onCancel }: { title: string; onDelete(): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      className="history-ask"
      role="alertdialog"
      aria-label="Delete chat"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <span className="history-ask-title">Delete "{title}"?</span>
      <span className="history-ask-actions">
        <button type="button" ref={cancel} className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-small button-danger-fill" onClick={onDelete}>
          Delete
        </button>
      </span>
      <span className="history-ask-note">This cannot be undone.</span>
    </div>
  );
}

/** Rename in place: Enter or blur keeps, Esc cancels (R5); the field keeps its own keys (P28). */
function RenameField({
  text,
  note,
  saving,
  onText,
  onKeep,
  onCancel,
}: {
  text: string;
  note: string | null;
  saving: boolean;
  onText(text: string): void;
  onKeep(byKey: boolean): void;
  onCancel(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className="history-edit">
      <input
        ref={field}
        className="history-rename"
        aria-label="Chat title"
        maxLength={120}
        value={text}
        readOnly={saving}
        aria-invalid={note ? true : undefined}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => onKeep(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onKeep(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {note && (
        <span className="history-edit-note" role="alert">
          {note}
        </span>
      )}
    </div>
  );
}

interface Editing {
  id: string;
  was: string;
  text: string;
  note: string | null;
  saving: boolean;
}

/** Show history: the header button and its popover. Search, the place's chats by day, in-row Rename and Delete, Clear all. */
export default function ThreadHistory({
  place,
  placeName,
  threads,
  currentId,
  busy,
  connections,
  width,
  onOpen,
  onRename,
  onDelete,
  onClearAll,
  emptyPlace = "No database",
  command,
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<ThreadSummary[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focusedIn, setFocusedIn] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The row (or "search") to focus once it is drawn. */
  const pendingFocus = useRef<string | null>(null);
  /** The rename in progress, read by blur and Esc in the same tick (state would be a render late). */
  const editRef = useRef<Editing | null>(null);
  const askingRef = useRef<string | null>(null);
  /** A row had the focus and nothing else took it since: when the window drops that row, the list keeps the focus. */
  const rowFocused = useRef(false);
  /** The scroll position the next frame draws: scroll events update the window once per animation frame. */
  const latestTop = useRef(0);
  const frame = useRef(0);
  const keepRef = useRef<(byKey: boolean) => Promise<void>>(async () => {});

  const cancelFrame = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  };
  const onListScroll = (top: number) => {
    latestTop.current = top;
    if (typeof requestAnimationFrame !== "function") {
      setScrollTop(top);
      return;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(latestTop.current);
    });
  };
  useEffect(() => cancelFrame, []);

  const setEditing = (next: Editing | null) => {
    editRef.current = next;
    setEditingState(next);
  };
  const setAsk = (id: string | null) => {
    askingRef.current = id;
    setAsking(id);
  };

  const close = () => {
    setOpen(false);
    setText("");
    setHits(null);
    setSearchError(null);
    setConfirming(false);
    setAsk(null);
    setEditing(null);
    setHover(null);
    setFocusedIn(null);
    cancelFrame();
    rowFocused.current = false;
    latestTop.current = 0;
    setScrollTop(0);
  };

  const searching = text.trim() !== "";
  const now = Date.now();

  // The flat list the window walks: day headers and rows, or the search hits in relevance order (P38).
  const items = useMemo<ListItem[]>(() => {
    if (searching) return (hits ?? []).map((row) => ({ kind: "row", row }));
    const out: ListItem[] = [];
    for (const g of groupByDay(threads, Date.now())) {
      out.push({ kind: "head", label: g.label });
      for (const row of g.rows) out.push({ kind: "row", row });
    }
    return out;
  }, [searching, hits, threads]);
  const rowIds = useMemo(() => items.flatMap((it) => (it.kind === "row" ? [it.row.id] : [])), [items]);
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const it of items) {
      out.push(y);
      y += it.kind === "head" ? HEAD_PX : ROW_PX;
    }
    return out;
  }, [items]);
  const indexOf = (id: string) => items.findIndex((it) => it.kind === "row" && it.row.id === id);

  useOpenSignal(command?.n ?? 0, () => {
    setOpen(true);
    setConfirming(false);
    setEditing(null);
    const id = command?.kind === "clear" ? currentId : null;
    setAsk(id);
    if (id) reveal(id);
  });

  useEffect(() => {
    if (!open) return;
    // /clear opens on the question, which takes the focus itself.
    if (!askingRef.current) field.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      // A rename in progress is kept, as on blur (R5): closing first would drop the typed title.
      if (editRef.current) void keepRef.current(false);
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Leaving the list clears the hovered row. A native mouseleave: React's onMouseLeave comes from mouseout and its
  // relatedTarget, which a removed or redrawn row can leave pointing nowhere.
  useEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    const leave = () => setHover(null);
    el.addEventListener("mouseleave", leave);
    return () => el.removeEventListener("mouseleave", leave);
  }, [open]);

  // The search waits 300 ms after the last keystroke; an answer that comes late for older text is dropped.
  useEffect(() => {
    const q = text.trim();
    setScrollTop(0);
    if (list.current) list.current.scrollTop = 0;
    if (!q) {
      setHits(null);
      setSearchError(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      aiSearchThreads(place, q).then(
        (found) => {
          if (!live) return;
          setHits(found);
          setSearchError(null);
        },
        (e: unknown) => {
          if (!live) return;
          setHits([]);
          setSearchError(errorText(e));
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, place]);

  // A row the keyboard moved to is focused once the window draws it.
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    if (want === "search") {
      pendingFocus.current = null;
      field.current?.focus();
      return;
    }
    const row = list.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(want)}"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus();
    }
  });

  // The window dropped the focused row (the wheel scrolled it away): the list takes the focus, so the keys still work.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (rowFocused.current && list.current && (!active || active === document.body)) list.current.focus();
  });

  /** Scrolls the list so the row is in view, with its day header when it heads its group. */
  function reveal(id: string) {
    const j = indexOf(id);
    if (j < 0) return;
    const el = list.current;
    const laidOut = !!el && el.clientHeight > 0;
    const height = laidOut ? el.clientHeight : LIST_PX;
    const top = j > 0 && items[j - 1].kind === "head" ? tops[j - 1] : tops[j];
    const bottom = tops[j] + ROW_PX;
    let next = laidOut ? el.scrollTop : scrollTop;
    if (top < next) next = top;
    else if (bottom > next + height) next = bottom - height;
    if (el) el.scrollTop = next;
    latestTop.current = next;
    setScrollTop(next);
  }

  /** Moves the keyboard focus to a row, drawing it first when the window does not hold it (P18). */
  function moveTo(id: string) {
    reveal(id);
    setFocusId(id);
    // A drawn row takes the focus now; one outside the window once the new scroll draws it.
    const drawnRow = list.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (drawnRow) {
      pendingFocus.current = null;
      drawnRow.focus();
    } else pendingFocus.current = id;
  }

  const pick = (id: string) => {
    if (busy) return;
    close();
    button.current?.focus();
    onOpen(id);
  };

  const canDelete = (id: string) => !(busy && id === currentId);

  function startRename(t: ThreadSummary) {
    setAsk(null);
    setEditing({ id: t.id, was: t.title, text: t.title, note: null, saving: false });
  }

  function cancelRename() {
    const e = editRef.current;
    setEditing(null);
    if (e) moveTo(e.id);
  }

  async function keepRename(byKey: boolean) {
    const e = editRef.current;
    if (!e || e.saving) return;
    const title = e.text.trim();
    // An empty title is no title, and an unchanged one needs no call.
    if (title === "" || title === e.was) {
      setEditing(null);
      if (byKey) moveTo(e.id);
      return;
    }
    setEditing({ ...e, saving: true, note: null });
    const kept = await onRename(e.id, title);
    if (editRef.current?.id !== e.id) return;
    if (typeof kept === "string") {
      setEditing({ ...e, saving: false, note: kept });
      return;
    }
    setEditing(null);
    // The Core's row, so the hit keeps its title and titleBy in step with the list.
    setHits((h) => h?.map((x) => (x.id === e.id ? kept : x)) ?? null);
    if (byKey) moveTo(e.id);
  }

  keepRef.current = keepRename;

  function askDelete(id: string) {
    if (!canDelete(id)) return;
    setEditing(null);
    setAsk(id);
  }

  function cancelDelete() {
    const id = askingRef.current;
    setAsk(null);
    if (id) moveTo(id);
  }

  function confirmDelete(id: string) {
    const at = rowIds.indexOf(id);
    const next = rowIds[at + 1] ?? rowIds[at - 1] ?? null;
    setAsk(null);
    setHits((h) => h?.filter((x) => x.id !== id) ?? null);
    onDelete(id);
    if (next) moveTo(next);
    else pendingFocus.current = "search";
  }

  function onRowKey(e: ReactKeyboardEvent, id: string) {
    const at = rowIds.indexOf(id);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (at + 1 < rowIds.length) moveTo(rowIds[at + 1]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at > 0) moveTo(rowIds[at - 1]);
      else field.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(id);
    } else if (e.key === "Delete") {
      e.preventDefault();
      askDelete(id);
    } else if (e.key === "F2") {
      // VS Code's key for rename in a list.
      e.preventDefault();
      const it = items[indexOf(id)];
      if (it?.kind === "row") startRename(it.row);
    }
  }

  const laidOutHeight = list.current && list.current.clientHeight > 0 ? list.current.clientHeight : 0;
  const win = rowWindow(items, scrollTop, laidOutHeight);
  const drawn = items.slice(win.from, win.to);
  // Roving tabIndex: one row in the tab order, the last focused, else the current chat, else the first drawn.
  const drawnIds = drawn.flatMap((it) => (it.kind === "row" ? [it.row.id] : []));
  const tabId = [focusId, currentId, drawnIds[0]].find((id) => typeof id === "string" && drawnIds.includes(id)) ?? null;

  /** Line 2: the tag of the Connection and database, then the table or tab, muted; else the empty text. */
  function placeLine(t: ThreadSummary) {
    const w = t.work;
    const conn = w?.connectionId ? connections.find((c) => c.id === w.connectionId) : undefined;
    // R6: a deleted Connection's tag shows the database alone, with no mark.
    const tagText = !w?.connectionId ? null : conn ? (w.database ? `${conn.name} · ${w.database}` : conn.name) : w.database;
    if (tagText === null) {
      return emptyPlace === null ? null : <span className="history-chat-place">{emptyPlace}</span>;
    }
    const table = w?.table ?? w?.tabLabel ?? null;
    return (
      <span className="history-chat-place">
        <span className="history-tag">
          {conn && <DbMark dialect={conn.dialect} open size={14} label={null} />}
          <span>{tagText}</span>
        </span>
        {table && <span className="history-chat-table">{table}</span>}
      </span>
    );
  }

  function row(t: ThreadSummary) {
    const id = t.id;
    if (asking === id) {
      return (
        <div key={id} className="history-item">
          <AskDelete title={t.title} onDelete={() => confirmDelete(id)} onCancel={cancelDelete} />
        </div>
      );
    }
    if (editing?.id === id) {
      return (
        <div key={id} className="history-item">
          <RenameField
            text={editing.text}
            note={editing.note}
            saving={editing.saving}
            onText={(next) => setEditing({ ...editing, text: next, note: null })}
            onKeep={(byKey) => void keepRename(byKey)}
            onCancel={cancelRename}
          />
        </div>
      );
    }
    const active = hover === id || focusedIn === id;
    const ago = agoText(now - t.updatedAt);
    return (
      <div
        key={id}
        className="history-item"
        data-item-id={id}
        data-active={active ? "true" : undefined}
        onFocus={() => {
          rowFocused.current = true;
          setFocusedIn(id);
          setFocusId(id);
        }}
        onBlur={(e) => {
          const to = e.relatedTarget as Node | null;
          if (!e.currentTarget.contains(to)) setFocusedIn((f) => (f === id ? null : f));
          if (to && !list.current?.contains(to)) rowFocused.current = false;
        }}
      >
        <button
          type="button"
          // Its own class under .history-menu: never the query History's .history-row (P11-40, P30).
          className="history-chat"
          data-row-id={id}
          // The full title and the age: on hover the row actions take the time's place.
          title={`${t.title}\n${ago}`}
          aria-current={id === currentId ? "true" : undefined}
          aria-disabled={busy ? true : undefined}
          tabIndex={id === tabId ? 0 : -1}
          onClick={() => pick(id)}
          onKeyDown={(e) => onRowKey(e, id)}
        >
          <span className="history-chat-title">{t.title}</span>
          {!active && (
            <span className="history-chat-time" title={ago}>
              {rowTime(t.updatedAt, now)}
            </span>
          )}
          {placeLine(t)}
        </button>
        {active && (
          <span className="history-actions">
            <button type="button" className="icon-button" aria-label="Rename" title="Rename" onClick={() => startRename(t)}>
              <Icon name="edit" size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Delete"
              title="Delete"
              disabled={!canDelete(id)}
              onClick={() => askDelete(id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
      </div>
    );
  }

  const empty = searching
    ? hits !== null && hits.length === 0
      ? (searchError ?? "No chats match")
      : null
    : threads.length === 0
      ? "No chats yet"
      : null;

  return (
    <div
      className="menu-root"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close();
          button.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={button}
        className="icon-button"
        aria-label="Show history"
        // P11-40: no hover text while the popover is open, so it never covers the search field.
        title={open ? undefined : "Show history"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="history" size={16} />
      </button>
      {open && (
        <div
          className="menu menu-end history-menu"
          role="dialog"
          aria-label="Chat history"
          style={width !== undefined ? { width: Math.min(360, width) } : undefined}
        >
          <input
            ref={field}
            type="search"
            className="history-find"
            aria-label="Search chats"
            placeholder="Search chats"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Only Down leaves the field; Delete and the rest edit the text (P28).
              if (e.key === "ArrowDown" && rowIds.length > 0) {
                e.preventDefault();
                moveTo(rowIds[0]);
              }
            }}
          />
          <div
            className="history-items"
            ref={list}
            // Focusable only by script: it holds the focus when the window drops the focused row.
            tabIndex={-1}
            onScroll={(e) => onListScroll(e.currentTarget.scrollTop)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
              e.preventDefault();
              const id = focusId !== null && rowIds.includes(focusId) ? focusId : rowIds[0];
              if (id) moveTo(id);
            }}
            // The hovered row, by where the pointer is: moving onto a row's own buttons keeps it.
            onMouseOver={(e) => setHover((e.target as Element).closest("[data-item-id]")?.getAttribute("data-item-id") ?? null)}
          >
            {empty !== null && <p className="history-none">{empty}</p>}
            {win.before > 0 && <div className="history-spacer-before" style={{ height: win.before }} aria-hidden="true" />}
            {drawn.map((it) =>
              it.kind === "head" ? (
                <div key={`head:${it.label}`} className="history-group">
                  {it.label}
                </div>
              ) : (
                row(it.row)
              ),
            )}
            {win.after > 0 && <div className="history-spacer-after" style={{ height: win.after }} aria-hidden="true" />}
          </div>
          <hr className="menu-separator" />
          {confirming ? (
            <ConfirmClear
              text={`Clear the AI history of ${placeName ?? place}? Every thread in this place is removed.`}
              onClear={() => {
                close();
                onClearAll();
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <button type="button" className="history-clear-all" disabled={threads.length === 0 || busy} onClick={() => setConfirming(true)}>
              Clear all chats...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
