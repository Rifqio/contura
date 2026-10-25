import { useEffect, useRef, useState } from "react";
import type { AnswerActionKind, DialectKind, Flag, SqlBlock as Checked, StatementCheck } from "../api/types";
import { answerText, commentedOut } from "../app/queryTabRefs";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import type { LineMark, SqlEditorApi, SuggestionEnd } from "../query/SqlEditor";
import { leadingWord } from "./answerMarkdown";
import { answerWrites } from "./answerState";
import { type InsertPlan, type InsertTarget, plansFor } from "./insertPlan";

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
  /** The inline box shows this block's SQL in the editor itself and offers its own actions: the block shows none. */
  bare?: boolean;
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

/** "Adds lines 5 to 6 ..." as said after "Insert": the first letter lower-cased. */
const lower = (where: string) => where.charAt(0).toLowerCase() + where.slice(1);

/**
 * A fenced SQL block of an answer (board 11.1): a head with the Core's label and Copy, the code in the editor's
 * colours, and a foot with Insert, Apply to statement and Open in new tab (A3). Insert and Apply show the
 * SQL as a diff in the editor first, where Ctrl+Enter keeps it and Esc discards it; nothing runs.
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
  bare = false,
}: Props) {
  /** The suggestion this block put in the editor: waiting there, or kept. */
  const [state, setState] = useState<"waiting" | "kept" | null>(null);
  // Hovered or focused, an action marks its lines; the editor that holds the marks is cleared on leave and unmount.
  const marked = useRef<SqlEditorApi | null>(null);
  const [, redraw] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      marked.current?.markLines(null);
      marked.current = null;
    };
  }, []);
  // The answer parser turns every CR into a line end, as the Core's check does; a block that still holds one was not
  // checked as the editor will hold it, so it is taken as unchecked: it goes in or opens only commented out.
  const unchecked = uncheckedBlock || /\r/.test(sql);
  const statements = check?.statements ?? [];
  const warn = statements.some((s) => s.class === "write" || s.flags.length > 0);
  // An answer whose SQL writes goes in only commented out, whatever was asked (board 11.6, "Answer writes"; P11-30):
  // Run finds nothing in it until the user takes the comment marks off.
  const writes = statements.some((s) => s.class === "write" || s.flags.some((f) => f.kind === "writeInReadAnswer"));
  const commented = writes || unchecked;
  const text = commented ? commentedOut(answerText(sql)) : answerText(sql);

  const editor = !noEditor && !streaming && !bare ? (target?.editor() ?? null) : null;
  // Read from the editor on each draw, so the named lines follow where you are typing; a hover or focus draws them again.
  const plans = editor && target ? plansFor(editor, target.name, text) : null;

  const mark = (m: LineMark | null) => {
    const ed = target?.editor() ?? null;
    if (marked.current && marked.current !== ed) marked.current.markLines(null);
    marked.current = m ? ed : null;
    ed?.markLines(m);
  };
  const markOf = (which: "insert" | "apply") => () => {
    redraw((n) => n + 1);
    const ed = target?.editor();
    if (!ed || !target) return;
    const p = plansFor(ed, target.name, text)[which];
    mark(p ? p.mark : null);
  };
  const unmark = () => mark(null);

  const show = (which: "insert" | "apply") => {
    const ed = target?.editor();
    if (!ed || !target) return;
    const plan: InsertPlan | null = plansFor(ed, target.name, text)[which];
    if (!plan) return;
    mark(null);
    const kind: AnswerActionKind = commented ? "insertedCommented" : "inserted";
    setState("waiting");
    ed.suggest({
      from: plan.from,
      to: plan.to,
      text: plan.text,
      where: `${which === "insert" ? "Insert" : "Apply"} ${lower(plan.where)}`,
      keepLabel: commented ? "Keep, commented out" : "Keep",
      bar: true,
      focus: true,
      onEnd: (end: SuggestionEnd) => {
        if (!alive.current) return;
        if (end === "kept") {
          setState("kept");
          onAction?.(kind);
        } else setState(null);
      },
    });
  };

  /** Opens the SQL in a new query tab; `commentedText` puts every line behind `-- ` first. */
  const openNew = (commentedText: boolean) => {
    if (!onOpenInNewTab) return;
    onOpenInNewTab(commentedText ? commentedOut(answerText(sql)) : sql);
    onAction?.("openedInNewTab");
  };

  const applyLabel = plans?.apply?.over === "selection" || (editor && editor.selection().from !== editor.selection().to)
    ? "Apply to selection"
    : "Apply to statement";
  const applyOff = !plans?.apply;
  const where = plans && (
    <p className="answer-sql-where">
      <span>Insert {lower(plans.insert.where)}.</span>{" "}
      <span>{plans.apply ? `Apply ${lower(plans.apply.where)}.` : "Apply needs a selection, or a statement where you are typing."}</span>
    </p>
  );

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
        {!streaming && !bare && noEditor && unchecked && (
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
        {!streaming && !bare && noEditor && !unchecked && !writes && (
          <div className="answer-sql-actions">
            <button type="button" className="button button-small" disabled={!onOpenInNewTab} onClick={() => openNew(false)}>
              Open in new query tab
            </button>
          </div>
        )}
        {!streaming && !bare && !noEditor && unchecked && (
          <div className="answer-sql-actions">
            {closed && (
              <button
                type="button"
                className="button button-small"
                disabled={!target}
                onClick={() => show("insert")}
                onPointerEnter={markOf("insert")}
                onPointerLeave={unmark}
                onFocus={markOf("insert")}
                onBlur={unmark}
              >
                Insert commented out
              </button>
            )}
            <button type="button" className="button button-small button-ghost" onClick={() => onCopy(sql)}>
              Copy
            </button>
          </div>
        )}
        {!streaming && !bare && !noEditor && !unchecked && !writes && (
          <>
            <div className="answer-sql-actions">
              <button
                type="button"
                className="button button-small button-primary"
                disabled={!target}
                onClick={() => show("insert")}
                onPointerEnter={markOf("insert")}
                onPointerLeave={unmark}
                onFocus={markOf("insert")}
                onBlur={unmark}
              >
                Insert
              </button>
              <button
                type="button"
                className="button button-small"
                disabled={!target}
                aria-disabled={target && applyOff ? true : undefined}
                onClick={() => {
                  if (!applyOff) show("apply");
                }}
                onPointerEnter={markOf("apply")}
                onPointerLeave={unmark}
                onFocus={markOf("apply")}
                onBlur={unmark}
              >
                {applyLabel}
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
            {where}
          </>
        )}
      </div>
      {!streaming &&
        !bare &&
        writes &&
        !unchecked &&
        answerWrites(writesText(statements), {
          onInsert: target ? () => show("insert") : undefined,
          onCopy: () => onCopy(sql),
          noEditor,
          onOpen: onOpenInNewTab ? () => openNew(true) : undefined,
        })}
      {!noEditor && !bare && (
        <p className={state ? "answer-sql-done" : "answer-sql-done visually-hidden"} role="status">
          {state === "kept" && <Icon name="check" size={14} />}
          {state === "waiting" ? "In the editor: Ctrl+Enter keeps, Esc discards." : state === "kept" ? "Kept in the editor" : ""}
        </p>
      )}
    </>
  );
}
