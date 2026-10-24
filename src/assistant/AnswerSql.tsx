import { useState } from "react";
import type { AnswerActionKind, DialectKind, Flag, SqlBlock as Checked, StatementCheck } from "../api/types";
import { answerText, commentedOut } from "../app/queryTabRefs";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import type { SqlEditorApi } from "../query/SqlEditor";
import { leadingWord } from "./answerMarkdown";
import { answerWrites } from "./answerState";
import InsertDiff, { type InsertPlan, type InsertTarget, planInsert } from "./InsertDiff";

interface Props {
  sql: string;
  dialect: DialectKind;
  /** The Core's check of this block (R5.2); null while the answer streams or for an answer saved before checks. */
  check?: Checked | null;
  /** The answer is still being written: no label and no actions yet. */
  streaming?: boolean;
  /**
   * The answer ended without the Core's check of this block (a reloaded answer saved before records, a stopped or
   * failed answer): Insert goes in only commented out, and an unclosed block gets Copy only.
   */
  unchecked?: boolean;
  /** The block's fence was closed; an unclosed one may hold half a statement. */
  closed?: boolean;
  /** The query tab Insert works on; Insert is disabled without one. */
  target?: InsertTarget | null;
  /**
   * The tab has no editor (spec 8): the primary action is Open in new query tab and there is no Insert; SQL that
   * writes, or that the Core did not check, opens commented out. Nothing runs either way.
   */
  noEditor?: boolean;
  onOpenInNewTab?(sql: string): void;
  onCopy(sql: string): void;
  /** Told once an Insert went in or the SQL opened in a new tab, so the answer's record keeps it. */
  onAction?(kind: AnswerActionKind): void;
}

/** A flag in the words of the Core's label (R5.3). */
export function flagSentence(f: Flag): string {
  switch (f.kind) {
    case "noWhere":
      return `${f.verb} without WHERE.`;
    case "riskyFunction":
      return f.name.startsWith("INTO ") ? `Writes a file on the server (${f.name}).` : `Calls ${f.name}().`;
    case "unknownFunction":
      return `Calls ${f.name}(): functions are not checked.`;
    case "writeInReadAnswer":
      return "This answer contains a write.";
    case "readOnlyConnection":
      return "Read-only Connection: this will not run.";
  }
}

/** The verb a write starts with, lower-cased; the one after a WITH for a data-modifying CTE. */
function verbOf(text: string): string {
  const first = leadingWord(text);
  if (first !== "WITH") return first.toLowerCase() || "write";
  return (/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.exec(text)?.[1] ?? "write").toLowerCase();
}

/** "1 delete", "2 updates, 1 delete": the writes of a block by verb, in order of first use. */
export function writesText(statements: StatementCheck[]): string {
  const counts = new Map<string, number>();
  for (const s of statements) {
    if (s.class !== "write") continue;
    const verb = verbOf(s.text);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return [...counts].map(([verb, n]) => `${n.toLocaleString("en-US")} ${n === 1 ? verb : `${verb}s`}`).join(", ");
}

/**
 * A fenced SQL block of an answer (board 11.1): a head with the Core's label and Copy, the code in the editor's
 * colours, and a foot with Insert into the editor and Open in new tab. Insert first shows the diff; nothing runs.
 */
export default function AnswerSql({
  sql,
  dialect,
  check = null,
  streaming = false,
  unchecked: uncheckedBlock = false,
  closed = true,
  target = null,
  noEditor = false,
  onOpenInNewTab,
  onCopy,
  onAction,
}: Props) {
  /** The diff, with the editor it was made on, so Insert never writes into another tab. */
  const [diff, setDiff] = useState<{ plan: InsertPlan; remade: boolean; editor: SqlEditorApi; commented: boolean } | null>(null);
  const [inserted, setInserted] = useState(false);
  // The answer parser turns every CR into a line end, as the Core's check does; a block that still holds one was not
  // checked as the editor will hold it, so it is taken as unchecked: it goes in or opens only commented out.
  const unchecked = uncheckedBlock || /\r/.test(sql);
  const statements = check?.statements ?? [];
  const warn = statements.some((s) => s.class === "write" || s.flags.length > 0);
  const flags = [...new Set(statements.flatMap((s) => s.flags.map(flagSentence)))];
  // An answer whose SQL writes goes in only commented out, whatever was asked (board 11.6, "Answer writes"; P11-30):
  // Run finds nothing in it until the user takes the comment marks off.
  const writes = statements.some((s) => s.class === "write" || s.flags.some((f) => f.kind === "writeInReadAnswer"));

  const open = (text: string, commentedText: boolean) => {
    const editor = target?.editor();
    if (!editor || !target) return;
    setInserted(false);
    setDiff({ plan: planInsert(editor, target.name, text), remade: false, editor, commented: commentedText });
  };
  const commented = writes || unchecked;
  const insertText = () => (commented ? commentedOut(answerText(sql)) : answerText(sql));

  /** Opens the SQL in a new query tab; `commentedText` puts every line behind `-- ` first. */
  const openNew = (commentedText: boolean) => {
    if (!onOpenInNewTab) return;
    onOpenInNewTab(commentedText ? commentedOut(answerText(sql)) : sql);
    onAction?.("openedInNewTab");
  };

  const apply = () => {
    const editor = target?.editor();
    if (!diff || !editor || !target) return;
    if (editor !== diff.editor || editor.text() !== diff.plan.doc) {
      // Another tab, or the editor changed under the diff: show the new one rather than write over what was typed.
      setDiff({ plan: planInsert(editor, target.name, insertText()), remade: true, editor, commented });
      return;
    }
    editor.replaceRange(diff.plan.from, diff.plan.to, diff.plan.text);
    setDiff(null);
    setInserted(true);
    onAction?.(diff.commented ? "insertedCommented" : "inserted");
  };

  return (
    <>
      <div className="answer-sql" role="group" aria-label="SQL answer">
        <div className={warn ? "answer-sql-head warn" : "answer-sql-head"}>
          {check && !streaming && (
            <>
              <Icon name={warn ? "warning" : "check"} size={14} />
              <span className="answer-sql-label">{check.label}</span>
            </>
          )}
          <span className="spacer" />
          <button type="button" className="icon-button" aria-label="Copy the SQL" title="Copy" onClick={() => onCopy(sql)}>
            <Icon name="copy" size={14} />
          </button>
        </div>
        <SqlBlock sql={sql} dialect={dialect} lineNumbers={false} />
        {!streaming && noEditor && unchecked && (
          <div className="answer-sql-actions">
            {closed && (
              <button type="button" className="button button-small" disabled={!onOpenInNewTab} onClick={() => openNew(true)}>
                Open in new query tab, commented out
              </button>
            )}
            <button type="button" className="button button-small button-ghost" onClick={() => onCopy(sql)}>
              Copy
            </button>
          </div>
        )}
        {!streaming && noEditor && !unchecked && !writes && (
          <div className="answer-sql-actions">
            <button type="button" className="button button-small" disabled={!onOpenInNewTab} onClick={() => openNew(false)}>
              Open in new query tab
            </button>
          </div>
        )}
        {!streaming && !noEditor && unchecked && (
          <div className="answer-sql-actions">
            {closed && (
              <button
                type="button"
                className="button button-small"
                disabled={!target}
                onClick={() => open(commentedOut(answerText(sql)), true)}
              >
                Insert commented out
              </button>
            )}
            <button type="button" className="button button-small button-ghost" onClick={() => onCopy(sql)}>
              Copy
            </button>
          </div>
        )}
        {!streaming && !noEditor && !unchecked && !writes && (
          <div className="answer-sql-actions">
            <button
              type="button"
              className="button button-small"
              disabled={!target}
              onClick={() => open(answerText(sql), false)}
            >
              Insert into the editor
            </button>
            <button
              type="button"
              className="button button-small button-ghost"
              disabled={!onOpenInNewTab}
              onClick={() => {
                if (!onOpenInNewTab) return;
                onOpenInNewTab(sql);
                onAction?.("openedInNewTab");
              }}
            >
              Open in new tab
            </button>
          </div>
        )}
      </div>
      {!streaming &&
        writes &&
        !unchecked &&
        answerWrites(writesText(statements), {
          onInsert: target ? () => open(commentedOut(answerText(sql)), true) : undefined,
          onCopy: () => onCopy(sql),
          noEditor,
          onOpen: onOpenInNewTab ? () => openNew(true) : undefined,
        })}
      {diff && (
        <InsertDiff plan={diff.plan} flags={flags} remade={diff.remade} onInsert={apply} onCancel={() => setDiff(null)} />
      )}
      {inserted && (
        <p className="answer-sql-done">
          <Icon name="check" size={14} />
          Inserted into the editor
        </p>
      )}
    </>
  );
}
