// Each diagram kind's add tools (6+.5): what the add menus, the Shape picker and the board's kind
// tools add. The floating bar that drew them is gone: BoardToolbar draws the tools and the frame bar the
// settings.
import type { IconName } from "../components/Icon";
import type { DiagramKind, FlowNodeKind } from "../lang/flow/model";
// Never import board/kindTools here: it builds KIND_TOOLS at load from ADD_TOOLS below, across this cycle with ShapePicker.

/**
 * One add tool: what it adds and its hint. `kind: "terminal"` adds a start, or an end once there is one. Its key is
 * its kind tool's (`KIND_TOOLS` in board/kindTools.ts, the one source of keys).
 */
export interface AddTool {
  label: string;
  icon: IconName;
  kind: FlowNodeKind | "terminal" | "group";
  /** The new node's name, made unique (`Process 2`). */
  base: string;
}

export const ADD_TOOLS: Record<DiagramKind, AddTool[]> = {
  dfd: [
    { label: "Add process", icon: "gear", kind: "process", base: "Process" },
    { label: "Add data store", icon: "database", kind: "store", base: "Data store" },
    { label: "Add outside party", icon: "user", kind: "entity", base: "Outside party" },
  ],
  flow: [
    { label: "Add step", icon: "square", kind: "step", base: "Step" },
    { label: "Add decision", icon: "diamond", kind: "decision", base: "Decision" },
    { label: "Add input or output", icon: "io", kind: "io", base: "Input" },
    { label: "Add start or end", icon: "pill", kind: "terminal", base: "Start" },
  ],
  cloud: [
    { label: "Add a service", icon: "boxPlus", kind: "service", base: "Service" },
    { label: "Group", icon: "square", kind: "group", base: "Group" },
  ],
  // Step 12, item 19: the newer kinds' main shapes; the Shape picker lists them all.
  er: [
    // A table writes no kind.
    { label: "Add table", icon: "table", kind: "entity", base: "table" },
    { label: "Add weak table", icon: "layers", kind: "weak", base: "weak" },
  ],
  sequence: [
    { label: "Add participant", icon: "square", kind: "participant", base: "Participant" },
    { label: "Add actor", icon: "user", kind: "actor", base: "Actor" },
  ],
  state: [
    { label: "Add state", icon: "pill", kind: "state", base: "State" },
    { label: "Add choice", icon: "diamond", kind: "choice", base: "Choice" },
    { label: "Add fork", icon: "minus", kind: "fork", base: "Fork" },
  ],
  class: [
    { label: "Add class", icon: "cube", kind: "class", base: "Class" },
    { label: "Add interface", icon: "cards", kind: "interface", base: "Interface" },
    { label: "Add enum", icon: "list", kind: "enum", base: "Enum" },
  ],
  mindmap: [{ label: "Add topic", icon: "pill", kind: "topic", base: "Topic" }],
  timeline: [
    { label: "Add event", icon: "pill", kind: "event", base: "Event" },
    { label: "Add milestone", icon: "diamond", kind: "milestone", base: "Milestone" },
    { label: "Add period", icon: "minus", kind: "period", base: "Period" },
  ],
};
