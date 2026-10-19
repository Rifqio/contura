// The SQL pane (frame 6.1): the Core's text for the model, read only, with its warnings under it.
import type { KeyboardEvent } from "react";
import { DIALECT_LABEL } from "../api/client";
import type { DialectKind, VqPreview } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SqlBlock, { type SqlMark } from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";

export interface SqlBand {
  from: number;
  to: number;
  kind: "select" | "danger";
}

export interface SqlPaneProps {
  dialect: DialectKind;
  preview: VqPreview | null;
  production: boolean;
  bands: SqlBand[];
  /** The warnings in words: the tab names the tables (the Core only has their ids). */
  warnings?: string[];
  /** What to say while there is no SQL (no table yet, or the problems that stop it). */
  empty?: string[];
  onCopy(): void;
  onOpenInEditor(): void;
  onLine(line: number): void;
}

export default function SqlPane({ dialect, preview, production, bands, warnings = [], empty = [], onCopy, onOpenInEditor, onLine }: SqlPaneProps) {
  const { map } = useKeymap();
  const openKey = hintFor(map, "visualQuery.openInEditor");
  const sql = preview?.query?.sql ?? null;
  const marks: SqlMark[] = bands.map((b) => ({ firstLine: b.from, lastLine: b.to, band: b.kind }));
  // Ctrl+C in the pane: a selection copies itself; with nothing selected, the whole SQL.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (sql === null || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "c") return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    e.preventDefault();
    onCopy();
  };
  return (
    <section className={production ? "vq-sql prod-wash" : "vq-sql"} data-part="sql" aria-label="SQL" onKeyDown={onKeyDown}>
      {/* Item 30: in the panel's SQL tab, the strip says what the SQL is and what can be done with it. */}
      <div className="vq-sql-strip">
        <span className="chip chip-neutral">{DIALECT_LABEL[dialect]}</span>
        <span className="vq-sql-readonly">Read only. Edits in the editor do not come back here.</span>
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Copy SQL" title="Copy Ctrl+C" disabled={sql === null} onClick={onCopy}>
          <Icon name="copy" size={14} />
        </button>
        <button type="button" className="button button-small" disabled={sql === null} onClick={onOpenInEditor}>
          Open in editor
          {openKey && <Kbd keys={openKey} />}
        </button>
      </div>
      {/* Focusable by a click, so Ctrl+C reaches the pane; not a tab stop. */}
      <div className="vq-sql-body" tabIndex={-1}>
        {sql !== null ? (
          <SqlBlock sql={sql} dialect={dialect} marks={marks} ariaLabel="Generated SQL" className="vq-sql-code" onLineClick={onLine} />
        ) : (
          <div className="vq-sql-empty">
            {empty.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}
        {warnings.map((w) => (
          <WarningBanner key={w} className="vq-sql-warning">
            {w}
          </WarningBanner>
        ))}
      </div>
    </section>
  );
}
