// Item 22: double-click a node to edit its name and details in a small panel beside it: the name (a note's
// text), its kind where the diagram has kinds to choose from, and its id and table where the kind takes them.
// Enter saves, Escape or a press outside leaves it as it was; the text changes as one undo entry.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Kbd from "../components/Kbd";
import Select from "../components/Select";
import { useDismiss } from "../components/useDismiss";
import { type DiagramKind, type FlowNode, type FlowNodeKind, KINDS } from "../lang/flow/model";

export interface NodeEdit {
  name: string;
  kind: FlowNodeKind;
  id: string;
  table: string;
}

/** The kinds that carry an `id` and a `table` in the text. */
const HAS_ID: ReadonlySet<FlowNodeKind> = new Set(["process", "store", "entity"]);
const HAS_TABLE: ReadonlySet<FlowNodeKind> = new Set(["store", "io"]);

/** The edits a save makes: the attributes on the old name first, then the rename (one batch, one undo entry). */
export function nodeEditOps(diagram: DiagramKind, node: FlowNode, next: NodeEdit) {
  const ops: (
    | { op: "setAttr"; name: string; key: "kind" | "id" | "table"; value: string | null }
    | { op: "renameNode"; old: string; next: string }
  )[] = [];
  if (next.kind !== node.kind && KINDS[diagram].includes(next.kind)) ops.push({ op: "setAttr", name: node.name, key: "kind", value: next.kind });
  const attr = (key: "id" | "table", value: string) => {
    const was = node.attrs[key] ?? "";
    if (value.trim() !== was) ops.push({ op: "setAttr", name: node.name, key, value: value.trim() === "" ? null : value.trim() });
  };
  if (diagram === "dfd" && HAS_ID.has(next.kind)) attr("id", next.id);
  if (HAS_TABLE.has(next.kind) && (diagram === "dfd" || diagram === "flow")) attr("table", next.table);
  const name = next.name.trim();
  const shown = node.kind === "note" ? (node.text ?? "") : node.name;
  if (name && name !== shown) ops.push({ op: "renameNode", old: node.name, next: name });
  return ops;
}

interface Props {
  diagram: DiagramKind;
  node: FlowNode;
  /** Where the panel sits, in window coordinates (beside the node). */
  at: { left: number; top: number };
  /** Why the last save did nothing, such as a taken name. */
  problem?: string | null;
  onSave(edit: NodeEdit): void;
  onCancel(): void;
}

export default function NodeEditor({ diagram, node, at, problem, onSave, onCancel }: Props) {
  const isNote = node.kind === "note";
  const [edit, setEdit] = useState<NodeEdit>({
    name: isNote ? (node.text ?? "") : node.name,
    kind: node.kind,
    id: node.attrs.id ?? "",
    table: node.attrs.table ?? "",
  });
  const box = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useDismiss(true, [box], onCancel);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  const kinds = KINDS[diagram].includes(node.kind) ? KINDS[diagram] : [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      onSave(edit);
    }
  };
  return (
    <div ref={box} className="flow-node-editor" role="dialog" aria-label={`Edit ${isNote ? "note" : node.name}`} style={at} onKeyDown={onKey}>
      <label className="flow-node-field">
        <span className="flow-node-label">{isNote ? "Text" : "Name"}</span>
        <input ref={nameRef} className="input" aria-label={isNote ? "Text" : "Name"} value={edit.name} spellCheck={false} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      </label>
      {kinds.length > 1 && (
        <label className="flow-node-field">
          <span className="flow-node-label">Kind</span>
          <Select<FlowNodeKind> label="Kind" value={edit.kind} options={kinds.map((k) => ({ value: k, label: k }))} onChange={(kind) => setEdit({ ...edit, kind })} />
        </label>
      )}
      {diagram === "dfd" && HAS_ID.has(edit.kind) && (
        <label className="flow-node-field">
          <span className="flow-node-label">Id</span>
          <input className="input mono" aria-label="Id" value={edit.id} spellCheck={false} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
        </label>
      )}
      {(diagram === "dfd" || diagram === "flow") && HAS_TABLE.has(edit.kind) && (
        <label className="flow-node-field">
          <span className="flow-node-label">Table</span>
          <input className="input mono" aria-label="Table" placeholder="schema.table" value={edit.table} spellCheck={false} onChange={(e) => setEdit({ ...edit, table: e.target.value })} />
        </label>
      )}
      {problem && (
        <p className="flow-node-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="flow-node-actions">
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-small button-primary" onClick={() => onSave(edit)}>
          Save
          <Kbd keys="Enter" />
        </button>
      </div>
    </div>
  );
}
