import type { ConnectionConfig, DialectKind } from "../api/types";
import type { AskContext } from "../assistant/context";

/**
 * The Connection a model was read from, as the ask context sees it. A model whose Connection
 * is gone fails closed: access "never", so no DBML can be sent.
 */
export function sourceConnectionFor(
  connectionId: string | null,
  dialect: DialectKind,
  connections: ConnectionConfig[],
): AskContext["connection"] {
  if (!connectionId) return null;
  const c = connections.find((x) => x.id === connectionId);
  if (!c) return { id: connectionId, name: "The source Connection", dialect, database: null, access: "never" };
  return { id: c.id, name: c.name, dialect: c.dialect, database: null, access: c.aiAccess };
}
