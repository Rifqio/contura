import { useEffect, useState } from "react";
import { errorText, planEdits } from "../api/client";
import type { ConnectionId, DialectKind, EditSet } from "../api/types";
import DbMark from "./DbMark";
import Icon from "./Icon";
import SafetyTag from "./SafetyTag";
import SqlBlock, { type SqlMark } from "./SqlBlock";

interface Props {
  connectionId: ConnectionId;
  edits: EditSet;
  onClose(): void;
  /** Where Save runs: the Connection's name and Dialect, and the table's database. */
  connectionName?: string;
  database?: string;
  dialect?: DialectKind;
  /** A Production Connection: the PROD chip, the band on every write and the confirm note. */
  production?: boolean;
  /** Puts the statements into a new, unsaved query tab on the same Connection, without running them. */
  onOpenQuery?(sql: string): void;
}

/** "4 statements, all write, in one transaction": every statement Save writes changes rows. */
function countText(n: number): string {
  return n === 1 ? "1 statement, a write, in one transaction" : `${n.toLocaleString("en-US")} statements, all write, in one transaction`;
}

/**
 * Frame 3: the SQL Save will run, as the Core writes it, in the confirm dialog's SQL block,
 * refreshed while the edits change. Read-only: nothing here runs it.
 */
export default function PreviewSql({
  connectionId,
  edits,
  onClose,
  connectionName,
  database,
  dialect = "postgres",
  production = false,
  onOpenQuery,
}: Props) {
  const [statements, setStatements] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(edits);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      planEdits(connectionId, edits)
        .then((plan) => {
          if (!live) return;
          setStatements(plan.statements);
          setError(null);
        })
        .catch((e) => live && setError(errorText(e)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [connectionId, key]);

  // Each statement ends with ";", a blank line between them: the same text Copy and Open give.
  const marks: SqlMark[] = [];
  let next = 1;
  for (const s of statements ?? []) {
    const lines = s.split("\n").length;
    marks.push({ firstLine: next, lastLine: next + lines - 1, tag: "writes", ...(production && { band: "prod" as const }) });
    next += lines + 1;
  }
  const sql = statements && statements.length > 0 ? statements.map((s) => `${s};`).join("\n\n") : null;

  return (
    <aside className="preview-sql" role="region" aria-label="Preview SQL">
      <div className="preview-sql-head">
        <Icon name="fileCode" size={14} className="muted" />
        <span className="preview-sql-title">Save will run</span>{" "}
        {connectionName && (
          <span className="preview-sql-where">
            <span className="preview-sql-on">on</span> <DbMark dialect={dialect} open size={14} label={null} />
            <b>{connectionName}</b>
            {database && (
              <>
                {" "}
                <span className="preview-sql-sep">·</span> {database}
              </>
            )}
          </span>
        )}
        <SafetyTag connection={{ production, readOnly: false }} small />
        {statements && (
          <>
            <span className="preview-sql-divider" aria-hidden="true" />
            <span className="preview-sql-count">{countText(statements.length)}</span>
          </>
        )}
        <span className="edits-spacer" />
        <button
          type="button"
          className="button button-small button-quiet"
          aria-label="Copy SQL"
          title="Copy SQL"
          disabled={!sql}
          onClick={() => sql && void navigator.clipboard?.writeText(sql)}
        >
          <Icon name="copy" size={14} />
          <span className="bar-label">Copy</span>
        </button>
        {onOpenQuery && (
          <button
            type="button"
            className="button button-small button-quiet"
            aria-label="Open in a query tab"
            title="Open in a query tab"
            disabled={!sql}
            onClick={() => sql && onOpenQuery(sql)}
          >
            <Icon name="external" size={14} />
            <span className="bar-label">Open in a query tab</span>
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close SQL preview" title="Close SQL preview" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="preview-sql-body">
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : (
          <div className="preview-sql-text" tabIndex={0} aria-label="SQL to save, read-only">
            {sql ? <SqlBlock sql={sql} dialect={dialect} marks={marks} /> : <p className="muted">Writing the SQL…</p>}
          </div>
        )}
      </div>
      <p className="preview-sql-foot">
        <Icon name={production ? "alert" : "info"} size={14} />
        {production
          ? "Read-only preview. Save on PROD shows this SQL again and asks before it runs."
          : "Read-only preview. Save runs exactly this."}
      </p>
    </aside>
  );
}
