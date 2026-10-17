import type { ConnectionConfig, ConnectionId, ObjectKind, ObjectPath } from "../api/types";
import type { QueryTabDoc } from "../query/QueryTab";
import Icon from "./Icon";
import SafetyTag from "./SafetyTag";

/** A table, view, routine or trigger chosen in the object tree. */
export interface Selection {
  connectionId: ConnectionId;
  kind: ObjectKind;
  path: ObjectPath;
}

export type WorkTab = { kind: "object"; key: string; selection: Selection } | { kind: "query"; doc: QueryTabDoc };

export const tabName = (t: WorkTab) => (t.kind === "object" ? t.selection.path.name : t.doc.name);

const isDirty = (t: WorkTab) => t.kind === "query" && t.doc.savedId !== null && t.doc.text !== t.doc.savedText;

const iconOf = (t: WorkTab) =>
  t.kind === "query"
    ? "edit"
    : t.selection.kind === "table"
      ? "table"
      : t.selection.kind === "view"
        ? "view"
        : t.selection.kind === "trigger"
          ? "trigger"
          : "routine";

interface Props {
  tabs: WorkTab[];
  active: number;
  onSelect(index: number): void;
  onClose(index: number): void;
  onNew(): void;
  /** Lets a query tab show the Production or Read-only mark of its Connection. */
  connections?: ConnectionConfig[];
  /** Table tabs (by key) whose grid has Pending Edits. */
  dirtyKeys?: ReadonlySet<string>;
}

/** The open tables and queries, as tabs in the title bar. */
export default function TabStrip({ tabs, active, onSelect, onClose, onNew, connections = [], dirtyKeys }: Props) {
  return (
    <div className="tab-strip">
      <div role="tablist" aria-label="Open tabs" className="tab-list">
        {tabs.map((t, i) => {
          const name = tabName(t);
          const dirty = isDirty(t) || (t.kind === "object" && !!dirtyKeys?.has(t.key));
          const cid = t.kind === "query" ? t.doc.connectionId : t.selection.connectionId;
          const owner = connections.find((c) => c.id === cid);
          const safety = owner?.readOnly ? "Read-only" : owner?.production ? "Production" : null;
          const label = [name, dirty ? "unsaved changes" : null, safety].filter(Boolean).join(", ");
          return (
            <div key={t.kind === "object" ? t.key : t.doc.id} className={i === active ? "work-tab work-tab-on" : "work-tab"}>
              <button
                type="button"
                role="tab"
                aria-selected={i === active}
                aria-label={label}
                className="work-tab-button"
                title={name}
                onClick={() => onSelect(i)}
              >
                <Icon name={iconOf(t)} />
                <span className="work-tab-name">{name}</span>
                {owner && <SafetyTag connection={owner} small />}
                {dirty && <span className="work-tab-dot" aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="icon-button work-tab-close"
                aria-label={`Close ${name}`}
                title={`Close ${name}`}
                onClick={() => onClose(i)}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-button" aria-label="New query" title="New query (Ctrl+T)" onClick={onNew}>
        <Icon name="plus" />
      </button>
    </div>
  );
}
