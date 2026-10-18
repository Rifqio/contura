import type { ConnectionConfig, ObjectPath } from "../api/types";
import DbMark from "../components/DbMark";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { plural } from "../format/plural";

interface Props {
  connection: ConnectionConfig;
  /** The table; null for a new table not created yet. */
  path: ObjectPath | null;
  changes: number;
  busy: boolean;
  /** The last Apply's failure, shown in the strip. */
  error: string | null;
  production: boolean;
  readOnly: boolean;
  canApply: boolean;
  /** Why Apply is off, shown in the strip and on the button. */
  reason: string | null;
  onDiscard(): void;
  onApply(): void;
  onDrop?(): void;
  /** Offered beside an error after which the table may differ from the loaded design. */
  onReload?(): void;
  /** The Production confirm is open: nothing is applying yet, so the label stays. */
  asking?: boolean;
  /** A new table's Name field, shown after the title. */
  name?: { value: string; onChange(name: string): void; disabled: boolean };
}

/** D27: the designer handles Ctrl+S itself (no registry command), so the hint stays literal. */
const APPLY_KEY = "Ctrl+S";

/** The table as the strip names it: `public.orders` with a schema, else `shop.orders`. */
function shortName(t: ObjectPath): string {
  return `${t.schema ?? t.database}.${t.name}`;
}

/** D21: the designer's 36 px header strip, built from the grid strip's classes. */
export default function DesignBar({
  connection,
  path,
  changes,
  busy,
  error,
  production,
  readOnly,
  canApply,
  reason,
  onDiscard,
  onApply,
  onDrop,
  onReload,
  asking = false,
  name: nameField,
}: Props) {
  const name = path ? shortName(path) : "New table";
  const off = !canApply || busy;
  const note = error ?? reason;
  return (
    <div className="table-header design-bar" role="toolbar" aria-label="Design header">
      <span className="table-header-connection">
        <DbMark dialect={connection.dialect} open size={14} label={null} />
        <span className="editor-header-name">{connection.name}</span>
      </span>
      {production && <span className="production-label">PRODUCTION</span>}
      <span className="editor-header-divider" aria-hidden="true" />
      <Icon name="edit" size={14} className="muted" />
      <h2 className="table-header-name" title={name}>
        {name}
      </h2>
      {readOnly && <Icon name="lock" size={14} className="muted" />}
      {nameField && (
        <input
          className="input input-small input-mono design-bar-name"
          aria-label="Table name"
          placeholder="Table name"
          value={nameField.value}
          disabled={nameField.disabled}
          onChange={(e) => nameField.onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      {note && (
        <span className={error ? "design-bar-note design-bar-error" : "design-bar-note"} role={error ? "alert" : undefined} title={note}>
          {note}
        </span>
      )}
      {error && onReload && (
        <button type="button" className="button button-small button-quiet" disabled={busy} onClick={onReload}>
          <Icon name="refresh" size={14} />
          Reload
        </button>
      )}
      <span className="edits-spacer" />
      {readOnly ? (
        <span className="chip">
          <Icon name="lock" size={14} />
          View only
        </span>
      ) : (
        changes > 0 && <span className="chip chip-warning">{plural(changes, "change", "changes")}</span>
      )}
      {path && !readOnly && onDrop && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Drop table ${path.name}`}
          title={`Drop table ${path.name}`}
          disabled={busy}
          onClick={onDrop}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label="Discard changes"
        title="Discard changes"
        disabled={readOnly || busy || changes === 0}
        onClick={onDiscard}
      >
        <Icon name="undo" size={14} />
      </button>
      {production ? (
        <button
          type="button"
          className="button button-small button-prod"
          disabled={off}
          onClick={onApply}
          title={reason ?? `Applying writes on Production and asks you to confirm first (${APPLY_KEY})`}
          // R8: the button shows PROD; its spoken name keeps the word.
          aria-label="Apply on Production"
          aria-keyshortcuts="Control+S"
        >
          {busy && !asking ? "Applying…" : "Apply on PROD"}
          <Kbd keys={APPLY_KEY} />
        </button>
      ) : (
        <button
          type="button"
          className="button button-small button-primary"
          disabled={off}
          onClick={onApply}
          title={reason ?? `Apply (${APPLY_KEY})`}
          aria-label="Apply"
          aria-keyshortcuts="Control+S"
        >
          {busy && !asking ? "Applying…" : "Apply"}
          <Kbd keys={APPLY_KEY} />
        </button>
      )}
    </div>
  );
}
