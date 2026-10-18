import { useState } from "react";
import type { DialectKind, Group, RunVerdict } from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import GroupBadge from "../components/GroupBadge";
import SafetyTag from "../components/SafetyTag";
import SqlBlock, { type SqlMark } from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

interface Props {
  verdict: Ask;
  /** An UPDATE or DELETE without WHERE among the statements, by index; its warning sits at the top. */
  noWhere?: { index: number; verb: "UPDATE" | "DELETE"; table: string } | null;
  onRun(): void;
  onCancel(): void;
  /** Offered beside the no-WHERE warning when given. */
  onAddWhere?(): void;
  /** "Save" for Pending Edits, "Apply" for a design, "Drop" for a table drop: the title and button say it. */
  verb?: "Run" | "Save" | "Apply" | "Drop";
  /** Plan warnings, one banner each, above the count line. */
  warnings?: string[];
  /** The Connection's database, for the mark before the title. */
  dialect?: DialectKind;
  /** The Connection's Group, for the square after the PROD chip; none for Ungrouped. */
  group?: Group | null;
  /** Rows the statement without WHERE would change, when known; the warning says "about N rows". */
  rowEstimate?: number | null;
}

const DOES: Record<NonNullable<Props["verb"]>, string> = { Run: "runs", Save: "saves", Apply: "applies", Drop: "drops" };

/** "2 of 3 statements write.", "1 of 2 statements writes.", "1 of 1 statement writes." */
function countText(writes: number, total: number): string {
  return `${writes} of ${total} ${total === 1 ? "statement" : "statements"} ${writes === 1 ? "writes" : "write"}.`;
}

/**
 * The one confirmation before a run that writes on a Production Connection. The SQL shown is
 * exactly what will run. Focus starts on the SQL, so Enter does nothing until Run has focus.
 */
export default function ConfirmRun({
  verdict,
  noWhere = null,
  onRun,
  onCancel,
  onAddWhere,
  verb = "Run",
  dialect,
  group,
  rowEstimate,
  warnings = [],
}: Props) {
  const [runFocused, setRunFocused] = useState(false);
  const runLabel = `${verb} on ${verdict.connection}`;
  const does = DOES[verb];

  // One block for every statement, a blank line between them. Writes get the Production band, and
  // each statement's first line its tag.
  const marks: SqlMark[] = [];
  let next = 1;
  const sql = verdict.statements
    .map((s) => {
      const lines = s.text.split("\n").length;
      const write = s.class === "write";
      marks.push({ firstLine: next, lastLine: next + lines - 1, tag: write ? "writes" : "reads", ...(write && { band: "prod" as const }) });
      next += lines + 1;
      return s.text;
    })
    .join("\n\n");

  return (
    <Dialog
      className="dialog-confirm"
      size="wide"
      title={
        <span className="confirm-title">
          {verb} on <b>{verdict.connection}</b>
          {verdict.database !== null && ` · ${verdict.database}`}
        </span>
      }
      lead={dialect && <DbMark dialect={dialect} open />}
      badge={
        <span className="confirm-badges">
          <SafetyTag connection={{ production: true, readOnly: false }} />
          {group && (
            <span className="confirm-group">
              <GroupBadge id={group.id} name={group.name} color={group.color} />
              {group.name}
            </span>
          )}
        </span>
      }
      onClose={onCancel}
    >
      <div
        className="dialog-body confirm-stack"
        onKeyDown={(e) => {
          // Enter only ever acts on a focused button.
          if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
        }}
      >
        {noWhere && (
          <WarningBanner
            className="confirm-nowhere"
            action={
              onAddWhere && (
                <button type="button" className="button button-small" onClick={onAddWhere}>
                  Add WHERE
                </button>
              )
            }
          >
            <strong>Statement {noWhere.index + 1} has no WHERE.</strong> It changes every row in <code>{noWhere.table}</code>
            {typeof rowEstimate === "number" ? `, about ${rowEstimate.toLocaleString("en-US")} rows.` : "."}
          </WarningBanner>
        )}
        {warnings.map((w, i) => (
          <WarningBanner key={i}>{w}</WarningBanner>
        ))}
        <p className="confirm-count">
          {countText(verdict.writes, verdict.statements.length)}
          {verb === "Save" && " They run in one transaction."}
        </p>
        <div className="confirm-sql" tabIndex={0} data-autofocus aria-label="SQL to run, read-only">
          <SqlBlock sql={sql} dialect={dialect ?? "postgres"} marks={marks} />
        </div>
        <p className="confirm-hint">
          {runFocused ? `Enter ${does} now.` : `Enter ${does} only when ${runLabel} has focus. Press Tab to reach it, or click it.`}
        </p>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={noWhere || verb === "Drop" ? "button button-danger-fill" : "button button-primary"}
          onFocus={() => setRunFocused(true)}
          onBlur={() => setRunFocused(false)}
          onClick={onRun}
        >
          {runLabel}
        </button>
      </footer>
    </Dialog>
  );
}
