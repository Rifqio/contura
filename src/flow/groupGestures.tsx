// Diagram step 9 (board DiagramGroups, F9): what a group holds, and the question Delete asks about it. Delete on a group
// asks whether to keep what it holds (Ungroup: Visio's Disband Container, Software Ideas Modeler's Delete Without Nested
// Elements) or remove it too (Delete with contents: Visio and Figma's Delete on a container); asking is Contura's own.
import { type KeyboardEvent, useEffect, useRef } from "react";
import Kbd from "../components/Kbd";
import { type FlowDoc, type FlowGroup, isStateMarker } from "../lang/flow/model";

/** What group `name` holds at any depth: its shapes, the groups inside it, and the lines that touch any of them. */
export function groupContents(doc: FlowDoc, name: string): { shapes: string[]; inner: string[]; lines: number } | null {
  let found: FlowGroup | null = null;
  const stack = [...doc.groups];
  while (stack.length && !found) {
    const g = stack.pop()!;
    if (g.name === name) found = g;
    else stack.push(...g.groups);
  }
  if (!found) return null;
  const shapes: string[] = [];
  const inner: string[] = [];
  const walk = [found];
  while (walk.length) {
    const g = walk.pop()!;
    if (g !== found) inner.push(g.name);
    // A composite's own start and end are not shapes it holds (fix round 2, N3).
    shapes.push(...(doc.kind === "state" ? g.nodes.filter((n) => !isStateMarker(n)) : g.nodes));
    walk.push(...g.groups);
  }
  const gone = new Set([...shapes, ...inner, name]);
  const lines = doc.links.filter((l) => !l.tree && (gone.has(l.from) || gone.has(l.to))).length;
  return { shapes, inner, lines };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The three answers' second lines, by what the group holds. */
export function askRows(c: { shapes: number; inner: number; lines: number }): { label: string; sub: string; key: string }[] {
  return [
    { label: "Ungroup", sub: `Keep the ${plural(c.shapes, "shape")}${c.inner ? ` and ${plural(c.inner, "group")} inside` : ""} where they are`, key: "Ctrl+Shift+G" },
    { label: "Delete with contents", sub: `Remove ${plural(c.shapes, "shape")} and ${plural(c.lines, "line")}`, key: "" },
    { label: "Cancel", sub: "Keep everything", key: "Esc" },
  ];
}

/** What the strip says once a group was deleted with what it held. */
export function deletedWords(name: string, c: { shapes: number; inner: number; lines: number }): string {
  const inner = c.inner ? `, ${plural(c.inner, "group")} inside` : "";
  return `Deleted ${name} with ${plural(c.shapes, "shape")}${inner} and ${plural(c.lines, "line")}. Ctrl+Z brings it all back in one step.`;
}

interface AskProps {
  /** "Delete group Warehouse?", "Delete area Billing?" */
  title: string;
  counts: { shapes: number; inner: number; lines: number };
  /** Where it opens on screen: under the group's title. */
  at: { left: number; top: number };
  /** 0 Ungroup, 1 Delete with contents, 2 Cancel. */
  onAnswer(i: 0 | 1 | 2): void;
}

/**
 * Delete's question under the group's title: Ungroup has focus first; the arrow keys and Tab move between the answers,
 * Enter or Space picks, Esc keeps everything, and a press outside it does too.
 */
export function GroupAsk({ title, counts, at, onAnswer }: AskProps) {
  const rows = askRows(counts);
  const box = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const answer = useRef(onAnswer);
  answer.current = onAnswer;
  useEffect(() => {
    buttons.current[0]?.focus();
    const away = (e: PointerEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) answer.current(2);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const onKey = (e: KeyboardEvent) => {
    // The canvas below never sees these keys: an arrow would move the group.
    e.stopPropagation();
    const at = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
    const go = (by: number) => {
      e.preventDefault();
      buttons.current[(Math.max(0, at) + by + 3) % 3]?.focus();
    };
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) go(1);
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) go(-1);
    else if (e.key === "Escape") {
      e.preventDefault();
      answer.current(2);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      answer.current(Math.max(0, at) as 0 | 1 | 2);
    } else if (e.key === "Delete" || e.key === "Backspace") e.preventDefault();
  };
  return (
    <div ref={box} className="flow-group-ask nodrag nopan" role="dialog" aria-label={title} style={{ left: at.left, top: at.top }} onKeyDown={onKey}>
      <span className="flow-group-ask-title" aria-hidden="true">
        {title}
      </span>
      {rows.map((r, i) => (
        <button
          key={r.label}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          className={`flow-group-ask-row${i === 1 ? " is-danger" : ""}`}
          onClick={() => answer.current(i as 0 | 1 | 2)}
        >
          <span className="flow-group-ask-text">
            <span className="flow-group-ask-label">{r.label}</span>
            <span className="flow-group-ask-sub">{r.sub}</span>
          </span>
          {r.key && <Kbd keys={r.key} />}
        </button>
      ))}
    </div>
  );
}
