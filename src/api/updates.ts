import { Channel, invoke } from "@tauri-apps/api/core";

/** How this copy updates (Rust `InstallKind`). */
export type InstallKind = "portable" | "appImage" | "package";

export type CheckResult = { kind: "upToDate" } | { kind: "available"; version: string } | { kind: "failed"; message: string };

/** A newer release (Rust `Offer`). `asset` is present when this install can update itself from it. */
export interface UpdateOffer {
  version: string;
  notes: string;
  pubDate: string | null;
  releaseUrl: string;
  asset?: { url: string; signature: string; sha256: string };
}

/** Rust `UpdateStatus`: what Settings > Updates and the status bar show. */
export interface UpdateStatus {
  /** null until the first start guide (or Settings) answers: checks are off until then. */
  checks: boolean | null;
  currentVersion: string;
  lastCheckMs: number | null;
  lastResult: CheckResult | null;
  offer: UpdateOffer | null;
  install: InstallKind;
  canInstall: boolean;
  /** The offer's file is downloaded and verified, waiting for the restart. */
  ready: boolean;
  releasesUrl: string;
}

export interface UpdateProgress {
  done: number;
  total: number | null;
}

export const updateStatus = (): Promise<UpdateStatus> => invoke("update_status");

export const setUpdateChecks = (on: boolean): Promise<UpdateStatus> => invoke("set_update_checks", { on });

/** `manual` is Check now; otherwise the daily check, which the Core skips unless it is due. */
export const checkForUpdate = (manual: boolean): Promise<UpdateStatus> => invoke("check_for_update", { manual });

export function downloadUpdate(onProgress: (p: UpdateProgress) => void): Promise<UpdateStatus> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke("download_update", { onProgress: channel });
}

/** Swaps the verified download in and restarts; Contura exits when it succeeds. */
export const restartToUpdate = (): Promise<void> => invoke("restart_to_update");
