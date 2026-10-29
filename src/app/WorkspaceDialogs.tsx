import type { ConnectionConfig, ConnectionId, DialectKind, Group, GroupId } from "../api/types";
import ConnectionForm from "../components/ConnectionForm";
import GroupForm from "../components/GroupForm";
import type { ModelDoc } from "../schema/SchemaBuilder";
import StartModel from "../schema/StartModel";

export type Form =
  | { kind: "none" }
  | { kind: "group" }
  | { kind: "newGroup" }
  /** `duplicateOf` starts a new Connection from another one's settings (PR23); `dialect` starts a new one on that Dialect (the first start guide). */
  | { kind: "connection"; connection?: ConnectionConfig; duplicateOf?: ConnectionConfig; dialect?: DialectKind };

/** New Schema Model: from Home or the tree, or a Recent file that does not say its Dialect. */
export type ModelStart = {
  /** A file opened from Recent that does not say its Dialect, or an ER diagram opened as DBML (no path); StartModel asks for one. */
  file?: { path: string | null; name?: string; dbml: string; layout: string | null };
  initial?: {
    connectionId: ConnectionId;
    database: string;
    schema: string | null;
  };
};

interface Props {
  form: Form;
  group: Group | undefined;
  groups: Group[];
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  workspaceGroupId: GroupId | null;
  modelStart: ModelStart | null;
  onCloseForm(): void;
  reload(): Promise<void>;
  confirmGroupLeave(groupId: GroupId): Promise<boolean>;
  /** The place's Group was deleted from its form: App moves to Ungrouped and shows Home. */
  onGroupDeleted(): void;
  /** `edited`: an existing Connection was saved, so its session closed (App: markClosed). */
  onConnectionSaved(saved: ConnectionConfig, edited: boolean): void;
  /** Before an edited Connection is saved: App asks about its running jobs; false keeps the form. */
  beforeConnectionSave?(id: ConnectionId): Promise<boolean>;
  onStartModel(doc: ModelDoc): void;
  onCancelModel(): void;
}

type FormProps = Omit<Props, "modelStart" | "onStartModel" | "onCancelModel">;
type StartModelProps = Pick<Props, "modelStart" | "connections" | "openIds" | "onStartModel" | "onCancelModel">;

/** The Group and Connection forms; App renders its leave dialog after them, then StartModelDialog. */
export function FormDialogs({
  form,
  group,
  groups,
  connections,
  openIds,
  workspaceGroupId,
  onCloseForm,
  reload,
  confirmGroupLeave,
  onGroupDeleted,
  onConnectionSaved,
  beforeConnectionSave,
}: FormProps) {
  return (
    <>
      {form.kind === "group" && group && (
        <GroupForm
          group={group}
          connections={connections.filter((c) => c.groupId === group.id)}
          openIds={openIds}
          onChanged={reload}
          onSaved={() => {
            onCloseForm();
            void reload();
          }}
          onBeforeDelete={() => confirmGroupLeave(group.id)}
          onDeleted={() => {
            onCloseForm();
            void reload();
            onGroupDeleted();
          }}
          onCancel={() => onCloseForm()}
        />
      )}
      {form.kind === "newGroup" && (
        <GroupForm
          connections={[]}
          onChanged={reload}
          onSaved={() => {
            onCloseForm();
            void reload();
          }}
          onDeleted={() => onCloseForm()}
          onCancel={() => onCloseForm()}
        />
      )}
      {form.kind === "connection" && (
        <ConnectionForm
          connection={form.connection}
          isOpen={form.connection ? openIds.has(form.connection.id) : false}
          duplicateOf={form.duplicateOf}
          dialect={form.dialect}
          groups={groups}
          defaultGroupId={workspaceGroupId}
          beforeSave={form.connection && beforeConnectionSave ? () => beforeConnectionSave(form.connection!.id) : undefined}
          onSaved={(saved) => {
            onConnectionSaved(saved, !!form.connection);
            onCloseForm();
            void reload();
          }}
          onCancel={() => onCloseForm()}
        />
      )}
    </>
  );
}

export function StartModelDialog({ modelStart, connections, openIds, onStartModel, onCancelModel }: StartModelProps) {
  return (
    modelStart && (
      <StartModel
        connections={connections}
        openIds={openIds}
        initial={modelStart.initial}
        file={modelStart.file}
        onStart={onStartModel}
        onCancel={() => onCancelModel()}
      />
    )
  );
}
