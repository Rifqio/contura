import { useMemo } from "react";
import Icon from "../components/Icon";
import type { SqlEditorApi } from "../query/SqlEditor";
import { lineDiff } from "./lineDiff";

/** The query tab an answer's SQL goes into: its editor (null once closed) and its name. */
export interface InsertTarget {
  editor(): SqlEditorApi | null;
  name: string;
}

/** Where an Insert puts the text: `from` to `to` of `doc` becomes `text`. */
export interface InsertPlan {
  /** The editor's text the plan was made from; Insert checks it is still the same. */
  doc: string;
  from: number;
  to: number;
  text: string;
  /** "Replaces lines 3 to 9 of Query 2", "Adds at line 4 of Query 2". */
  where: string;
}

const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length;
const n = (line: number) => line.toLocaleString("en-US");

/**
 * Plans putting `answer` (ended with a new line) into the editor: over the selection when there is one, else over
 * the current statement and its `;`, else after the last line.
 */
export function planInsert(editor: SqlEditorApi, name: string, answer: string): InsertPlan {
  const doc = editor.text();
  const target = editor.runTarget();
  if (target) {
    const from = target.from;
    const to = doc[target.to] === ";" ? target.to + 1 : target.to;
    const first = lineOf(doc, from);
    const last = lineOf(doc, Math.max(from, to - 1));
    const where = first === last ? `Replaces line ${n(first)} of ${name}` : `Replaces lines ${n(first)} to ${n(last)} of ${name}`;
    return { doc, from, to, text: answer.trimEnd(), where };
  }
  const gap = doc !== "" && !doc.endsWith("\n") ? "\n" : "";
  const line = doc === "" ? 1 : doc.split("\n").length + (gap ? 1 : 0);
  return { doc, from: doc.length, to: doc.length, text: gap + answer, where: `Adds at line ${n(line)} of ${name}` };
}

/** "2 lines changed, 1 added", "3 lines added", "1 line removed". */
export function changeText(removed: number, added: number): string {
  const changed = Math.min(removed, added);
  const parts: [number, string][] = [
    [changed, "changed"],
    [added - changed, "added"],
    [removed - changed, "removed"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, what], i) => (i === 0 ? `${n.toLocaleString("en-US")} ${n === 1 ? "line" : "lines"} ${what}` : `${n.toLocaleString("en-US")} ${what}`))
    .join(", ");
}

interface Props {
  plan: InsertPlan;
  /** The block's flag sentences, repeated here so they are read before the editor changes. */
  flags: string[];
  /** The editor changed after the diff was first made, and this is the new one. */
  remade: boolean;
  onInsert(): void;
  onCancel(): void;
}

const MARK = { same: " ", del: "-", add: "+" } as const;

/** The reviewable diff under an answer's SQL block: what Insert does to the editor before it does it. */
export default function InsertDiff({ plan, flags, remade, onInsert, onCancel }: Props) {
  const lines = useMemo(() => lineDiff(plan.doc.slice(plan.from, plan.to), plan.text.trim()), [plan]);
  const removed = lines.filter((l) => l.op === "del").length;
  const added = lines.filter((l) => l.op === "add").length;
  return (
    <section className="insert-diff" role="region" aria-label="Insert into the editor">
      <div className="insert-diff-head">
        <span className="t">Insert into the editor</span>
        <span className="sub">{plan.where}. Nothing runs: you press Run when ready.</span>
      </div>
      {remade && <p className="insert-diff-note">The editor changed, so the diff was made again. Check it, then Insert.</p>}
      <div className="insert-diff-lines">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.op}`}>
            <span className="diff-mark" aria-hidden="true">
              {MARK[l.op]}
            </span>
            <span className="diff-text">{l.text}</span>
          </div>
        ))}
      </div>
      {flags.length > 0 && (
        <ul className="insert-diff-flags">
          {flags.map((f) => (
            <li key={f}>
              <Icon name="warning" size={14} />
              {f}
            </li>
          ))}
        </ul>
      )}
      <div className="insert-diff-foot">
        <span className="count">{changeText(removed, added)}</span>
        <span className="spacer" />
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-small button-primary" onClick={onInsert}>
          Insert
        </button>
      </div>
    </section>
  );
}
