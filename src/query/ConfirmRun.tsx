import { type ReactNode, useState } from "react";
import type { ConfirmItem, DialectKind, Group, InsertShape, RunVerdict } from "../api/types";
import DbMark from "../components/DbMark";
import Icon from "../components/Icon";
import Dialog from "../components/Dialog";
import GroupBadge from "../components/GroupBadge";
import SafetyTag from "../components/SafetyTag";
import SqlBlock, { type SqlMark } from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

/** One item of a job confirmation: a statement shown exactly, or an INSERT shown as its shape. */
export type ConfirmShape = ConfirmItem;

/** The job mode (Q14): a bulk import or SQL file described once, instead of every statement. */
export interface ConfirmJob {
  /** The first line, such as "Inserts 1,204 rows into billing.products in 3 statements, in one transaction." */
  title: string;
  /** Every item in file order: shapes and exact statements interleaved. */
  shapes: ConfirmShape[];
  /** The count line under the title, such as "4 statements write."; none when the body says it. */
  counts?: string;
  /** "212 KB, SHA-256 4be0 91c2 ... 7d1f": the fingerprint banner names it. */
  fingerprint?: string | null;
  /** The banner's whole sentence instead, such as a Restore's "Checked file: ..." (step 9). */
  fingerprintText?: string;
  /** A body of its own in place of the items (a Restore's structure, shape and cleanup sections). */
  body?: ReactNode;
  /** Show all under a shape's first rows. */
  onShowAll?(): void;
}

/** The editor's mode needs every statement; the job mode only the Connection and database. */
type Mode = { verdict: Ask; job?: undefined } | { verdict: Pick<Ask, "connection" | "database">; job: ConfirmJob };

type Props = Mode & {
  /** An UPDATE or DELETE without WHERE among the statements, by index; its warning sits at the top. */
  noWhere?: { index: number; verb: "UPDATE" | "DELETE"; table: string } | null;
  onRun(): void;
  onCancel(): void;
  /** Offered beside the no-WHERE warning when given. */
  onAddWhere?(): void;
  /** "Save" for Pending Edits, "Apply" for a design, "Drop" for a table drop: the title and button say it. */
  verb?: "Run" | "Save" | "Apply" | "Drop" | "Import" | "Transfer" | "Restore";
  /** The run deletes rows (a transfer's Empty it first): the button takes the danger fill. */
  danger?: boolean;
  /** Plan warnings, one banner each, above the count line. */
  warnings?: string[];
  /** A banner with its own action above the warnings, such as Restore's Replace danger banner. */
  banner?: ReactNode;
  /**
   * False on a plain Connection whose run still shows its SQL first (Restore always does): no
   * PROD chip, and the button is the verb alone.
   */
  production?: boolean;
  /** The Connection's database, for the mark before the title. */
  dialect?: DialectKind;
  /** The Connection's Group, for the square after the PROD chip; none for Ungrouped. */
  group?: Group | null;
  /** Rows the statement without WHERE would change, when known; the warning says "about N rows". */
  rowEstimate?: number | null;
};

const DOES: Record<NonNullable<Props["verb"]>, string> = {
  Run: "runs",
  Save: "saves",
  Apply: "applies",
  Drop: "drops",
  Import: "runs",
  Transfer: "runs",
  Restore: "runs",
};

/** Under a shape's first rows: "496 more rows in this statement, then 2 more statements"; null when nothing is left out. */
export function foldText(shape: InsertShape): string | null {
  const n = (v: number) => v.toLocaleString("en-US");
  const inFirst = Math.min(shape.rowsPerStatement, shape.rows);
  const rows = Math.max(0, inFirst - shape.firstRows.length);
  const statements = Math.max(0, shape.statements - 1);
  const parts = [
    ...(rows > 0 ? [`${n(rows)} ${rows === 1 ? "more row" : "more rows"} in this statement`] : []),
    ...(statements > 0 ? [`${n(statements)} ${statements === 1 ? "more statement" : "more statements"}`] : []),
  ];
  if (parts.length === 0) return null;
  return parts.length === 2 ? `${parts[0]}, then ${parts[1]}` : parts[0];
}

function shapeHead(rowsPerStatement: number, statements: number, rows: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (statements <= 1) return `1 statement, ${n(rows)} ${rows === 1 ? "row" : "rows"}`;
  return `Statement 1 of ${n(statements)}, ${n(rowsPerStatement)} ${rowsPerStatement === 1 ? "row" : "rows"} each`;
}

/** The job body: each item exactly, or as its shape box with the fold line. */
function JobItems({ job, dialect }: { job: ConfirmJob; dialect: DialectKind }) {
  return (
    <>
      {job.shapes.map((item, i) => {
        if (item.kind === "exact") {
          const lines = item.text.split("\n").length;
          return (
            <div key={i} className="confirm-item confirm-exact">
              <SqlBlock sql={item.text} dialect={dialect} marks={[{ firstLine: 1, lastLine: lines, tag: "writes", band: "prod" }]} />
            </div>
          );
        }
        const { shape } = item;
        const sql = [shape.head, ...shape.firstRows.map((r, j) => `  ${r}${j < shape.firstRows.length - 1 ? "," : ""}`)].join("\n");
        const fold = foldText(shape);
        return (
          <div key={i} className="confirm-item confirm-shape">
            <p className="confirm-shape-head">{shapeHead(shape.rowsPerStatement, shape.statements, shape.rows)}</p>
            <SqlBlock sql={sql} dialect={dialect} marks={[{ firstLine: 1, lastLine: shape.firstRows.length + 1, tag: "writes", band: "prod" }]} />
            {fold && (
              <p className="confirm-fold">
                <span>{fold}</span>
                {job.onShowAll && (
                  <button type="button" className="button button-small button-ghost" onClick={job.onShowAll}>
                    Show all
                  </button>
                )}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

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
  job,
  noWhere = null,
  onRun,
  onCancel,
  onAddWhere,
  verb = "Run",
  dialect,
  group,
  rowEstimate,
  warnings = [],
  danger = false,
  banner,
  production = true,
}: Props) {
  const [runFocused, setRunFocused] = useState(false);
  // A transfer's title says where the rows go; its button runs the shown SQL there.
  const runLabel = production ? `${verb === "Transfer" ? "Run" : verb} on ${verdict.connection}` : verb;
  const does = DOES[verb];

  // One block for every statement, a blank line between them. Writes get the Production band, and
  // each statement's first line its tag.
  const marks: SqlMark[] = [];
  let next = 1;
  const statements = "statements" in verdict ? verdict.statements : [];
  const writes = "writes" in verdict ? verdict.writes : 0;
  const sql = statements
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
          {verb} {verb === "Transfer" ? "to" : "on"} <b>{verdict.connection}</b>
          {verdict.database !== null && ` · ${verdict.database}`}
        </span>
      }
      lead={dialect && <DbMark dialect={dialect} open />}
      badge={
        <span className="confirm-badges">
          <SafetyTag connection={{ production, readOnly: false }} />
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
        {banner}
        {warnings.map((w, i) => (
          <WarningBanner key={i}>{w}</WarningBanner>
        ))}
        {job ? (
          <>
            <p className="confirm-job-title">{job.title}</p>
            {job.counts && <p className="confirm-count">{job.counts}</p>}
            <div className="confirm-sql confirm-job" tabIndex={0} data-autofocus aria-label="SQL to run, read-only">
              {job.body ?? <JobItems job={job} dialect={dialect ?? "postgres"} />}
            </div>
            {(job.fingerprintText || job.fingerprint) && (
              <p className="confirm-fingerprint">
                <Icon name="info" />
                <span>
                  {job.fingerprintText ??
                    `The file is fingerprinted (${job.fingerprint}). If it changes before the run, Contura asks again.`}
                </span>
              </p>
            )}
          </>
        ) : (
          <>
            <p className="confirm-count">
              {countText(writes, statements.length)}
              {verb === "Save" && " They run in one transaction."}
            </p>
            <div className="confirm-sql" tabIndex={0} data-autofocus aria-label="SQL to run, read-only">
              <SqlBlock sql={sql} dialect={dialect ?? "postgres"} marks={marks} />
            </div>
          </>
        )}
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
          className={noWhere || verb === "Drop" || danger ? "button button-danger-fill" : "button button-primary"}
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
