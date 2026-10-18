import { invoke } from "@tauri-apps/api/core";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { JobEvent } from "../api/types";
import { JobsProvider, useJobs } from "./useJobs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const wrapper = ({ children }: { children: ReactNode }) => <JobsProvider>{children}</JobsProvider>;
const warning: JobEvent = { kind: "warning", message: "w" };

test("track_before_start_then_events_reach_the_view_and_watchers", () => {
  const { result } = renderHook(() => useJobs(), { wrapper });
  let onEvent: (e: JobEvent) => void = () => {};
  act(() => {
    onEvent = result.current.track("j1", "export", "Exporting orders", "c1");
  });
  expect(result.current.jobs.map((j) => j.id)).toEqual(["j1"]);
  const seen: JobEvent[] = [];
  let stop = () => {};
  act(() => {
    stop = result.current.watch("j1", (e) => seen.push(e));
  });
  act(() => onEvent(warning));
  expect(result.current.jobs[0].warnings).toEqual(["w"]);
  expect(seen).toEqual([warning]);
  stop();
  act(() => onEvent(warning));
  expect(seen).toHaveLength(1);
  act(() => result.current.background("j1"));
  expect(result.current.jobs[0].background).toBe(true);
  act(() => result.current.dismiss("j1"));
  expect(result.current.jobs).toEqual([]);
});

test("cancel_calls_cancel_job", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const { result } = renderHook(() => useJobs(), { wrapper });
  await act(() => result.current.cancel("j1"));
  expect(invoke).toHaveBeenCalledWith("cancel_job", { job: "j1" });
});
