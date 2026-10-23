import { useEffect, useId, useState } from "react";
import { useOpenSignal } from "./useOpenSignal";
import { loadSendsOpen, onSendsOpen, saveSendsOpen } from "./sendsFold";
import type { ItemKind, Preview, PreviewItem, SummaryPreview } from "../api/types";
import Icon, { type IconName } from "../components/Icon";
import { type ContextConnection, contextTip, sendsAge } from "./contextText";
import { sizeText, tablesLine, tokensText } from "./payload";
import { thisComputer } from "../platform";

interface Props {
  /** The Core's preview; null until the first one arrives. */
  preview: Preview | null;
  /** Why the preview could not be built, when it could not. */
  error?: string | null;
  /** "To <host> (<model>)", or the line saying nothing is sent yet. */
  header: string;
  onToggle(kind: ItemKind): void;
  /** The words for an item; the item's own label by default. */
  labelOf?(item: PreviewItem): string;
  /** The Ask's Connection, for the AI Context tip under the rows. */
  connection?: ContextConnection | null;
  /** Shows the AI Context tip; the inline box shows only the header age. */
  withTip?: boolean;
  now?: number;
  /** The model that writes the summary, for the line under the rows. */
  modelName?: string | null;
  /** A slash command: each new value shows the exact text. */
  openSignal?: number;
  /**
   * A diagram Ask (board 11.12): every row is locked on with its reason, shown once, and the file row keeps its size;
   * no hover text, as in the diagram tab's side panel.
   */
  variant?: "diagram";
  /** The Ask panel folds the rows into the Sends line until opened; the choice is remembered. */
  foldable?: boolean;
}

/** Each kind of item has its own icon. */
const ICON: Record<ItemKind, IconName> = {
  question: "msg",
  names: "database",
  cards: "table",
  dbml: "schema",
  sql: "fileQuery",
  error: "error",
  savedQueries: "fileQuery",
  values: "pill",
  rows: "grid",
  outline: "layers",
  history: "history",
  summary: "history",
  diagram: "flow",
};

/**
 * Why an item is locked, in its own words. At "Schema and query text" the Literal values row is locked only because
 * sample rows are off, so it says the values stay masked. Read from the item's kind and the Connection's
 * access level, never from the Core's wording.
 */
function lockText(i: PreviewItem, connection: ContextConnection | null): string | null {
  if (i.kind === "values" && i.locked !== null && connection?.access === "schemaQuery") return `Values stay masked for ${connection.name}`;
  return i.locked;
}

/** "Summary step · last topic" or "Summary step · 14 older messages". */
function summaryLabel(s: SummaryPreview): string {
  return s.kind === "summary" ? "Summary step · last topic" : `Summary step · ${s.messages.toLocaleString("en-US")} older ${s.messages === 1 ? "message" : "messages"}`;
}

/** What one question would send, one row per item as the Core built it, with the exact text behind "Show exactly". */
export default function Sends({ preview, error = null, header, onToggle, labelOf, connection = null, withTip = true, now = Date.now(), modelName = null, openSignal = 0, variant, foldable = false }: Props) {
  const diagram = variant === "diagram";
  const [shown, setShown] = useState(false);
  const [open, setOpenState] = useState(() => !foldable || loadSendsOpen());
  useEffect(() => (foldable ? onSendsOpen(setOpenState) : undefined), [foldable]);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    saveSendsOpen(v);
  };
  useOpenSignal(openSignal, () => {
    setShown(true);
    if (foldable) setOpen(true);
  });
  const listId = useId();
  const id = useId();
  const tables = preview ? tablesLine(preview.tables) : null;
  const context = preview?.context ?? null;
  const outline = preview?.items.find((i) => i.kind === "outline");
  const summary = preview?.summary ?? null;
  const blocked = preview?.memory?.blocked ?? 0;
  const age = sendsAge(context, now);
  const tip = withTip && preview ? contextTip(context, connection, now) : null;

  const pill = (i: PreviewItem) => {
    const label = labelOf ? labelOf(i) : i.label;
    if (diagram) {
      // Locked on: nothing in a diagram Ask can be left out.
      return (
        <button type="button" className="send-pill" aria-pressed="true" aria-disabled="true">
          <Icon name={ICON[i.kind]} size={14} />
          <span className="send-pill-label">{label}</span>
        </button>
      );
    }
    if (i.kind === "question") {
      return (
        <span className="send-pill">
          <Icon name={ICON.question} size={14} />
          <span className="send-pill-label">{label}</span>
        </span>
      );
    }
    const fixed = i.locked !== null;
    return (
      <button
        type="button"
        className={i.kind === "outline" ? "send-pill send-pill-tall" : "send-pill"}
        aria-pressed={i.on}
        aria-disabled={fixed ? true : undefined}
        title={lockText(i, connection) ?? (i.kind === "rows" ? (i.on ? "Sent with this Ask. Click to leave it out." : "Left out. Click to send up to 5 rows of each named table.") : undefined)}
        onClick={() => {
          if (!fixed) onToggle(i.kind);
        }}
      >
        <Icon name={i.locked ? "lock" : ICON[i.kind]} size={14} />
        <span className="send-pill-label">
          {label}
          {!i.on && !i.locked ? " · off" : ""}
        </span>
      </button>
    );
  };

  /** A diagram row: its lock, its reason when no row above gave it, and the file's size on the file row. */
  const lockedOn = (i: PreviewItem, n: number) => {
    const above = preview!.items.slice(0, n);
    const file = i.kind === "diagram" && !above.some((x) => x.kind === "diagram");
    return (
      <>
        {i.locked && !above.some((x) => x.locked === i.locked) && <span className="sends-lock">{i.locked}</span>}
        {file && <span className="sends-size">{sizeText(i.bytes)}</span>}
        <span className="sends-locked-on" role="img" aria-label="Locked on">
          <Icon name="lock" size={14} />
        </span>
      </>
    );
  };

  return (
    <div className="sends" role={diagram ? "group" : undefined} aria-label={diagram ? "Sends" : undefined}>
      <div className="sends-row">
        {foldable ? (
          <button type="button" className="sends-fold" aria-expanded={open} aria-controls={open && preview ? listId : undefined} onClick={() => setOpen(!open)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
            <span className="sends-label">Sends</span>
          </button>
        ) : (
          <span className="sends-label">Sends</span>
        )}
        {preview && <span className="sends-size">{sizeText(preview.totalBytes + (summary?.on ? summary.bytes : 0))}</span>}
        {age && <span className="sends-age">{age}</span>}
        <span className="spacer" />
        {open && (
          <button
            type="button"
            className="link-button"
            aria-expanded={shown}
            aria-controls={id}
            disabled={!preview}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? "Hide" : "Show exactly"}
          </button>
        )}
      </div>
      {open && preview && (
        <ul className="sends-list" id={listId}>
          {preview.items.map((i, n) => (
            <li key={`${i.kind}-${n}`} className="sends-item">
              {pill(i)}
              {diagram ? (
                lockedOn(i, n)
              ) : i.locked ? (
                <span className="sends-lock">{lockText(i, connection)}</span>
              ) : (
                i.on && (
                  <span className="sends-size">
                    {sizeText(i.bytes)}, {tokensText(i.tokens)}
                  </span>
                )
              )}
            </li>
          ))}
          {summary && (
            <li className="sends-item">
              <button type="button" className="send-pill" aria-pressed={summary.on} onClick={() => onToggle("summary")}>
                <Icon name={ICON.summary} size={14} />
                <span className="send-pill-label">
                  {summaryLabel(summary)}
                  {summary.on ? "" : " · off"}
                </span>
              </button>
              {summary.on && (
                <span className="sends-size">
                  {sizeText(summary.bytes)}, {tokensText(summary.tokens)}
                </span>
              )}
            </li>
          )}
        </ul>
      )}
      {open && summary?.on && (
        <p className="sends-note">
          {summary.kind === "summary"
            ? `+ 1 step: the last topic is summarised by ${modelName ?? "the model"} first.`
            : `+ 1 step: ${summary.messages.toLocaleString("en-US")} older ${summary.messages === 1 ? "message" : "messages"} become one summary first.`}
        </p>
      )}
      {open && tables && <p className="sends-note">{tables}</p>}
      {open && blocked > 0 && (
        <p className="sends-note">
          {blocked.toLocaleString("en-US")} earlier {blocked === 1 ? "message stays" : "messages stay"} on {thisComputer()}: AI access is lower now.
        </p>
      )}
      {open &&
        preview?.notes.map((note) => (
          <p key={note} className="sends-note">
            {note}
          </p>
        ))}
      {error && <p className="sends-note">{error}</p>}
      {open && tip && <p className="sends-note sends-tip">{tip}</p>}
      {open && shown && preview && (
        <div id={id}>
          <p className="sends-note">{header}</p>
          <pre className="payload" tabIndex={0} role="region" aria-label="What is sent">
            {preview.exact}
          </pre>
          {summary?.on && (
            <>
              <p className="sends-note sends-step-head">
                Summary step
                <span className="sends-size">{sizeText(summary.bytes)}</span>
              </p>
              <pre className="payload" tabIndex={0} role="region" aria-label="What the summary step sends">
                {summary.exact}
              </pre>
            </>
          )}
          {preview.outline && outline?.on && (
            <>
              <p className="sends-note sends-step-head">
                Outline step, sent first
                <span className="sends-size">{sizeText(outline.bytes)}</span>
              </p>
              <pre className="payload" tabIndex={0} role="region" aria-label="What the outline step sends">
                {preview.outline.exact}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
