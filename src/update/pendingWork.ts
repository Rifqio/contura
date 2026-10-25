import { type AnyTab, isUnsaved, objectTabOf } from "../shell/tabs";

/**
 * What a restart would ask about, one line each: tables with Pending Edits, unapplied designs,
 * Saved Queries and Visual Queries with unsaved changes, a Data Transfer set up but not run,
 * diagrams still saving, and running jobs. Empty when a restart loses nothing.
 */
export function pendingWork(o: { tabs: readonly AnyTab[]; isDirty(key: string): boolean; flows: readonly string[]; jobsRunning: boolean }): string[] {
  const lines: string[] = [];
  for (const t of o.tabs) {
    const obj = objectTabOf(t);
    if (obj && o.isDirty(obj.key)) {
      const name = obj.path?.name ?? "a new table";
      lines.push(t.kind === "design" ? `Design changes to ${name}, not applied` : `Pending Edits in ${name}`);
    } else if (isUnsaved(t)) {
      if (t.kind === "query" || t.kind === "visual") lines.push(`${t.doc.name}, not saved`);
      else if (t.kind === "transfer") lines.push(`${t.title}, set up but not run`);
    }
  }
  for (const name of o.flows) lines.push(`${name}, still saving`);
  if (o.jobsRunning) lines.push("A running job");
  return lines;
}
