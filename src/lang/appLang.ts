// The app's one language worker and schema index. It lives as long as the
// page: React StrictMode mounts, unmounts and mounts again in development,
// and a client held in component state would be disposed by that unmount.
import { LangClient } from "./client";
import { SchemaCache } from "./sql/schemaCache";

let shared: { client: LangClient; schemas: SchemaCache } | null = null;

export function appLang(): { client: LangClient; schemas: SchemaCache } {
  if (!shared) {
    const client = new LangClient();
    shared = { client, schemas: new SchemaCache(client) };
  }
  return shared;
}
