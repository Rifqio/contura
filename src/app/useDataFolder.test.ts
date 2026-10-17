import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { useDataFolder } from "./useDataFolder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDataFolder", () => {
  it("reads_the_data_folder_only_while_settings_is_shown", async () => {
    routeInvoke({ data_folder_info: () => ({ path: "C:\\data" }) });
    const { result, rerender } = renderHook(({ shown }) => useDataFolder(shown), { initialProps: { shown: false } });
    expect(result.current).toBe("");
    expect(callsTo("data_folder_info")).toHaveLength(0);
    rerender({ shown: true });
    await waitFor(() => expect(result.current).toBe("C:\\data"));
    expect(callsTo("data_folder_info")).toHaveLength(1);
  });
});
