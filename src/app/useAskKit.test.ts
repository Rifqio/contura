import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import type { AskContext } from "../assistant/context";
import type { Place } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { useAskKit } from "./useAskKit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const view = (inlineAsk: boolean, errorAsk: boolean) => ({ settings: { inlineAsk, errorAsk } });
const seed: { question: string; context: AskContext } = {
  question: "why?",
  context: { connection: null, tables: [] } as unknown as AskContext,
};
const ungrouped: Place = { kind: "ungrouped" };
const noConnections: ConnectionConfig[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

function setup(over: Record<string, unknown> = {}) {
  const openPanel = vi.fn();
  const openAiSettings = vi.fn();
  const props = {
    groupId: null as string | null,
    settingsActive: false,
    activeKey: "a" as string | null,
    place: ungrouped,
    connections: noConnections,
    openPanel,
    openAiSettings,
    ...over,
  };
  const hook = renderHook((p: typeof props) => useAskKit(p), { initialProps: props });
  return { ...hook, props, openPanel, openAiSettings };
}

describe("useAskKit", () => {
  it("reads_the_groups_ask_settings_and_not_while_settings_is_shown", async () => {
    routeInvoke({ ai_settings: (a) => (a.groupId === "g1" ? view(false, false) : view(true, true)) });
    const { result, rerender, props } = setup({ settingsActive: true });
    expect(callsTo("ai_settings")).toHaveLength(0);
    expect(result.current.askKit).toMatchObject({ groupId: null, inlineAsk: true, errorAsk: true });
    rerender({ ...props, settingsActive: false, groupId: "g1" });
    await waitFor(() => expect(result.current.askKit).toMatchObject({ groupId: "g1", inlineAsk: false, errorAsk: false }));
    expect(callsTo("ai_settings")).toEqual([{ groupId: "g1" }]);
  });

  it("open_in_chat_seeds_and_opens_the_panel", async () => {
    routeInvoke({ ai_settings: () => view(true, true) });
    const { result, openPanel, openAiSettings } = setup();
    expect(result.current.chatSeed).toBeUndefined();
    act(() => result.current.askKit.onOpenInChat!(seed));
    expect(result.current.chatSeed).toEqual(seed);
    expect(result.current.chatSeed).not.toBe(seed);
    expect(openPanel).toHaveBeenCalledTimes(1);
    act(() => result.current.askKit.onOpenSettings());
    expect(openAiSettings).toHaveBeenCalledTimes(1);
  });

  it("the_seed_ends_when_the_tab_or_the_place_changes", async () => {
    routeInvoke({ ai_settings: () => view(true, true) });
    const { result, rerender, props } = setup();
    act(() => result.current.askKit.onOpenInChat!(seed));
    expect(result.current.chatSeed).toBeDefined();
    rerender({ ...props, activeKey: "b" });
    expect(result.current.chatSeed).toBeUndefined();
    act(() => result.current.askKit.onOpenInChat!(seed));
    rerender({ ...props, activeKey: "b", place: { kind: "group", groupId: "g" } });
    expect(result.current.chatSeed).toBeUndefined();
  });

  it("the_seed_ends_when_connections_change", async () => {
    routeInvoke({ ai_settings: () => view(true, true) });
    const { result, rerender, props } = setup();
    act(() => result.current.askKit.onOpenInChat!(seed));
    // A new array, so the reference differs; the contents do not matter.
    rerender({ ...props, connections: [] });
    expect(result.current.chatSeed).toBeUndefined();
  });

  it("the_seed_ends_when_settings_is_shown", async () => {
    routeInvoke({ ai_settings: () => view(true, true) });
    const { result, rerender, props } = setup();
    act(() => result.current.askKit.onOpenInChat!(seed));
    rerender({ ...props, settingsActive: true });
    expect(result.current.chatSeed).toBeUndefined();
  });

  it("ask_kit_keeps_its_identity_between_draws", async () => {
    routeInvoke({ ai_settings: () => view(true, true) });
    const { result, rerender, props } = setup();
    // Let the settings load land first: it replaces the settings object once.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const first = result.current.askKit;
    const openPanel = vi.fn();
    rerender({ ...props, openPanel, openAiSettings: vi.fn(), activeKey: "a" });
    expect(result.current.askKit).toBe(first);
    act(() => result.current.askKit.onOpenInChat!(seed));
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(props.openPanel).not.toHaveBeenCalled();
  });
});
