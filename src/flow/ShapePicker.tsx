// Step 12, item 19 (frame Diagram, the Shape picker), and diagram step 6, FC1 and F18 (board DiagramAddNext): every
// shape, line and group the open diagram's kind can draw, with the .flow line it writes, and every item adds on the
// canvas. A shape appears in a free spot near the middle of the view with its name ready; a line is drawn from the
// next two shapes clicked (draw.io's connect mode); a group goes around the selection; a member, a subtopic or an
// activation goes on the one picked.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { useDismiss } from "../components/useDismiss";
import type { DiagramKind, FlowArrow, FlowNodeKind } from "../lang/flow/model";
import { ADD_TOOLS, type AddTool } from "./FlowToolbar";

/** What a Shapes item does on the canvas. */
export type ShapeAct =
  | { kind: "node"; node: FlowNodeKind; base: string }
  | { kind: "line"; arrow: FlowArrow }
  | { kind: "group" }
  | { kind: "marker"; end: "start" | "end" }
  | { kind: "member" }
  | { kind: "sub" }
  | { kind: "act" }
  | { kind: "loop" }
  | { kind: "section" };

export interface Shape {
  label: string;
  icon: IconName;
  /** The .flow line it writes, as shown. */
  code: string;
  act: ShapeAct;
  /** The toolbar's own tool, for its key. */
  tool?: AddTool;
  /** A key of its own where it has no tool (N for a note). */
  key?: string;
}

const tool = (kind: DiagramKind, label: string) => ADD_TOOLS[kind].find((t) => t.label === label);

/** The open kind's shapes, then its lines, then its groups and notes (frame DiagramElements, board DiagramAddNext). */
export function shapesOf(kind: DiagramKind): Shape[] {
  const t = (label: string, icon: IconName, code: string, toolLabel: string): Shape => {
    const at = tool(kind, toolLabel)!;
    return { label, icon, code, tool: at, act: { kind: "node", node: at.kind === "terminal" ? "start" : (at.kind as FlowNodeKind), base: at.base } };
  };
  const n = (label: string, icon: IconName, code: string, node: FlowNodeKind, base = label): Shape => ({ label, icon, code, act: { kind: "node", node, base } });
  const line = (label: string, icon: IconName, code: string, arrow: FlowArrow): Shape => ({ label, icon, code, act: { kind: "line", arrow } });
  const other = (label: string, icon: IconName, code: string, act: ShapeAct): Shape => ({ label, icon, code, act });
  const note: Shape = { label: "Note", icon: "msg", code: "note: text", act: { kind: "node", node: "note", base: "Note" }, key: "N" };
  switch (kind) {
    case "dfd":
      return [
        t("Process", "gear", "Name [process, id: 4.0]", "Add process"),
        t("Data store", "database", "name [store, id: D3]", "Add data store"),
        t("Outside party", "user", "Name [entity, id: E3]", "Add outside party"),
        other("Area", "square", "Name {", { kind: "group" }),
        line("Flow", "arrowRight", "A > B: label", ">"),
        line("Two-way flow", "swap", "A <> B: label", "<>"),
        line("Dashed flow", "arrowRight", "A --> B: label", "-->"),
      ];
    case "flow":
      return [
        t("Start or end", "pill", "Name [start]", "Add start or end"),
        t("Step", "square", "Name [step]", "Add step"),
        t("Decision", "diamond", "Name [decision]", "Add decision"),
        t("Input or output", "io", "Name [io]", "Add input or output"),
        n("Subprocess", "square", "Name [subprocess]", "subprocess"),
        n("Document", "fileQuery", "Name [document]", "document"),
        n("Database", "database", "Name [database]", "database"),
        note,
        line("Line", "arrowRight", "A > B: label", ">"),
        other("Group", "square", "Name {", { kind: "group" }),
      ];
    case "cloud":
      return [
        t("Service", "boxPlus", "Name [icon: aws-lambda]", "Add a service"),
        other("Group", "square", "Name [icon: aws-vpc] {", { kind: "group" }),
        line("Line", "arrowRight", "A > B: label", ">"),
        line("Dotted line", "arrowRight", "A ..> B: label", "..>"),
      ];
    case "er":
      return [
        // What each writes: a table and a weak table under their free names, a column at the end of the selected table.
        t("Table", "table", "table_1", "Add table"),
        t("Weak table", "layers", "weak_1 [weak]", "Add weak table"),
        other("Column", "columns", "column_1 text", { kind: "member" }),
        line("Many to one", "arrowRight", "A.b_id > B.id", ">"),
        line("One to many", "arrowLeft", "A.id < B.a_id", "<"),
        line("One to one", "minus", "A.id - B.a_id", "-"),
        line("Many to many", "swap", "A.id <> B.id", "<>"),
      ];
    case "sequence":
      return [
        t("Participant", "square", "participant Name", "Add participant"),
        t("Actor", "user", "actor Name", "Add actor"),
        line("Message", "arrowRight", "A -> B: message", "->"),
        line("Reply", "arrowLeft", "B --> A: reply", "-->"),
        other("Activation", "minus", "activate Name", { kind: "act" }),
        other("Loop", "refresh", "loop label {", { kind: "loop" }),
        note,
      ];
    case "state":
      return [
        t("State", "pill", "Name [state]", "Add state"),
        other("Start", "play", "[*] > Name", { kind: "marker", end: "start" }),
        other("End", "stop", "Name > [*]", { kind: "marker", end: "end" }),
        t("Choice", "diamond", "Name [choice]", "Add choice"),
        t("Fork or join", "minus", "Name [fork]", "Add fork"),
        other("Composite", "square", "Name {", { kind: "group" }),
        line("Transition", "arrowRight", "A > B: event", ">"),
        note,
      ];
    case "class":
      return [
        t("Class", "cube", "class Name", "Add class"),
        t("Interface", "cards", "interface Name", "Add interface"),
        t("Enum", "list", "enum Name", "Add enum"),
        other("Member", "columns", "Name : + field: type", { kind: "member" }),
        line("Inheritance", "arrowUp", "A <|-- B", "<|--"),
        line("Composition", "diamond", "A *-- B", "*--"),
        line("Dependency", "arrowRight", "A ..> B", "..>"),
        note,
      ];
    case "mindmap":
      return [
        n("Central idea", "pill", "root Name", "root"),
        t("Topic", "pill", "  Topic", "Add topic"),
        other("Subtopic", "minus", "    Subtopic", { kind: "sub" }),
        line("Branch", "arrowRight", "A > B", ">"),
        note,
      ];
    case "timeline":
      return [
        t("Event", "pill", "2026-10-19: Name", "Add event"),
        t("Period", "minus", "2026-09 to 2026-10: Name", "Add period"),
        t("Milestone", "diamond", "milestone Name", "Add milestone"),
        other("Section", "layers", "section Name", { kind: "section" }),
      ];
  }
}

interface Props {
  kind: DiagramKind;
  /** Why an item cannot be used now ("Select shapes first"), shown in place of its line; null when it can. */
  disabled?(shape: Shape): string | null;
  onPick(shape: Shape): void;
}

/** The toolbar's Shapes button and its list. */
export default function ShapePicker({ kind, disabled, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, [list, button], () => setOpen(false));
  const shapes = shapesOf(kind);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      rows[(i + rows.length) % rows.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
  };
  return (
    <span className="flow-shapes">
      <button
        ref={button}
        type="button"
        className={open ? "flow-tool flow-tool-shapes is-on" : "flow-tool flow-tool-shapes"}
        aria-label="Shapes"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="boxPlus" />
        <span className="flow-hint" aria-hidden="true">
          Every shape and line
        </span>
      </button>
      {open && (
        <div ref={list} className="flow-shape-list" role="menu" aria-label="Shapes" onKeyDown={onKey}>
          {shapes.map((s) => {
            const why = disabled?.(s) ?? null;
            const key = s.tool?.key ?? s.key;
            return (
              <button
                key={s.label}
                type="button"
                role="menuitem"
                className={why ? "flow-shape is-disabled" : "flow-shape"}
                aria-label={s.label}
                aria-disabled={why ? true : undefined}
                aria-description={why ?? `Writes ${s.code.replace("\n", " ")}`}
                onClick={() => {
                  setOpen(false);
                  onPick(s);
                }}
              >
                <Icon name={s.icon} size={16} />
                <span className="flow-shape-text">
                  <span className="flow-shape-label">{s.label}</span>
                  <code className="flow-shape-code">{why ?? s.code.split("\n")[0]}</code>
                </span>
                {key && <Kbd keys={key} />}
              </button>
            );
          })}
          <p className="flow-shape-foot">Every item adds on the canvas: shapes at the middle of the view with the name ready, lines from the next two shapes you click, groups around the selection.</p>
        </div>
      )}
    </span>
  );
}
