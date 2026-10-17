import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { routeInvoke } from "../test/invoke";
import { useConnectionLifecycle } from "./useConnectionLifecycle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conn: ConnectionConfig = {
  id: "a",
  name: "Shop",
  dialect: "postgres",
  host: "h",
  port: 1,
  user: "u",
  database: null,
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

function setup() {
  const onClosed = vi.fn();
  const onLost = vi.fn();
  const hook = renderHook(() => useConnectionLifecycle({ connections: [conn], onClosed, onLost }));
  return { ...hook, onClosed, onLost };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useConnectionLifecycle", () => {
  it("open_tracked_says_connecting_then_marks_open_with_the_version", async () => {
    let release: (v: string) => void = () => {};
    const pending = new Promise<string>((r) => (release = r));
    routeInvoke({ open_connection: () => pending });
    const { result } = setup();
    let done!: Promise<void>;
    act(() => {
      done = result.current.openTracked("a");
    });
    expect(result.current.openStatus.get("a")).toEqual({ s: "connecting" });
    await act(async () => {
      release("16.4");
      await done;
    });
    expect(result.current.openStatus.has("a")).toBe(false);
    expect(result.current.openIds.has("a")).toBe(true);
    expect(result.current.versions.get("a")).toBe("16.4");
  });

  it("open_tracked_failure_says_failed_with_the_reason_and_rethrows", async () => {
    routeInvoke({
      open_connection: () => {
        throw { kind: "connect", message: "refused" };
      },
    });
    const { result } = setup();
    let failure: unknown;
    await act(async () => {
      await result.current.openTracked("a").catch((e) => (failure = e));
    });
    expect(failure).toEqual({ kind: "connect", message: "refused" });
    await waitFor(() => expect(result.current.openStatus.get("a")?.s).toBe("failed"));
    const status = result.current.openStatus.get("a");
    expect(status).toEqual({ s: "failed", error: expect.stringMatching(/^Could not connect: refused/) });
    expect(result.current.openIds.has("a")).toBe(false);
  });

  it("mark_opened_without_a_version_keeps_no_version", () => {
    const { result } = setup();
    act(() => result.current.markOpened("a", null));
    expect(result.current.openIds.has("a")).toBe(true);
    expect(result.current.versions.has("a")).toBe(false);
  });

  it("mark_closed_drops_status_version_and_open_id_then_calls_on_closed", () => {
    const { result, onClosed } = setup();
    act(() => {
      result.current.markOpened("a", "16.4");
      result.current.setStatus("a", { s: "connecting" });
    });
    act(() => result.current.markClosed("a"));
    expect(result.current.openStatus.has("a")).toBe(false);
    expect(result.current.versions.has("a")).toBe(false);
    expect(result.current.openIds.has("a")).toBe(false);
    expect(onClosed).toHaveBeenCalledWith("a");
  });

  it("lost_closes_then_calls_on_lost", () => {
    const { result, onClosed, onLost } = setup();
    act(() => result.current.markOpened("a", "16.4"));
    act(() => result.current.lost("a"));
    expect(result.current.openIds.has("a")).toBe(false);
    expect(onClosed).toHaveBeenCalledWith("a");
    expect(onLost).toHaveBeenCalledWith("a");
  });

  it("set_status_null_for_an_unknown_id_keeps_the_same_map", () => {
    const { result } = setup();
    const before = result.current.openStatus;
    act(() => result.current.setStatus("nope", null));
    expect(result.current.openStatus).toBe(before);
  });
});
