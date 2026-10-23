import { useSyncExternalStore } from "react";
import { errorText } from "../api/client";
import { checkForUpdate, downloadUpdate, restartToUpdate, setUpdateChecks, updateStatus, type UpdateStatus } from "../api/updates";
import { restartGuard } from "./restartGuard";

/** What the update is doing now. */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; done: number; total: number | null }
  | { kind: "restarting" };

export interface UpdateState {
  /** null until the Core has answered once. */
  status: UpdateStatus | null;
  phase: UpdatePhase;
  /** The last failure of Check now, the download or the restart, as a sentence. */
  error: string | null;
  /** Unsaved work found before a restart, one line each; the Updates section asks about it. */
  ask: string[] | null;
}

export const RESTART_ASK = "Save or discard your changes before Contura restarts";

const INITIAL: UpdateState = { status: null, phase: { kind: "idle" }, error: null, ask: null };

let state: UpdateState = INITIAL;
const listeners = new Set<() => void>();

function set(change: Partial<UpdateState>) {
  state = { ...state, ...change };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUpdates(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

export function updateState(): UpdateState {
  return state;
}

export function resetUpdatesForTests() {
  state = INITIAL;
  for (const l of listeners) l();
}

/** At start: reads the state, then runs the daily check (the Core skips it unless checks are on and it is due). */
export async function loadUpdates(): Promise<void> {
  try {
    set({ status: await updateStatus() });
  } catch {
    return;
  }
  await dailyCheck();
}

/** The daily check: quiet, its result shows only in Settings and as the status bar pill. */
export async function dailyCheck(): Promise<void> {
  if (state.status?.checks !== true || state.phase.kind !== "idle") return;
  try {
    set({ status: await checkForUpdate(false) });
  } catch {
    // A failed check is recorded by the Core; a failed command changes nothing here.
  }
}

/**
 * Saves the checks choice (a local write) and returns why it failed, or null. Turning checks on starts the
 * daily check in the background: the caller never waits for the network.
 */
export async function saveChecks(on: boolean): Promise<string | null> {
  try {
    set({ status: await setUpdateChecks(on), error: null });
  } catch (e) {
    const text = errorText(e);
    set({ error: text });
    return text;
  }
  if (on) void dailyCheck();
  return null;
}

/** The Settings switch (and the first start guide, through `saveChecks`). */
export async function chooseChecks(on: boolean): Promise<void> {
  await saveChecks(on);
}

/** Check now: runs with checks off too, since the user asked. */
export async function checkNow(): Promise<void> {
  if (state.phase.kind !== "idle") return;
  set({ phase: { kind: "checking" }, error: null });
  try {
    set({ status: await checkForUpdate(true) });
  } catch (e) {
    set({ error: errorText(e) });
  } finally {
    set({ phase: { kind: "idle" } });
  }
}

/** Update and restart: asks about unsaved work, downloads and verifies, then swaps and restarts. */
export async function updateAndRestart(): Promise<void> {
  if (state.phase.kind !== "idle" || !state.status?.canInstall) return;
  set({ error: null });
  const pending = restartGuard().pending();
  if (pending.length > 0) {
    set({ ask: pending });
    return;
  }
  await downloadThenRestart();
}

/** The ask's Review changes: Save or Discard for each, then the update goes on. */
export async function resolveAndRestart(): Promise<void> {
  set({ ask: null });
  if (!(await restartGuard().resolve())) {
    set({ error: `${RESTART_ASK}.` });
    return;
  }
  await downloadThenRestart();
}

export function cancelAsk() {
  set({ ask: null });
}

async function downloadThenRestart(): Promise<void> {
  if (!state.status?.ready) {
    set({ phase: { kind: "downloading", done: 0, total: null } });
    try {
      const status = await downloadUpdate((p) => set({ phase: { kind: "downloading", done: p.done, total: p.total } }));
      set({ status });
    } catch (e) {
      set({ phase: { kind: "idle" }, error: errorText(e) });
      return;
    }
  }
  // Work changed while the file downloaded: ask again, the verified file waits.
  const pending = restartGuard().pending();
  if (pending.length > 0) {
    set({ phase: { kind: "idle" }, ask: pending });
    return;
  }
  set({ phase: { kind: "restarting" } });
  try {
    await restartGuard().flush();
    await restartToUpdate();
  } catch (e) {
    set({ phase: { kind: "idle" }, error: errorText(e) });
    try {
      set({ status: await updateStatus() });
    } catch {
      // The status stays as it was.
    }
  }
}
