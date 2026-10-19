import { Channel, invoke } from "@tauri-apps/api/core";
import type { OnJobEvent } from "./jobs";
import type { CompareRequest, CompareResult, DdlPair, ItemId, JobEvent, JobId, PassId, SyncOutcome, SyncPlan } from "./types";

// Schema Compare (step 10). Every call reads both sides fresh: compare and plan are read-only on
// both sides, on Read-only and Production Connections, with no pass.

/** Reads both sides and diffs them: items, not-compared counts, the summary and data-loss counts. */
export function compareSchemas(req: CompareRequest): Promise<CompareResult> {
  return invoke<CompareResult>("compare_schemas", { req });
}

/** One table's (or enum's) DDL on each side, for the aligned panes; fetched per selection. */
export function compareDdl(req: CompareRequest, table: string): Promise<DdlPair> {
  return invoke<DdlPair>("compare_ddl", { req, table });
}

/**
 * The Sync Script for `selection`, closed over `needs`: unticking an item unticks what needs it,
 * ticking one ticks what it needs. `null` asks for the default selection (every scriptable item
 * except data-loss items).
 */
export function planSync(req: CompareRequest, selection: ItemId[] | null): Promise<SyncPlan> {
  return invoke<SyncPlan>("plan_sync", { req, selection });
}

/** The Production confirmation: a Sync pass for exactly this selection's statements. */
export function confirmSync(req: CompareRequest, selection: ItemId[]): Promise<PassId> {
  return invoke<PassId>("confirm_sync", { req, selection });
}

/**
 * Applies the ticked script as job `id` (from `newJobId`, kind `sync`); progress arrives on `onEvent`
 * and `cancelJob(id)` stops between statements. `expectedHash` is the hash of the statements shown:
 * a target that changed since gives `planChanged`. `pass` comes from `confirmSync` on Production.
 */
export function applySync(
  id: JobId,
  req: CompareRequest,
  selection: ItemId[],
  pass: PassId | null,
  expectedHash: string,
  onEvent: OnJobEvent,
): Promise<SyncOutcome> {
  const events = new Channel<JobEvent>();
  events.onmessage = onEvent;
  return invoke<SyncOutcome>("apply_sync", { job: id, req, selection, pass, expectedHash, events });
}
