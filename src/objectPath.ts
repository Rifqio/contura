import type { ConnectionId, ObjectKind, ObjectPath } from "./api/types";

/**
 * A React key that tells two objects apart. The pieces are joined with NUL,
 * which no name can hold, so names with `/` or `.` cannot collide. A null
 * schema leaves its piece out, so it never matches a schema named "".
 */
export function objectKey(connectionId: ConnectionId, kind: ObjectKind, path: ObjectPath): string {
  const schema = path.schema === null ? [] : [path.schema];
  return [connectionId, kind, path.database, ...schema, path.name].join("\u0000");
}

/** The muted part of an object's title: `shop.` or, with a schema, `shop.sales.`. */
export function objectPrefix(path: ObjectPath): string {
  return path.schema === null ? `${path.database}.` : `${path.database}.${path.schema}.`;
}
