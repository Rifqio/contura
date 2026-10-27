import { useEffect, useMemo, useState } from "react";
import { errorText, listDatabases, listObjects, listSchemas } from "../api/client";
import type { ConnectionConfig } from "../api/types";

const SYSTEM_DATABASES = new Set(["information_schema", "performance_schema", "mysql", "sys", "pg_catalog", "template0", "template1"]);

/**
 * The Connection, Database and Schema pickers shared by the Schema Builder's start dialog and From my database:
 * only open Connections are offered, system databases are hidden until asked for, and the table count follows.
 */
export function useSchemaSource(
  connections: ConnectionConfig[],
  openIds: ReadonlySet<string>,
  initial?: { connectionId: string; database: string; schema: string | null },
) {
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [showSystem, setShowSystem] = useState(!!initial && SYSTEM_DATABASES.has(initial.database));
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schema, setSchema] = useState(initial?.schema ?? "");
  const [tableCount, setTableCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connection = connections.find((c) => openIds.has(c.id) && c.id === connectionId);

  useEffect(() => {
    if (!connectionId) return;
    setError(null);
    setDatabases(null);
    listDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => setError(errorText(e, connection?.dialect)));
  }, [connectionId]);

  const visibleDatabases = useMemo(
    () => (databases ?? []).filter((d) => showSystem || !SYSTEM_DATABASES.has(d)),
    [databases, showSystem],
  );

  // Never rest on a hidden database: take the first one shown.
  useEffect(() => {
    if (databases === null) return;
    if (!visibleDatabases.includes(database)) setDatabase(visibleDatabases[0] ?? "");
  }, [databases, visibleDatabases, database]);

  useEffect(() => {
    if (!connection || connection.dialect !== "postgres" || !database) return;
    setError(null);
    setSchemas(null);
    listSchemas(connection.id, database)
      .then((s) => {
        const user = s.filter((x) => !x.isSystem).map((x) => x.name);
        setSchemas(user);
        if (!schema || !user.includes(schema)) setSchema(user.includes("public") ? "public" : (user[0] ?? ""));
      })
      .catch((e) => setError(errorText(e, connection.dialect)));
  }, [connectionId, database]);

  useEffect(() => {
    setTableCount(null);
    if (!connection || !database) return;
    const pg = connection.dialect === "postgres";
    if (pg && !schema) return;
    let live = true;
    listObjects(connection.id, database, pg ? schema : null)
      .then((objects) => live && setTableCount(objects.filter((o) => o.kind === "table").length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId, database, schema]);

  /** Choosing another Connection starts the database and schema over. */
  function chooseConnection(id: string) {
    setError(null);
    setConnectionId(id);
    setDatabase("");
    setSchema("");
    setDatabases(null);
  }

  return {
    connection,
    connectionId,
    setConnectionId: chooseConnection,
    databases,
    visibleDatabases,
    database,
    setDatabase,
    showSystem,
    setShowSystem,
    schemas,
    schema,
    setSchema,
    tableCount,
    error,
  };
}
