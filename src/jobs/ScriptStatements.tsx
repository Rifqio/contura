import type { DialectKind, ScriptStatement } from "../api/types";
import SqlBlock from "../components/SqlBlock";

/** The Statements step lists the first 50; Show all reads the rest from the file, 100 at a time. */
export const FIRST_STATEMENTS = 50;

interface Props {
  statements: ScriptStatement[];
  /** Every statement in the file. */
  total: number;
  dialect: DialectKind;
  loading: boolean;
  onMore(): void;
}

function actionText(s: ScriptStatement): string | null {
  if (s.action.kind === "skip") return `Skipped: ${s.action.reason}`;
  if (s.action.kind === "refuse") return `Refused: ${s.action.reason}`;
  return null;
}

/** Each statement in the read-only SQL style with its writes or reads label, at its line in the file. */
export default function ScriptStatements({ statements, total, dialect, loading, onMore }: Props) {
  const more = statements.length < total;
  return (
    <div className="script-statements">
      <ol className="script-list" aria-label="Statements">
        {statements.map((s) => {
          const note = actionText(s);
          const lines = s.text.split("\n").length;
          return (
            <li
              key={s.index}
              className={["script-statement", s.action.kind !== "run" ? `script-statement-${s.action.kind}` : ""].filter(Boolean).join(" ")}
            >
              {note && <p className="script-statement-note">{note}</p>}
              <SqlBlock
                sql={s.text}
                dialect={dialect}
                startLine={s.line}
                marks={[{ firstLine: s.line, lastLine: s.line + lines - 1, tag: s.class === "write" ? "writes" : "reads" }]}
              />
            </li>
          );
        })}
      </ol>
      <p className="script-count">
        Showing {statements.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} {total === 1 ? "statement" : "statements"}.
        {more && (
          <button type="button" className="button button-small" onClick={onMore} disabled={loading}>
            {statements.length <= FIRST_STATEMENTS ? "Show all" : "Show 100 more"}
          </button>
        )}
      </p>
    </div>
  );
}
