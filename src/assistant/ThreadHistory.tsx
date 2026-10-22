import { useEffect, useRef, useState } from "react";
import { useOpenSignal } from "./useOpenSignal";
import { aiSearchThreads, errorText } from "../api/client";
import type { ThreadHit, ThreadSummary } from "../api/types";
import Icon from "../components/Icon";
import { agoText } from "../format/units";

interface Props {
  /** The drafts place key the search runs in. */
  place: string;
  /** What the place is called in the confirmation; the key when absent. */
  placeName?: string;
  /** The place's chats, newest first. */
  threads: ThreadSummary[];
  currentId: string | null;
  /** An answer is being written: nothing here may change the open chat. */
  busy: boolean;
  onOpen(id: string): void;
  onNewChat(): void;
  onClearThread(): void;
  onClearAll(): void;
  /** A slash command: `n` counts the requests; "clear" opens the popover on the question for the open chat. */
  command?: { n: number; kind: "open" | "clear" };
}

/** The question under a clear action: what goes, then Clear and Cancel. */
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

/** Show history: the header button and its popover in the Menu look. Search, the chats of the place, and the clear actions. */
export default function ThreadHistory({ place, placeName, threads, currentId, busy, onOpen, onClearThread, onClearAll, command }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmingThis, setConfirmingThis] = useState(false);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<ThreadHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setText("");
    setHits(null);
    setSearchError(null);
    setConfirming(false);
    setConfirmingThis(false);
  };

  useOpenSignal(command?.n ?? 0, () => {
    setOpen(true);
    setConfirming(false);
    setConfirmingThis(command?.kind === "clear");
  });

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The search waits 300 ms after the last keystroke; an answer that comes late for older text is dropped.
  useEffect(() => {
    const q = text.trim();
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

  const pick = (id: string) => {
    close();
    button.current?.focus();
    onOpen(id);
  };

  const searching = text.trim() !== "";
  const now = Date.now();
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

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
        <div className="menu menu-end history-menu" role="dialog" aria-label="Chat history">
          <input
            ref={field}
            type="search"
            className="history-search"
            aria-label="Search chats"
            placeholder="Search chats"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="history-list">
            {searching ? (
              hits === null ? null : hits.length === 0 ? (
                <p className="history-empty">{searchError ?? "No chats match"}</p>
              ) : (
                hits.map((h) => (
                  <button key={`${h.threadId}-${h.topic}`} type="button" className="menu-item history-hit" disabled={busy} onClick={() => pick(h.threadId)}>
                    <span className="menu-icon" />
                    <span className="menu-label">
                      <span className="menu-label-line">{h.title}</span>
                      <span className="menu-description">{h.topicTitle}</span>
                      <span className="menu-description">{h.snippet}</span>
                    </span>
                  </button>
                ))
              )
            ) : threads.length === 0 ? (
              <p className="history-empty">No chats yet</p>
            ) : (
              sorted.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  // Its own class: the query History's .history-row grid adds an empty second line (P11-40).
                  className="menu-item history-chat"
                  aria-current={t.id === currentId ? "true" : undefined}
                  disabled={busy}
                  onClick={() => pick(t.id)}
                >
                  <span className="menu-icon">{t.id === currentId && <Icon name="check" size={14} />}</span>
                  <span className="menu-label">
                    <span className="menu-label-line">{t.title}</span>
                  </span>
                  <span className="menu-hint">{agoText(now - t.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
          <hr className="menu-separator" />
          {confirmingThis ? (
            <ConfirmClear
              text="Clear this chat? Its messages are removed."
              onClear={() => {
                close();
                onClearThread();
              }}
              onCancel={() => setConfirmingThis(false)}
            />
          ) : confirming ? (
            <ConfirmClear
              text={`Clear the AI history of ${placeName ?? place}? Every thread in this place is removed.`}
              onClear={() => {
                close();
                onClearAll();
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <>
              <button
                type="button"
                className="menu-item"
                disabled={currentId === null || busy}
                onClick={() => setConfirmingThis(true)}
              >
                <span className="menu-icon">
                  <Icon name="trash" size={14} />
                </span>
                <span className="menu-label">Clear this chat</span>
              </button>
              <button type="button" className="menu-item menu-item-danger" disabled={threads.length === 0 || busy} onClick={() => setConfirming(true)}>
                <span className="menu-icon">
                  <Icon name="trash" size={14} />
                </span>
                <span className="menu-label">Clear all chats in this place...</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
