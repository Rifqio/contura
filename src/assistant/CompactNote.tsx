import { useState } from "react";
import type { Compaction } from "../api/types";
import Icon from "../components/Icon";
import { formatTokens } from "./ContextMeter";

interface Props {
  compaction: Compaction;
  /** The display name of the model that wrote the summary; null when the rules wrote it. */
  modelName: string | null;
  /** Absent on the note of a compaction made by the Ask still running: it cannot be undone yet. */
  onUndo?(): void;
  /** The summary's measured tokens from the Sent record of the call; null when none was kept, and then no figure is shown. */
  tokens?: number | null;
  /** Undo is on its way: the link reads "Undoing..." and does nothing. */
  busy: boolean;
}

/** In the thread in place of the messages a compaction folded (board 11.6): the figures, Show the summary and Undo. */
export default function CompactNote({ compaction, modelName, tokens = null, onUndo, busy }: Props) {
  const [open, setOpen] = useState(false);
  const n = compaction.messages;
  const by =
    compaction.summaryBy.kind === "model"
      ? `Summary by ${modelName ?? compaction.summaryBy.model}${tokens != null ? `, ${formatTokens(tokens)} tokens` : ""}`
      : "Summary written by Contura";
  return (
    <div className="cnote-wrap">
      <div className="cnote" role="status">
        <Icon name="fileQuery" size={14} />
        <span className="cnote-text">{`Compacted ${n.toLocaleString("en-US")} older ${n === 1 ? "message" : "messages"} into a summary`}</span>
        <span className="mono cfig">{`${formatTokens(compaction.before)} → ${formatTokens(compaction.after)}`}</span>
      </div>
      <div className="cnote-links">
        <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide the summary" : "Show the summary"}
        </button>
        {onUndo && (
          <button type="button" className="link-button" disabled={busy} onClick={onUndo}>
            {busy ? "Undoing..." : "Undo"}
          </button>
        )}
      </div>
      {open && (
        <div className="csum">
          <span className="cst">{by}</span>
          {compaction.summary}
        </div>
      )}
    </div>
  );
}
