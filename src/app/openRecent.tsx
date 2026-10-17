import { errorText, readModelFiles } from "../api/client";
import type { ConnectionConfig, ConnectionId, RecentItem, SavedQuery } from "../api/types";
import { fileName } from "../home/recent";
import { EMPTY_LAYOUT, parseLayout } from "../schema/layout";
import type { ModelDoc } from "../schema/SchemaBuilder";
import { dialectFromHeader } from "../schema/StartModel";
import type { Place, Selection } from "../shell/tabs";
import { placeOf } from "./places";

export interface RecentEnv {
  connections: ConnectionConfig[];
  savedQueries: SavedQuery[];
  openConnectionAt(id: ConnectionId): Promise<"open" | "failed" | "stayed">;
  enterPlace(place: Place, remember?: boolean): Promise<boolean>;
  whenDraftsLoaded(place: Place, run: () => void): void;
  openSaved(q: SavedQuery, on: ConnectionId | null): void;
  openObject(selection: Selection): void;
  openBuilder(doc: ModelDoc): void;
  /** A model file that does not say its Dialect: StartModel asks (App: setModelStart({ file })). */
  askDialect(file: { path: string; dbml: string; layout: string | null }): void;
  notice(text: string): void;
}

/** A file error that means the file is gone (Windows "cannot find the file" or "path", or POSIX "No such file"). */
function isMissingFile(e: unknown): boolean {
  const err = e as { kind?: unknown; message?: unknown } | null;
  return err?.kind === "file" && typeof err.message === "string" && /\(os error [23]\)|No such file/.test(err.message);
}

/** Reopens a Recent item: its Connection's place, the Connection, then the table, query or model. */
export async function openRecentItem(item: RecentItem, env: RecentEnv): Promise<void> {
  const t = item.target;
  const c = env.connections.find((x) => x.id === item.connectionId) ?? null;
  if (t.kind === "schemaModel") {
    // Read the file first, so a missing one leaves you where you are with the item still listed.
    let files;
    try {
      files = await readModelFiles(t.file);
    } catch (e) {
      env.notice(isMissingFile(e) ? `${fileName(t.file)} is no longer there.` : errorText(e));
      return;
    }
    // A model can be edited offline: a Connection that fails to open keeps its notice, and the model still opens.
    if (c && (await env.openConnectionAt(c.id)) === "stayed") return;
    const dialect = dialectFromHeader(files.dbml) ?? c?.dialect ?? null;
    if (!dialect) {
      // The file does not say its Dialect: ask, as Open file does.
      env.askDialect({ path: t.file, dbml: files.dbml, layout: files.layout });
      return;
    }
    env.openBuilder({
      path: t.file,
      dbml: files.dbml,
      savedDbml: files.dbml,
      layout: files.layout ? parseLayout(files.layout) : EMPTY_LAYOUT,
      dialect,
      source: "file",
      connectionId: c?.id ?? null,
    });
    return;
  }
  if (t.kind === "query") {
    const q = env.savedQueries.find((x) => x.id === t.savedId);
    if (!q) {
      env.notice(`${t.name} is no longer a Saved Query.`);
      return;
    }
    let place: Place = { kind: "ungrouped" };
    if (c) {
      if ((await env.openConnectionAt(c.id)) !== "open") return;
      place = placeOf(c);
    } else if (!(await env.enterPlace(place, false))) return;
    env.whenDraftsLoaded(place, () => env.openSaved(q, c?.id ?? null));
    return;
  }
  if (!c) {
    env.notice("The Connection of that table is no longer there.");
    return;
  }
  if ((await env.openConnectionAt(c.id)) !== "open") return;
  env.whenDraftsLoaded(placeOf(c), () => env.openObject({ connectionId: c.id, kind: t.object, path: t.path }));
}
