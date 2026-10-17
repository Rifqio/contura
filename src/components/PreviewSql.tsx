import { useEffect, useState } from "react";
import { errorText, planEdits } from "../api/client";
import type { ConnectionId, EditSet } from "../api/types";
import Icon from "./Icon";

interface Props {
  connectionId: ConnectionId;
  edits: EditSet;
  onClose(): void;
}

/** The SQL Save will run, as the Core writes it, refreshed while the edits change. */
export default function PreviewSql({ connectionId, edits, onClose }: Props) {
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(edits);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      planEdits(connectionId, edits)
        .then((plan) => {
          if (!live) return;
          setSql(plan.statements.join(";\n\n") + (plan.statements.length ? ";" : ""));
          setError(null);
        })
        .catch((e) => live && setError(errorText(e)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [connectionId, key]);

  return (
    <aside className="preview-sql" aria-label="SQL preview">
      <div className="preview-sql-head">
        <span className="preview-sql-title">SQL Save will run</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy SQL"
          disabled={!sql}
          onClick={() => sql && void navigator.clipboard?.writeText(sql)}
        >
          <Icon name="copy" />
        </button>
        <button type="button" className="icon-button" aria-label="Close SQL preview" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : (
        <pre className="preview-sql-text" tabIndex={0} aria-label="SQL to save, read-only">
          {sql ?? "Writing the SQL…"}
        </pre>
      )}
    </aside>
  );
}
