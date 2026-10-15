import { invoke } from "@tauri-apps/api/core";
import type {
  CommandError,
  ConnectionConfig,
  ConnectionId,
  ConnectionInput,
  DbObject,
  FullValue,
  FullValueRequest,
  Group,
  GroupId,
  GroupInput,
  ObjectKind,
  ObjectPath,
  Page,
  PageRequest,
  SuggestedConnection,
} from "./types";

export const listConnections = (): Promise<ConnectionConfig[]> => invoke("list_connections");

export const saveConnection = (input: ConnectionInput): Promise<ConnectionConfig> =>
  invoke("save_connection", { input });

export const deleteConnection = (id: ConnectionId): Promise<void> => invoke("delete_connection", { id });

/** Resolves to the server version. */
export const testConnection = (input: ConnectionInput): Promise<string> => invoke("test_connection", { input });

export const suggestedConnections = (): Promise<SuggestedConnection[]> => invoke("suggested_connections");

export const openConnection = (id: ConnectionId): Promise<void> => invoke("open_connection", { id });

export const closeConnection = (id: ConnectionId): Promise<void> => invoke("close_connection", { id });

export const listDatabases = (id: ConnectionId): Promise<string[]> => invoke("list_databases", { id });

export const listSchemas = (id: ConnectionId, database: string): Promise<string[]> =>
  invoke("list_schemas", { id, database });

export const listObjects = (id: ConnectionId, database: string, schema: string | null): Promise<DbObject[]> =>
  invoke("list_objects", { id, database, schema });

export const objectDefinition = (id: ConnectionId, kind: ObjectKind, path: ObjectPath): Promise<string> =>
  invoke("object_definition", { id, kind, path });

export const fetchPage = (id: ConnectionId, request: PageRequest): Promise<Page> =>
  invoke("fetch_page", { id, request });

export const fetchFullValue = (id: ConnectionId, request: FullValueRequest): Promise<FullValue> =>
  invoke("fetch_full_value", { id, request });

export const listGroups = (): Promise<Group[]> => invoke("list_groups");

export const saveGroup = (input: GroupInput): Promise<Group> => invoke("save_group", { input });

export const deleteGroup = (id: GroupId): Promise<void> => invoke("delete_group", { id });

export const moveConnection = (id: ConnectionId, groupId: GroupId | null): Promise<ConnectionConfig> =>
  invoke("move_connection", { id, groupId });

export const lastGroup = (): Promise<GroupId | null> => invoke("last_group");

export const setLastGroup = (id: GroupId | null): Promise<void> => invoke("set_last_group", { id });

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string";
}

export function isNotOpen(e: unknown): boolean {
  return isCommandError(e) && e.kind === "notFound" && e.message === "connection not open";
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`;
  if (n >= 1024) return `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KiB`;
  return `${n.toLocaleString("en-US")} bytes`;
}

/** Turns a command error into UI text that says what went wrong and what to do. */
export function errorText(e: unknown): string {
  if (!isCommandError(e)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case "connect":
      return `Could not connect: ${e.message}. Check the host and port, and that the database server is running.`;
    case "auth":
      return `Sign-in failed: ${e.message}. Check the user name and password.`;
    case "query":
      return `The query failed: ${e.message}`;
    case "notFound":
      return e.message === "connection not open"
        ? "This Connection is not open. Open it again to continue."
        : `Not found: ${e.message}. Refresh and try again.`;
    case "noPrimaryKey":
      return "This table has no primary key, so DB View cannot pick out one row to open the full value.";
    case "valueTooLarge":
      return `This value is ${formatBytes(e.message)}, more than the 16 MiB DB View opens at once.`;
    case "invalidInput":
      return `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}.`;
    case "store":
      return `Could not read or write saved settings: ${e.message}`;
    case "secret":
      return `Could not use Windows Credential Manager: ${e.message}`;
    default: {
      // A kind this UI does not know yet: still show what the Core said.
      const { kind, message } = e as { kind: string; message?: unknown };
      return message === undefined || message === null ? `Error: ${kind}.` : `Error (${kind}): ${String(message)}`;
    }
  }
}

export { formatBytes };
