import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
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
  /** A slash command: each new value opens the list and shows the exact text, for this look only (not remembered). */
  openSignal?: number;
  /** An Ask was sent: each new value folds the list, as Copilot Chat folds "Used n references" per answer. */
  foldSignal?: number;
  /**
   * A diagram Ask (board 11.12): every row is locked on with its reason, shown once, and the file row keeps its size;
   * no hover text, as in the diagram tab's side panel.
   */
  variant?: "diagram";
  /** The Ask panel folds the rows into the Sends line; the chevron's choice is how a new panel opens. */
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
  tab: "layers",
  steps: "history",
  title: "edit",
  attachment: "fileCode",
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

/** The hover text of the pills that are on or off for this Ask only. */
function pillTitle(i: PreviewItem): string | undefined {
  if (i.kind === "rows") return i.on ? "Sent with this Ask. Click to leave it out." : "Left out. Click to send up to 5 rows of each named table.";
  if (i.kind === "steps") return i.on ? "Sent with this Ask. Click to leave it out." : "Left out of this Ask. Click to send it.";
  return undefined;
}

/** "Summary step · 14 older messages": the compaction, the only summary step an Ask makes. */
function summaryLabel(s: SummaryPreview): string {
  return `Summary step · ${s.messages.toLocaleString("en-US")} older ${s.messages === 1 ? "message" : "messages"}`;
}

/** What one question would send, one row per item as the Core built it, with the exact text behind "Show exactly". */
export default function Sends({ preview, error = null, header, onToggle, labelOf, connection = null, withTip = true, now = Date.now(), openSignal = 0, foldSignal = 0, variant, foldable = false }: Props) {
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
    if (foldable) setOpenState(true);
  });
  useOpenSignal(foldSignal, () => {
    if (!foldable) return;
    setOpenState(false);
    setShown(false);
  });
  const foldRef = useRef<HTMLButtonElement>(null);
  /** Esc inside the open list folds it, as the chevron does, and gives focus back to the chevron. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !foldable || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    foldRef.current?.focus();
  };
  const listId = useId();
  const id = useId();
  const tables = preview ? tablesLine(preview.tables) : null;
  const context = preview?.context ?? null;
  const outline = preview?.items.find((i) => i.kind === "outline");
  const summary = preview?.summary ?? null;
  /** The chat title call that follows the answer: one row, its size an estimate. */
  const title = preview?.title ?? null;
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
        title={lockText(i, connection) ?? pillTitle(i)}
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

  /** A board (any row with a fit): its first row's size is every diagram row's together, as the file row's was. */
  const boardBytes = preview?.items.some((x) => x.fit) ? preview.items.filter((x) => x.kind === "diagram").reduce((n, x) => n + x.bytes, 0) : null;
  /** A diagram row: its lock, its reason when no row above gave it, the file's size on the file row, and a board frame's fit. */
  const lockedOn = (i: PreviewItem, n: number) => {
    const above = preview!.items.slice(0, n);
    const file = i.kind === "diagram" && !above.some((x) => x.kind === "diagram");
    return (
      <>
        {i.fit && <span className="sends-size sends-fit">{i.fit}</span>}
        {i.locked && !above.some((x) => x.locked === i.locked) && <span className="sends-lock">{i.locked}</span>}
        {file && <span className="sends-size">{sizeText(boardBytes ?? i.bytes)}</span>}
        <span className="sends-locked-on" role="img" aria-label="Locked on">
          <Icon name="lock" size={14} />
        </span>
      </>
    );
  };

  return (
    <div className="sends" role={diagram ? "group" : undefined} aria-label={diagram ? "Sends" : undefined} onKeyDown={foldable ? onKeyDown : undefined}>
      <div className="sends-row">
        {foldable ? (
          <button
            ref={foldRef}
            type="button"
            className="sends-fold"
            aria-expanded={open}
            aria-controls={open && preview ? listId : undefined}
            title={open ? "Hide what this Ask sends" : "Show what this Ask sends"}
            onClick={() => setOpen(!open)}
          >
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
          {title && (
            <li className="sends-item">
              <button
                type="button"
                className="send-pill"
                aria-pressed={title.on}
                title={title.on ? "After the first answer, one short call writes this chat's title. Click to leave it out." : "Left out. Click to let the AI name this chat."}
                onClick={() => onToggle("title")}
              >
                <Icon name={ICON.title} size={14} />
                <span className="send-pill-label">
                  {`Chat title, ${tokensText(title.tokens)}`}
                  {title.on ? "" : " · off"}
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
      {open && summary?.on && (
        <p className="sends-note">
          {`+ 1 step: ${summary.messages.toLocaleString("en-US")} older ${summary.messages === 1 ? "message becomes" : "messages become"} one summary first.`}
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
