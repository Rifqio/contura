// Step 12, item 19 (frame Diagram, the Shape picker): every shape, line and group the open diagram's kind can
// draw, with the .flow line it writes. A shape with a canvas tool adds the node where you are looking; any other
// writes its line at the end of the text, selected, ready to fill in.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { useDismiss } from "../components/useDismiss";
import type { DiagramKind } from "../lang/flow/model";
import { ADD_TOOLS, type AddTool } from "./FlowToolbar";

export interface Shape {
  label: string;
  icon: IconName;
  /** The .flow line it writes, as shown. */
  code: string;
  /** Added from the canvas (the toolbar's own tool, with its key). */
  tool?: AddTool;
  /** Else this line is written at the end of the text. */
  template?: string;
}

const tool = (kind: DiagramKind, label: string) => ADD_TOOLS[kind].find((t) => t.label === label);

/** The open kind's shapes, then its lines, then its groups and notes (frame DiagramElements). */
export function shapesOf(kind: DiagramKind): Shape[] {
  const t = (label: string, icon: IconName, code: string, toolLabel: string): Shape => ({ label, icon, code, tool: tool(kind, toolLabel) });
  const w = (label: string, icon: IconName, code: string): Shape => ({ label, icon, code, template: code });
  const note = w("Note", "msg", "note: text");
  switch (kind) {
    case "dfd":
      return [
        t("Process", "gear", "Name [process, id: 4.0]", "Add process"),
        t("Data store", "database", "name [store, id: D3]", "Add data store"),
        t("Outside party", "user", "Name [entity, id: E3]", "Add outside party"),
        w("Area", "square", "Name {\n}"),
        w("Flow", "arrowRight", "A > B: label"),
        w("Two-way flow", "swap", "A <> B: label"),
        w("Dashed flow", "arrowRight", "A --> B: label"),
      ];
    case "flow":
      return [
        t("Start or end", "pill", "Name [start]", "Add start or end"),
        t("Step", "square", "Name [step]", "Add step"),
        t("Decision", "diamond", "Name [decision]", "Add decision"),
        t("Input or output", "io", "Name [io]", "Add input or output"),
        w("Subprocess", "square", "Name [subprocess]"),
        w("Document", "fileQuery", "Name [document]"),
        w("Database", "database", "Name [database]"),
        note,
        w("Line", "arrowRight", "A > B: label"),
      ];
    case "cloud":
      return [t("Service", "boxPlus", "Name [icon: aws-lambda]", "Add a service"), w("Group", "square", "Name [icon: aws-vpc] {\n}"), w("Line", "arrowRight", "A > B: label"), w("Dotted line", "arrowRight", "A ..> B: label")];
    case "er":
      return [
        t("Entity", "table", "name [entity]", "Add entity"),
        t("Weak entity", "layers", "name [weak]", "Add weak entity"),
        w("Attribute", "columns", "table.column type"),
        w("Relationship", "diamond", "A -- B: has"),
        w("One to many", "arrowRight", "A 1--* B"),
        w("Many to many", "swap", "A *--* B"),
      ];
    case "sequence":
      return [
        t("Participant", "square", "participant Name", "Add participant"),
        t("Actor", "user", "actor Name", "Add actor"),
        w("Message", "arrowRight", "A -> B: message"),
        w("Reply", "arrowLeft", "B --> A: reply"),
        w("Activation", "minus", "activate Name"),
        w("Loop", "refresh", "loop label {\n}"),
        note,
      ];
    case "state":
      return [
        t("State", "pill", "Name [state]", "Add state"),
        w("Start", "play", "[*] > Name"),
        w("End", "stop", "Name > [*]"),
        t("Choice", "diamond", "Name [choice]", "Add choice"),
        t("Fork or join", "minus", "Name [fork]", "Add fork"),
        w("Composite", "square", "Name {\n}"),
        w("Transition", "arrowRight", "A > B: event"),
        note,
      ];
    case "class":
      return [
        t("Class", "cube", "class Name", "Add class"),
        t("Interface", "cards", "interface Name", "Add interface"),
        t("Enum", "list", "enum Name", "Add enum"),
        w("Member", "columns", "Name : + field: type"),
        w("Inheritance", "arrowUp", "A <|-- B"),
        w("Composition", "diamond", "A *-- B"),
        w("Dependency", "arrowRight", "A ..> B"),
        note,
      ];
    case "mindmap":
      return [w("Central idea", "pill", "root Name"), t("Topic", "pill", "  Topic", "Add topic"), w("Subtopic", "minus", "    Subtopic"), w("Branch", "arrowRight", "A > B"), note];
    case "timeline":
      return [
        t("Event", "pill", "2026-10-19: Name", "Add event"),
        t("Period", "minus", "2026-09 to 2026-10: Name", "Add period"),
        t("Milestone", "diamond", "milestone Name", "Add milestone"),
        w("Section", "layers", "section Name"),
      ];
  }
}

interface Props {
  kind: DiagramKind;
  onPick(shape: Shape): void;
}

/** The toolbar's Shapes button and its list. */
export default function ShapePicker({ kind, onPick }: Props) {
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
          {shapes.map((s) => (
            <button
              key={s.label}
              type="button"
              role="menuitem"
              className="flow-shape"
              aria-label={s.label}
              aria-description={`Writes ${s.code.replace("\n", " ")}`}
              onClick={() => {
                setOpen(false);
                onPick(s);
              }}
            >
              <Icon name={s.icon} size={16} />
              <span className="flow-shape-text">
                <span className="flow-shape-label">{s.label}</span>
                <code className="flow-shape-code">{s.code.split("\n")[0]}</code>
              </span>
              {s.tool && <Kbd keys={s.tool.key} />}
            </button>
          ))}
          <p className="flow-shape-foot">A shape with a key is added where you are looking; the others are written at the end of the text.</p>
        </div>
      )}
    </span>
  );
}
