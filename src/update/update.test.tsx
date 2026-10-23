import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UpdateOffer, UpdateStatus } from "../api/updates";
import UpdatesSection, { UPDATES_PRIVACY, lastCheckText } from "../settings/sections/UpdatesSection";
import { callsTo, routeInvoke } from "../test/invoke";
import { pendingWork } from "./pendingWork";
import { setRestartGuard } from "./restartGuard";
import UpdatePill from "./UpdatePill";
import { RESTART_ASK, chooseChecks, loadUpdates, resetUpdatesForTests, updateState } from "./updateStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

const OFFER: UpdateOffer = {
  version: "1.0.1",
  notes: "Faster grids.\nFixes the export dialog.",
  pubDate: "2026-11-01T10:00:00Z",
  releaseUrl: "https://github.com/Rifqio/contura/releases/tag/v1.0.1",
  asset: { url: "https://github.com/Rifqio/contura/releases/download/v1.0.1/x.exe", signature: "c2ln", sha256: "0".repeat(64) },
};

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    checks: null,
    currentVersion: "1.0.0",
    lastCheckMs: null,
    lastResult: null,
    offer: null,
    install: "portable",
    canInstall: false,
    ready: false,
    releasesUrl: "https://github.com/Rifqio/contura/releases",
    ...over,
  };
}

/** A Core that keeps the checks choice and answers checks with `found`. */
function core(start: UpdateStatus, found: Partial<UpdateStatus> = { lastResult: { kind: "upToDate" } }) {
  let s = start;
  return routeInvoke({
    update_status: () => s,
    set_update_checks: (a) => (s = { ...s, checks: a.on as boolean }),
    check_for_update: () => (s = { ...s, lastCheckMs: Date.UTC(2026, 9, 23, 9, 30), ...found }),
    download_update: () => (s = { ...s, ready: true }),
    restart_to_update: () => undefined,
    open_url: () => undefined,
  });
}

let unguard: (() => void) | null = null;

beforeEach(() => resetUpdatesForTests());
afterEach(() => {
  unguard?.();
  unguard = null;
});

test("until the choice is made no check runs; turning checks on runs the daily check", async () => {
  core(status());
  await act(() => loadUpdates());
  // Off until the user answers (the first start guide or Settings): nothing was asked of GitHub.
  expect(callsTo("check_for_update")).toEqual([]);
  await act(() => chooseChecks(true));
  expect(callsTo("set_update_checks")).toEqual([{ on: true }]);
  expect(callsTo("check_for_update")).toEqual([{ manual: false }]);
});

test("an Off answer is remembered: no check now or at the next start", async () => {
  core(status());
  await act(() => loadUpdates());
  await act(() => chooseChecks(false));
  expect(callsTo("set_update_checks")).toEqual([{ on: false }]);
  resetUpdatesForTests();
  await act(() => loadUpdates());
  expect(updateState().status?.checks).toBe(false);
  expect(callsTo("check_for_update")).toEqual([]);
});

test("with checks on, a start runs the daily check, which the Core may skip", async () => {
  core(status({ checks: true }));
  await act(() => loadUpdates());
  expect(callsTo("check_for_update")).toEqual([{ manual: false }]);
});

test("a start without the Core's answer throws nothing", async () => {
  routeInvoke({});
  await act(() => loadUpdates());
  expect(updateState().status).toBeNull();
});

test("Settings > Updates: the switch, the version, Check now with checks off, and the last check", async () => {
  core(status({ checks: false }));
  render(<UpdatesSection />);
  const sw = await screen.findByRole("switch", { name: "Check for updates" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(UPDATES_PRIVACY)).toBeTruthy();
  expect(screen.getByText("Contura 1.0.0")).toBeTruthy();
  expect(screen.getByText("Not checked yet.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Check now" }));
  await screen.findByText(/Contura is up to date\.$/);
  expect(callsTo("check_for_update")).toEqual([{ manual: true }]);
  await userEvent.click(sw);
  await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  expect(callsTo("set_update_checks")).toEqual([{ on: true }]);
});

test("the last check line names the time and the result", () => {
  const at = Date.UTC(2026, 9, 23, 9, 30);
  expect(lastCheckText(status({ lastCheckMs: at, lastResult: { kind: "available", version: "1.0.1" } }))).toMatch(/^Last checked .*2026.*\. Contura 1\.0\.1 is available\.$/);
  expect(lastCheckText(status({ lastCheckMs: at, lastResult: { kind: "failed", message: "Contura could not reach github.com." } }))).toMatch(
    /Contura could not reach github\.com\.$/,
  );
});

test("a found release shows its notes and Update and restart, which downloads and restarts", async () => {
  core(status({ checks: true, offer: OFFER, canInstall: true, lastResult: { kind: "available", version: "1.0.1" } }));
  render(<UpdatesSection />);
  await screen.findByRole("heading", { name: "Contura 1.0.1" });
  expect(screen.getByText(/Faster grids\./)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(callsTo("restart_to_update")).toHaveLength(1));
  expect(callsTo("download_update")).toHaveLength(1);
});

test("a failed download says why and offers the release page", async () => {
  routeInvoke({
    update_status: () => status({ checks: true, offer: OFFER, canInstall: true }),
    check_for_update: () => status({ checks: true, offer: OFFER, canInstall: true }),
    download_update: () => {
      throw { kind: "update", message: "The download did not match its signature, so nothing was changed." };
    },
    restart_to_update: () => undefined,
    open_url: () => undefined,
  });
  render(<UpdatesSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The download did not match its signature, so nothing was changed.");
  expect(callsTo("restart_to_update")).toEqual([]);
  await userEvent.click(within(alert).getByRole("button", { name: "Open the release page" }));
  expect(callsTo("open_url")).toEqual([{ url: OFFER.releaseUrl }]);
});

test("a .deb install gets a link to the release instead of a swap", async () => {
  core(status({ checks: true, install: "package", offer: { ...OFFER, asset: undefined } }));
  render(<UpdatesSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Download the new .deb" }));
  expect(callsTo("open_url")).toEqual([{ url: OFFER.releaseUrl }]);
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

test("unsaved work is asked about before the restart; Cancel changes nothing", async () => {
  core(status({ checks: true, offer: OFFER, canInstall: true }));
  const resolve = vi.fn(() => Promise.resolve(true));
  unguard = setRestartGuard({ pending: () => ["Pending Edits in orders"], resolve, flush: () => Promise.resolve() });
  render(<UpdatesSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
  const dialog = await screen.findByRole("dialog", { name: RESTART_ASK });
  expect(within(dialog).getByText("Pending Edits in orders")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(resolve).not.toHaveBeenCalled();
  expect(callsTo("download_update")).toEqual([]);
  expect(callsTo("restart_to_update")).toEqual([]);
});

test("Save or discard asks each, then the update goes on; a cancelled ask stops it", async () => {
  core(status({ checks: true, offer: OFFER, canInstall: true }));
  let dirty = true;
  const flush = vi.fn(() => Promise.resolve());
  let answer = false;
  unguard = setRestartGuard({
    pending: () => (dirty ? ["Pending Edits in orders"] : []),
    resolve: () => {
      if (answer) dirty = false;
      return Promise.resolve(answer);
    },
    flush,
  });
  render(<UpdatesSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save or discard" }));
  expect((await screen.findByRole("alert")).textContent).toContain(`${RESTART_ASK}.`);
  expect(callsTo("download_update")).toEqual([]);
  answer = true;
  await userEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save or discard" }));
  await waitFor(() => expect(callsTo("restart_to_update")).toHaveLength(1));
  expect(flush).toHaveBeenCalledTimes(1);
});

test("the status bar pill shows a found release and opens Settings", async () => {
  core(status({ checks: true, offer: OFFER, canInstall: true }));
  const onOpen = vi.fn();
  render(<UpdatePill onOpen={onOpen} />);
  expect(screen.queryByRole("button")).toBeNull();
  await act(() => loadUpdates());
  await userEvent.click(screen.getByRole("button", { name: "Update 1.0.1" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("no pill when this copy is up to date", async () => {
  core(status({ checks: true }));
  render(<UpdatePill onOpen={() => {}} />);
  await act(() => loadUpdates());
  expect(screen.queryByRole("button")).toBeNull();
});

test("pendingWork lists what a restart would lose", () => {
  const object = {
    kind: "object",
    key: "t1",
    selection: { connectionId: "c1", path: { database: "shop", schema: null, name: "orders" } },
  } as never;
  const query = { kind: "query", doc: { name: "Monthly totals", savedId: "s1", text: "select 2", savedText: "select 1" } } as never;
  const transfer = { kind: "transfer", id: "x", seed: {}, title: "pos_live to analytics", dirty: true } as never;
  expect(pendingWork({ tabs: [object, query, transfer], isDirty: (k) => k === "t1", flows: ["sales"], jobsRunning: true })).toEqual([
    "Pending Edits in orders",
    "Monthly totals, not saved",
    "pos_live to analytics, set up but not run",
    "sales.flow, still saving",
    "A running job",
  ]);
  expect(pendingWork({ tabs: [object], isDirty: () => false, flows: [], jobsRunning: false })).toEqual([]);
});

/** The update copy follows the copy rules: no em or en dashes, never "cursor" or "caret". */
test("update copy has no dashes and never says cursor or caret", () => {
  const sources = Object.values(
    import.meta.glob(["./*.ts", "./*.tsx", "../settings/sections/UpdatesSection.tsx", "../api/updates.ts", "!./*.test.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  );
  expect(sources.length).toBeGreaterThanOrEqual(6);
  for (const text of sources) {
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\b(cursor|caret)\b/i);
  }
  for (const text of [UPDATES_PRIVACY, RESTART_ASK]) expect(text).not.toMatch(/[–—]|cursor|caret/i);
});

test("Settings > Updates: the Last check row reads, checks, fails with Try again, then shows the result", async () => {
  let reply: ((s: UpdateStatus) => void) | null = null;
  let check: ((s: UpdateStatus) => void) | null = null;
  routeInvoke({
    update_status: () => new Promise<UpdateStatus>((ok) => (reply = ok)),
    check_for_update: () => new Promise<UpdateStatus>((ok) => (check = ok)),
  });
  render(<UpdatesSection />);
  // Before the Core answers: reading, and Check now waits.
  expect(await screen.findByText("Reading...")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(true);
  const failed = status({ checks: false, lastCheckMs: Date.UTC(2026, 9, 23, 9, 30), lastResult: { kind: "failed", message: "Contura could not reach github.com." } });
  await act(async () => reply!(failed));
  // A failed check is an error with Try again.
  const error = await screen.findByText(/Contura could not reach github\.com\.$/);
  expect(error.closest("[role=alert]")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Checking GitHub...")).toBeTruthy();
  expect(callsTo("check_for_update")).toEqual([{ manual: true }]);
  await act(async () => check!({ ...failed, lastResult: { kind: "upToDate" } }));
  expect(await screen.findByText(/Contura is up to date\.$/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
});
