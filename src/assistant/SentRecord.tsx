import { useEffect, useRef } from "react";
import type { ItemKind, OutlineSent, SentRecord as Sent, SummarySent, Usage } from "../api/types";
import Icon from "../components/Icon";
import { providerName } from "./answerRecord";
import { yourComputer } from "../platform";

/** Said when "Keep the exact text sent" was off for the answer (R7.2). */
export const NOT_KEPT = "The exact text was not kept. Turn on Keep the exact text sent in AI settings.";

/** What the kept exact text holds where the sample rows went. */
const ROWS_NOT_KEPT = "[sample rows: not kept]";
const ROWS_NOTE = `Sample rows are never kept. The kept text shows ${ROWS_NOT_KEPT} where each table's rows went; Size and Hash count what was sent.`;

const KIND_WORDS: Record<ItemKind, string> = {
  question: "your question",
  names: "database and schema names",
  cards: "table cards",
  dbml: "the DBML",
  sql: "SQL text",
  error: "the error",
  savedQueries: "saved queries",
  values: "literal values",
  rows: "sample rows",
  outline: "the table outline",
  history: "the thread",
  summary: "a summary of earlier messages",
  diagram: "the diagram text",
  tab: "This tab",
  steps: "Recent steps",
  title: "the chat title call",
};

const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

/** "Outline step: 1,204 B, about 344 tokens, picked 1 area, 6 tables", plus ", 2 names dropped" when any. */
function outlineLine(o: OutlineSent): string {
  const parts = [`${n(o.bytes)} B`, `about ${n(o.tokens)} tokens`, `picked ${plural(o.pickedAreas, "area")}, ${plural(o.pickedTables, "table")}`];
  if (o.dropped > 0) parts.push(`${plural(o.dropped, "name")} dropped`);
  return `Outline step: ${parts.join(", ")}`;
}

/** "Summary step: 1,204 B, about 344 tokens, 4 messages"; "Compaction step: ..." for Compact now and auto-compact. */
const stepName = (c: SummarySent) => (c.kind === "compact" ? "Compaction step" : c.kind === "title" ? "Chat title step" : "Summary step");
function summaryLine(c: SummarySent): string {
  return `${stepName(c)}: ${n(c.bytes)} B, about ${n(c.tokens)} tokens, ${plural(c.messages, "message")}`;
}

const n = (v: number) => v.toLocaleString("en-US");

/** `11:42:05` on the local clock. */
function time(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
}

interface Props {
  sent: Sent;
  usage: Usage | null;
  /** The main request did not go out: its connection failed first, or the Ask ended after the outline step. */
  notSent?: boolean;
  onClose(): void;
  /** False in the diagram tab's side panel, where controls have no hover text. */
  hoverText?: boolean;
}

/** The one tool a diagram Ask offers; its definition is part of what was measured. */
const DIAGRAM_TOOL = "propose_diagram_changes";

/** The Sent record of one answer (R7.1): what went where, measured from the request itself. */
export default function SentRecord({ sent, usage, notSent = false, onClose, hoverText = true }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /** The Sent line that opened it, which gets focus back on close. */
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Reads only refs, so the first render's copy serves the key listener too.
  const close = () => {
    const back = opener.current;
    closeRef.current();
    if (back?.isConnected) back.focus();
  };
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    // Esc closes it wherever focus is in the panel, before anything else there takes the key.
    const onKey = (e: KeyboardEvent) => {
      const panel = ref.current?.closest(".ai-panel") ?? ref.current;
      if (e.key !== "Escape" || !panel || !(e.target instanceof Node) || !panel.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const extra = [sent.outlineCall && "an outline call", sent.summaryCall && (sent.summary?.kind === "compact" ? "a compaction call" : "a summary call")].filter(Boolean).join(" and ");
  const rows: [string, string][] = [
    ["Sent", sent.kinds.map((k) => KIND_WORDS[k]).join(", ") || "nothing"],
    ["Size", `${n(sent.bytes)} B, about ${n(sent.tokens)} tokens`],
    ["Provider", providerName(sent.provider)],
    ["Model", sent.modelName && sent.modelName !== sent.model ? `${sent.modelName}, ${sent.model}` : sent.model],
    ["Host", sent.host],
    ["Hash", sent.hash],
    ["Time", time(sent.at)],
    ["Cache", usage ? `${n(usage.cacheRead)} read, ${n(usage.cacheWrite)} written` : "not reported"],
  ];
  // A diagram Ask carries its one tool; the Core counts the definition in the bytes and the hash.
  if (sent.kinds.includes("diagram")) rows.splice(2, 0, ["Tool", `${DIAGRAM_TOOL}, counted in Size and Hash`]);
  if (extra) rows.push(["Extra", `Plus ${extra}`]);
  return (
    <div
      ref={ref}
      className="sent-pop"
      role="dialog"
      aria-label="Sent record"
      tabIndex={-1}
    >
      <div className="sent-pop-head">
        <span className="t">Sent record</span>
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Close" title={hoverText ? "Close" : undefined} onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {notSent && (
        <p className="sent-pop-note">
          {sent.outline
            ? `Only the outline step left ${yourComputer()}. The main request did not.`
            : sent.summary
              ? `Only the summary step left ${yourComputer()}. The main request did not.`
              : `The connection failed before the request went out, so none of this left ${yourComputer()}.`}
        </p>
      )}
      <dl className="sent-pop-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={k === "Hash" || k === "Host" || k === "Tool" ? "mono" : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      {sent.rows && (
        <p className="sent-pop-line sent-pop-rows-line">
          <Icon name="grid" size={14} />
          {`Sample rows: ${plural(sent.rows.rows, "row")} from ${plural(sent.rows.tables, "table")}, ${n(sent.rows.bytes)} B, read live by Contura`}
        </p>
      )}
      {sent.outline && <p className="sent-pop-line">{outlineLine(sent.outline)}</p>}
      {sent.summary && <p className="sent-pop-line">{summaryLine(sent.summary)}</p>}
      {sent.title && <p className="sent-pop-line">{summaryLine(sent.title)}</p>}
      {sent.exact != null ? (
        <pre className="sent-pop-exact" aria-label="Exactly what was sent">
          {sent.exact}
        </pre>
      ) : (
        <p className="sent-pop-note">{NOT_KEPT}</p>
      )}
      {sent.rows && sent.exact?.includes(ROWS_NOT_KEPT) && <p className="sent-pop-note">{ROWS_NOTE}</p>}
      {sent.outline?.exact != null && (
        <>
          <p className="sent-pop-exact-head">Outline step</p>
          <pre className="sent-pop-exact" aria-label="Exactly what the outline step sent">
            {sent.outline.exact}
          </pre>
        </>
      )}
      {sent.summary?.exact != null && (
        <>
          <p className="sent-pop-exact-head">{stepName(sent.summary)}</p>
          <pre className="sent-pop-exact" aria-label={`Exactly what the ${stepName(sent.summary).toLowerCase()} sent`}>
            {sent.summary.exact}
          </pre>
        </>
      )}
      {sent.title?.exact != null && (
        <>
          <p className="sent-pop-exact-head">{stepName(sent.title)}</p>
          <pre className="sent-pop-exact" aria-label="Exactly what the chat title step sent">
            {sent.title.exact}
          </pre>
        </>
      )}
    </div>
  );
}
