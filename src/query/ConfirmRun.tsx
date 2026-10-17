import { useState } from "react";
import type { RunVerdict } from "../api/types";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import SafetyTag from "../components/SafetyTag";

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

interface Props {
  verdict: Ask;
  /** An UPDATE or DELETE without WHERE among the statements, by index; its warning sits at the top. */
  noWhere: { index: number; verb: "UPDATE" | "DELETE"; table: string } | null;
  onRun(): void;
  onCancel(): void;
  onAddWhere(): void;
  /** "Save" for Pending Edits: the title and button say Save instead of Run. */
  verb?: "Run" | "Save";
}

/** "2 of 3 statements write.", "1 of 2 statements writes.", "1 of 1 statement writes." */
function countText(writes: number, total: number): string {
  return `${writes} of ${total} ${total === 1 ? "statement" : "statements"} ${writes === 1 ? "writes" : "write"}.`;
}

/**
 * The one confirmation before a run that writes on a Production Connection. The SQL shown is
 * exactly what will run. Focus starts on the SQL, so Enter does nothing until Run has focus.
 */
export default function ConfirmRun({ verdict, noWhere, onRun, onCancel, onAddWhere, verb = "Run" }: Props) {
  const [runFocused, setRunFocused] = useState(false);
  const runLabel = `${verb} on ${verdict.connection}`;
  const does = verb === "Save" ? "saves" : "runs";
  let line = 0;

  return (
    <Dialog
      className="dialog-confirm"
      title={
        <span className="confirm-title">
          {verb} on <b>{verdict.connection}</b>
          {verdict.database !== null && ` · ${verdict.database}`}
        </span>
      }
      badge={<SafetyTag connection={{ production: true, readOnly: false }} />}
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
          <div className="confirm-nowhere" role="alert">
            <Icon name="warning" />
            <p>
              <strong>
                {noWhere.verb} without WHERE changes every row in <code>{noWhere.table}</code>.
              </strong>{" "}
              Check it before you run it on Production.
            </p>
            <button type="button" className="button button-small" onClick={onAddWhere}>
              Add WHERE
            </button>
          </div>
        )}
        <p className="confirm-count">
          <strong>{countText(verdict.writes, verdict.statements.length)}</strong>
        </p>
        <div className="confirm-sql" tabIndex={0} data-autofocus aria-label="SQL to run, read-only">
          {verdict.statements.map((s, i) => (
            <div key={i} className={s.class === "write" ? "confirm-stmt confirm-stmt-write" : "confirm-stmt"}>
              {s.text.split("\n").map((t, j) => {
                line += 1;
                return (
                  <div key={j} className="confirm-line">
                    <span className="confirm-gutter" aria-hidden="true">
                      {line}
                    </span>
                    <span className="confirm-text">{t || " "}</span>
                    {j === 0 && noWhere?.index === i && <span className="confirm-tag-danger">no WHERE</span>}
                    {j === 0 && (
                      <span className={s.class === "write" ? "confirm-tag confirm-tag-write" : "confirm-tag"}>
                        {s.class === "write" ? "writes" : "reads"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <footer className="dialog-footer">
        <span className="confirm-hint">
          {runFocused ? (
            <>
              <span className="kbd">Enter</span> {does} now.
            </>
          ) : (
            <>
              <span className="kbd">Enter</span> {does} only when <b>{runLabel}</b> has focus. Press{" "}
              <span className="kbd">Tab</span> to reach it, or click it.
            </>
          )}
        </span>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={noWhere ? "button button-danger-fill" : "button button-primary"}
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
