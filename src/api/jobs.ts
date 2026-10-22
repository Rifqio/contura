import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  BackupPlan,
  BackupRequest,
  ConnectionId,
  ExportPreview,
  ExportRequest,
  FileSummary,
  Format,
  ImportPlan,
  ImportRequest,
  JobEvent,
  JobId,
  JobSummary,
  PassId,
  RestorePlan,
  RestoreRequest,
  RestoreTarget,
  ScriptPlan,
  ScriptRequest,
  ScriptStatement,
  TransferPlan,
  TransferRequest,
} from "./types";

/** Receives every event of one job, in order. */
export type OnJobEvent = (e: JobEvent) => void;

function channel(onEvent: OnJobEvent): Channel<JobEvent> {
  const events = new Channel<JobEvent>();
  events.onmessage = onEvent;
  return events;
}

/**
 * A new job id. Export, import and script jobs take theirs from the client, so `useJobs().track`
 * can watch the id before the job starts and no event is lost (Q2).
 */
export function newJobId(): JobId {
  return crypto.randomUUID();
}

/** The first lines or rows the export would write, and its size per row. */
export function previewExport(req: ExportRequest): Promise<ExportPreview> {
  return invoke<ExportPreview>("preview_export", { req });
}

/** Starts export `id` (from `newJobId`); `overwrite` replaces an existing file. */
export async function startExport(id: JobId, req: ExportRequest, overwrite: boolean, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("start_export", { job: id, req, overwrite, events: channel(onEvent) });
  return id;
}

/** `format: null` picks it from the file name. */
export function inspectImportFile(path: string, format: Format | null): Promise<FileSummary> {
  return invoke<FileSummary>("inspect_import_file", { path, format });
}

export function planImport(req: ImportRequest): Promise<ImportPlan> {
  return invoke<ImportPlan>("plan_import", { req });
}

/** The check pass: every row checked against its column, without writing. */
export function checkImportFile(req: ImportRequest, onEvent: OnJobEvent): Promise<JobId> {
  return invoke<JobId>("check_import_file", { req, events: channel(onEvent) });
}

/** The Production confirmation of an import: a pass for exactly this file and plan. */
export function confirmImport(req: ImportRequest): Promise<PassId> {
  return invoke<PassId>("confirm_import", { req });
}

/** Starts import `id` (from `newJobId`); `pass` comes from `confirmImport` on Production. */
export async function startImport(id: JobId, req: ImportRequest, pass: PassId | null, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("start_import", { job: id, req, pass, events: channel(onEvent) });
  return id;
}

export function planScript(req: ScriptRequest): Promise<ScriptPlan> {
  return invoke<ScriptPlan>("plan_script", { req });
}

/** 100 statements of the file from statement `from`, read on demand; `runAsIs` shows the statements that run as is as Run (Q12). */
export function scriptStatements(
  connectionId: ConnectionId,
  path: string,
  from: number,
  runAsIs = false,
): Promise<ScriptStatement[]> {
  // The Core reads a missing runAsIs as false.
  return invoke<ScriptStatement[]>("script_statements", { connectionId, path, from, ...(runAsIs ? { runAsIs } : {}) });
}

export function confirmScript(req: ScriptRequest): Promise<PassId> {
  return invoke<PassId>("confirm_script", { req });
}

/** Starts script `id` (from `newJobId`, Q21); `pass` comes from `confirmScript` on Production. */
export async function startScript(id: JobId, req: ScriptRequest, pass: PassId | null, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("start_script", { job: id, req, pass, events: channel(onEvent) });
  return id;
}

export function planTransfer(req: TransferRequest): Promise<TransferPlan> {
  return invoke<TransferPlan>("plan_transfer", { req });
}

/** The first INSERT of `table`'s copy, from 4 source rows. */
export function transferSample(req: TransferRequest, table: string): Promise<string> {
  return invoke<string>("transfer_sample", { req, table });
}

/** The Production confirmation of a transfer: a pass on the target for this plan. */
export function confirmTransfer(req: TransferRequest): Promise<PassId> {
  return invoke<PassId>("confirm_transfer", { req });
}

/**
 * Starts transfer `id` (from `newJobId`). `reviewed` is the plan fingerprint Review SQL showed,
 * so a target that changed since is refused; `pass` comes from `confirmTransfer` on Production.
 */
export async function startTransfer(
  id: JobId,
  req: TransferRequest,
  reviewed: string | null,
  pass: PassId | null,
  onEvent: OnJobEvent,
): Promise<JobId> {
  await invoke("start_transfer", { job: id, req, reviewed, pass, events: channel(onEvent) });
  return id;
}

/** What a Backup of the database (or PostgreSQL schema) would hold: counts, not-included list, estimate, file name. */
export function planBackup(req: BackupRequest): Promise<BackupPlan> {
  return invoke<BackupPlan>("plan_backup", { req });
}

/** Starts Backup `id` (from `newJobId`); `overwrite` replaces an existing file. A read job: no pass anywhere. */
export async function startBackup(id: JobId, req: BackupRequest, overwrite: boolean, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("start_backup", { job: id, req, overwrite, events: channel(onEvent) });
  return id;
}

/** Starts Restore's check pass `id` on `path`: its finished report carries the `restoreCheck`. */
export async function inspectRestore(id: JobId, target: RestoreTarget, path: string, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("inspect_restore", { job: id, target, path, events: channel(onEvent) });
  return id;
}

export function planRestore(req: RestoreRequest): Promise<RestorePlan> {
  return invoke<RestorePlan>("plan_restore", { req });
}

/** Show all: 100 of the plan's structure statements from position `from`, read from the file on demand. */
export function restoreStatements(req: RestoreRequest, from: number): Promise<ScriptStatement[]> {
  return invoke<ScriptStatement[]>("restore_statements", { req, from });
}

/** The Production confirmation of a Restore: a Job pass for the plan's fingerprint (the file's SHA-256 included). */
export function confirmRestore(req: RestoreRequest): Promise<PassId> {
  return invoke<PassId>("confirm_restore", { req });
}

/**
 * Starts Restore `id` (from `newJobId`). `fingerprint` is the reviewed plan's (R28, every Connection): another
 * file or plan gives `fileChanged` before anything writes. `pass` comes from `confirmRestore` on Production.
 */
export async function startRestore(id: JobId, req: RestoreRequest, fingerprint: string, pass: PassId | null, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("start_restore", { job: id, req, fingerprint, pass, events: channel(onEvent) });
  return id;
}

export function cancelJob(id: JobId): Promise<void> {
  return invoke<void>("cancel_job", { job: id });
}

export function listJobs(): Promise<JobSummary[]> {
  return invoke<JobSummary[]>("list_jobs");
}

/** Watches a job again: the last progress, or the final event, arrives at once. */
export async function jobEvents(id: JobId, onEvent: OnJobEvent): Promise<JobId> {
  await invoke("job_events", { job: id, events: channel(onEvent) });
  return id;
}

/** Shows the file in its folder: selected in Explorer or Finder; Linux opens the folder. */
export function revealInFolder(path: string): Promise<void> {
  return invoke<void>("reveal_in_folder", { path });
}

/** A UTF-8 text file the user chose, 1 MiB at most (Mermaid's Open .mmd file). */
export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}
