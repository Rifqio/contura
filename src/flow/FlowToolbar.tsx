// The floating tool bar centred over the canvas (frames 6+.2, 6+.4, 6+.5): the pointer, the add tools for the
// diagram's kind, the Modern and Classic switch on a data flow, and Tidy. Each tool names itself and its key in a
// notched hint on hover.
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { type DiagramKind, FIXED_KINDS, type FlowNodeKind } from "../lang/flow/model";
import ShapePicker, { type Shape } from "./ShapePicker";
import type { NodeLook } from "./nodes/parts";

/** One add tool: what it adds, its hint and its key. `kind: "terminal"` adds a start, or an end once there is one. */
export interface AddTool {
  label: string;
  key: string;
  icon: IconName;
  kind: FlowNodeKind | "terminal" | "group";
  /** The new node's name, made unique (`Process 2`). */
  base: string;
}

export const ADD_TOOLS: Record<DiagramKind, AddTool[]> = {
  dfd: [
    { label: "Add process", key: "P", icon: "gear", kind: "process", base: "Process" },
    { label: "Add data store", key: "S", icon: "database", kind: "store", base: "Data store" },
    { label: "Add outside party", key: "E", icon: "user", kind: "entity", base: "Outside party" },
  ],
  flow: [
    { label: "Add step", key: "S", icon: "square", kind: "step", base: "Step" },
    { label: "Add decision", key: "D", icon: "diamond", kind: "decision", base: "Decision" },
    { label: "Add input or output", key: "I", icon: "io", kind: "io", base: "Input" },
    { label: "Add start or end", key: "T", icon: "pill", kind: "terminal", base: "Start" },
  ],
  cloud: [
    { label: "Add a service", key: "N", icon: "boxPlus", kind: "service", base: "Service" },
    { label: "Group", key: "G", icon: "square", kind: "group", base: "Group" },
  ],
  // Step 12, item 19: the newer kinds' main shapes; the Shape picker lists them all.
  er: [
    { label: "Add entity", key: "E", icon: "table", kind: "entity", base: "table" },
    { label: "Add weak entity", key: "W", icon: "layers", kind: "weak", base: "detail" },
  ],
  sequence: [
    { label: "Add participant", key: "P", icon: "square", kind: "participant", base: "Participant" },
    { label: "Add actor", key: "A", icon: "user", kind: "actor", base: "Actor" },
  ],
  state: [
    { label: "Add state", key: "S", icon: "pill", kind: "state", base: "State" },
    { label: "Add choice", key: "C", icon: "diamond", kind: "choice", base: "Choice" },
    { label: "Add fork", key: "F", icon: "minus", kind: "fork", base: "Fork" },
  ],
  class: [
    { label: "Add class", key: "C", icon: "cube", kind: "class", base: "Class" },
    { label: "Add interface", key: "I", icon: "cards", kind: "interface", base: "Interface" },
    { label: "Add enum", key: "E", icon: "list", kind: "enum", base: "Enum" },
  ],
  mindmap: [{ label: "Add topic", key: "T", icon: "pill", kind: "topic", base: "Topic" }],
  timeline: [
    { label: "Add event", key: "E", icon: "pill", kind: "event", base: "Event" },
    { label: "Add milestone", key: "M", icon: "diamond", kind: "milestone", base: "Milestone" },
    { label: "Add period", key: "P", icon: "minus", kind: "period", base: "Period" },
  ],
};

/** "Press P, S or E, or click here" for the empty flow's card. */
export function firstNodeHint(kind: DiagramKind): string {
  const keys = ADD_TOOLS[kind].filter((t) => t.kind !== "group").map((t) => t.key);
  const list = keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}`;
  return `Press ${list}, or click here`;
}

function Tool({
  label,
  hint = label,
  icon,
  shortcut,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: IconName;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick?(): void;
}) {
  return (
    <button
      type="button"
      className="flow-tool"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="flow-hint" aria-hidden="true">
        {hint}
        {shortcut && <Kbd keys={shortcut} />}
      </span>
    </button>
  );
}

interface Props {
  kind: DiagramKind;
  look: NodeLook;
  onAdd(tool: AddTool): void;
  onLook(look: NodeLook): void;
  onTidy(): void;
  /** Two or more nodes are selected: Tidy lays out only them. */
  tidySelection?: boolean;
  /** A shape picked in the Shapes list (step 12): its tool, or its line written into the text. */
  onShape?(shape: Shape): void;
}

export default function FlowToolbar({ kind, look, onAdd, onLook, onTidy, tidySelection, onShape }: Props) {
  return (
    <div className="flow-toolbar nodrag nopan" role="toolbar" aria-label="Diagram tools">
      <Tool label="Select" icon="select" pressed />
      <span className="flow-toolbar-divider" aria-hidden="true" />
      {ADD_TOOLS[kind].map((t) => (
        // Group puts the selected services in a new group.
        <Tool key={t.label} label={t.label} icon={t.icon} shortcut={t.key} onClick={() => onAdd(t)} />
      ))}
      {onShape && <ShapePicker kind={kind} onPick={onShape} />}
      <span className="flow-toolbar-divider" aria-hidden="true" />
      {kind === "dfd" && (
        <span className="flow-twin" role="group" aria-label="Node look">
          <Tool label="Modern" icon="cards" pressed={look === "modern"} onClick={() => onLook("modern")} />
          <Tool label="Textbook shapes (Gane-Sarson)" icon="classic" pressed={look === "classic"} onClick={() => onLook("classic")} />
        </span>
      )}
      {!FIXED_KINDS.has(kind) && <Tool label="Tidy" hint={tidySelection ? "Tidy selection" : "Tidy"} icon="tidy" onClick={onTidy} />}
    </div>
  );
}
