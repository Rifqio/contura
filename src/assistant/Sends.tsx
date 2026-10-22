import { useId, useState } from "react";
import type { ItemKind, Preview, PreviewItem } from "../api/types";
import Icon, { type IconName } from "../components/Icon";
import { type ContextConnection, contextTip, sendsAge } from "./contextText";
import { sizeText, tablesLine, tokensText } from "./payload";

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
}

/** Why the sample rows item cannot be switched: no rows are fetched yet. */
export const ROWS_LATER = "Sample rows arrive with a later step.";

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
};

/** What one question would send, one row per item as the Core built it, with the exact text behind "Show exactly". */
export default function Sends({ preview, error = null, header, onToggle, labelOf, connection = null, withTip = true, now = Date.now() }: Props) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const tables = preview ? tablesLine(preview.tables) : null;
  const context = preview?.context ?? null;
  const outline = preview?.items.find((i) => i.kind === "outline");
  const age = sendsAge(context, now);
  const tip = withTip && preview ? contextTip(context, connection, now) : null;

  const pill = (i: PreviewItem) => {
    const label = labelOf ? labelOf(i) : i.label;
    if (i.kind === "question") {
      return (
        <span className="send-pill">
          <Icon name={ICON.question} size={14} />
          {label}
        </span>
      );
    }
    const fixed = i.locked !== null || i.kind === "rows";
    return (
      <button
        type="button"
        className={i.kind === "outline" ? "send-pill send-pill-tall" : "send-pill"}
        aria-pressed={i.kind === "rows" ? undefined : i.on}
        aria-disabled={fixed ? true : undefined}
        title={i.locked ?? (i.kind === "rows" ? ROWS_LATER : undefined)}
        onClick={() => {
          if (!fixed) onToggle(i.kind);
        }}
      >
        <Icon name={i.locked ? "lock" : ICON[i.kind]} size={14} />
        {label}
        {!i.on && !i.locked ? " · off" : ""}
      </button>
    );
  };

  return (
    <div className="sends">
      <div className="sends-row">
        <span className="sends-label">Sends</span>
        {preview && <span className="sends-size">{sizeText(preview.totalBytes)}</span>}
        {age && <span className="sends-age">{age}</span>}
        <span className="spacer" />
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
      </div>
      {preview && (
        <ul className="sends-list">
          {preview.items.map((i, n) => (
            <li key={`${i.kind}-${n}`} className="sends-item">
              {pill(i)}
              {i.locked ? (
                <span className="sends-lock">{i.locked}</span>
              ) : (
                i.on && (
                  <span className="sends-size">
                    {sizeText(i.bytes)}, {tokensText(i.tokens)}
                  </span>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {tables && <p className="sends-note">{tables}</p>}
      {preview?.notes.map((note) => (
        <p key={note} className="sends-note">
          {note}
        </p>
      ))}
      {error && <p className="sends-note">{error}</p>}
      {tip && <p className="sends-note sends-tip">{tip}</p>}
      {shown && preview && (
        <div id={id}>
          <p className="sends-note">{header}</p>
          <pre className="payload">{preview.exact}</pre>
          {preview.outline && outline?.on && (
            <>
              <p className="sends-note sends-step-head">
                Outline step, sent first
                <span className="sends-size">{sizeText(outline.bytes)}</span>
              </p>
              <pre className="payload">{preview.outline.exact}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
