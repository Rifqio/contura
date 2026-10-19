// The app's one language worker and schema index. It lives as long as the
// page: React StrictMode mounts, unmounts and mounts again in development,
// and a client held in component state would be disposed by that unmount.
import type { Extension } from "@codemirror/state";
import { LangClient } from "./client";
import { flowLanguageWith } from "./flow/cm";
import { SchemaCache } from "./sql/schemaCache";

let shared: { client: LangClient; schemas: SchemaCache } | null = null;

export function appLang(): { client: LangClient; schemas: SchemaCache } {
  if (!shared) {
    const client = new LangClient();
    shared = { client, schemas: new SchemaCache(client) };
  }
  return shared;
}

/** The .flow editor language (highlighting, group folding, completion) for document `docId`, on the shared worker. */
export function flowEditorLanguage(docId: string): Extension[] {
  return flowLanguageWith(appLang().client, docId);
}
