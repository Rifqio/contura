import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { keysFromEvent, normalizeKeys, pressedKeys, toCodeMirror, whilePressed } from "./keys";
import { applyRebind, findClash, hintFor, keyProblem, keysFor, resetCommand, resolveKeymap } from "./keymap";
import { COMMANDS, type CommandId } from "./registry";
import { KeymapProvider, useCommandKeys, useKeymap } from "./useCommandKeys";
import { fireEvent, render } from "@testing-library/react";
import CellEditor from "../components/CellEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

test("normalize_orders_modifiers", () => {
  expect(normalizeKeys("shift+ctrl+enter")).toBe("Ctrl+Shift+Enter");
  expect(normalizeKeys("ctrl+,")).toBe("Ctrl+,");
  expect(normalizeKeys("alt+shift+f")).toBe("Shift+Alt+F");
  expect(normalizeKeys("alt+arrowup")).toBe("Alt+ArrowUp");
  expect(normalizeKeys("f5")).toBe("F5");
});

test("keys_from_event_use_the_physical_key", () => {
  expect(keysFromEvent(ev({ ctrlKey: true, shiftKey: true, code: "KeyF", key: "F" }))).toBe("Ctrl+Shift+F");
  expect(keysFromEvent(ev({ ctrlKey: true, code: "Digit1", key: "1" }))).toBe("Ctrl+1");
  expect(keysFromEvent(ev({ shiftKey: true, code: "ShiftLeft", key: "Shift" }))).toBeNull();
  expect(keysFromEvent(ev({ ctrlKey: true, altKey: true, code: "KeyI", key: "ˆ" }))).toBe("Ctrl+Alt+I");
  expect(keysFromEvent(ev({ key: "F5", code: "F5" }))).toBe("F5");
  expect(keysFromEvent(ev({ ctrlKey: true, key: "," , code: "Comma" }))).toBe("Ctrl+,");
});

test("altgr_never_makes_a_ctrl_alt_command", () => {
  // Windows sends AltGr as Ctrl+Alt; on a German layout AltGr+7 types "{", so it must reach the field.
  const altGr = (init: KeyboardEventInit) => {
    const e = ev(init);
    e.getModifierState = (k: string) => k === "AltGraph";
    return e;
  };
  expect(keysFromEvent(altGr({ ctrlKey: true, altKey: true, code: "Digit7", key: "{" }))).toBeNull();
  expect(keysFromEvent(altGr({ ctrlKey: true, altKey: true, code: "KeyI", key: "i" }))).toBeNull();
  // The same keys without AltGr are the command's keys.
  expect(keysFromEvent(ev({ ctrlKey: true, altKey: true, code: "Digit7", key: "7" }))).toBe("Ctrl+Alt+7");
});

test("to_code_mirror", () => {
  expect(toCodeMirror("Ctrl+Shift+Enter")).toBe("Ctrl-Shift-Enter");
  expect(toCodeMirror("Shift+Alt+F")).toBe("Shift-Alt-f");
  expect(toCodeMirror("Ctrl+,")).toBe("Ctrl-,");
  expect(toCodeMirror("F5")).toBe("F5");
});

test("default_keys_are_unique_per_scope", () => {
  for (const scope of ["app", "editor"] as const) {
    // New chat shares Ctrl+N with New Connection: it runs only with focus in the Ask panel.
    const keys = COMMANDS.filter((c) => c.scope === scope && c.id !== "assistant.newChat").flatMap((c) => c.keys);
    expect(new Set(keys).size).toBe(keys.length);
  }
  // Every default is already in its printed form.
  for (const c of COMMANDS) for (const k of c.keys) expect(normalizeKeys(k)).toBe(k);
});

test("the_registry_has_the_defaults", () => {
  const map = resolveKeymap({});
  expect(keysFor(map, "query.run")).toEqual(["Ctrl+Enter"]);
  expect(keysFor(map, "editor.quickFix")).toEqual(["Ctrl+.", "Alt+Enter"]);
  // Edge: Ctrl+1 to Ctrl+8 go to that tab, Ctrl+9 to the last. Groups moved to Ctrl+Alt+1 to 9.
  for (let n = 1; n <= 9; n++) expect(keysFor(map, `tab.goto.${n}` as CommandId)).toEqual([`Ctrl+${n}`]);
  expect(keysFor(map, "group.open.9")).toEqual(["Ctrl+Alt+9"]);
  expect(keysFor(map, "group.open.1")).toEqual(["Ctrl+Alt+1"]);
  expect(keysFor(map, "tab.next")).toEqual(["Ctrl+Tab", "Ctrl+PageDown"]);
  expect(keysFor(map, "tab.previous")).toEqual(["Ctrl+Shift+Tab", "Ctrl+PageUp"]);
  // S12: Ctrl+N in the Ask panel is a new chat (VS Code Chat); Ctrl+Shift+N stays the first key.
  expect(keysFor(map, "assistant.newChat")).toEqual(["Ctrl+Shift+N", "Ctrl+N"]);
  expect(keysFor(map, "connection.new")).toEqual(["Ctrl+N"]);
  expect(hintFor(map, "settings.open")).toBe("Ctrl+,");
  expect(hintFor(map, "query.explain")).toBeNull();
  expect(hintFor(map, "history.toggle")).toBeNull();
});

test("find_clash_names_the_other_command", () => {
  const map = resolveKeymap({});
  expect(findClash(map, "query.run", "Ctrl+T")).toEqual({ kind: "command", id: "query.new", title: "New query" });
  expect(findClash(map, "query.new", "Ctrl+T")).toBeNull();
  expect(findClash(map, "query.run", "Ctrl+Q")).toBeNull();
});

test("ctrl_n_shared_by_new_connection_and_new_chat_is_not_a_clash", () => {
  const map = resolveKeymap({});
  expect(findClash(map, "assistant.newChat", "Ctrl+N")).toBeNull();
  expect(findClash(map, "connection.new", "Ctrl+N")).toBeNull();
  expect(findClash(map, "query.new", "Ctrl+N")).toEqual({ kind: "command", id: "connection.new", title: "New Connection" });
});

test("find_clash_names_the_editor_key", () => {
  const map = resolveKeymap({});
  expect(findClash(map, "query.run", "Ctrl+Z")).toEqual({ kind: "editor", title: "Undo" });
  expect(findClash(map, "query.run", "Shift+Alt+ArrowDown")).toEqual({ kind: "editor", title: "Copy line down" });
});

test("key_problem_rules", () => {
  expect(keyProblem("A")).toBe("Choose keys with Ctrl, Alt or Shift, or a function key.");
  expect(keyProblem("Tab")).toBe("Tab and Escape cannot be shortcuts.");
  expect(keyProblem("Escape")).toBe("Tab and Escape cannot be shortcuts.");
  expect(keyProblem("Shift+A")).toBe("Choose keys with Ctrl, Alt or Shift, or a function key.");
  expect(keyProblem("F5")).toBeNull();
  expect(keyProblem("Ctrl+Tab")).toBeNull();
  expect(keyProblem("Shift+Enter")).toBeNull();
});

test("confirming_a_clash_moves_the_keys", () => {
  const map = resolveKeymap({});
  expect(applyRebind({}, map, "query.run", "Ctrl+T")).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  // A command with two keys keeps the one not taken.
  expect(applyRebind({}, map, "query.run", "Alt+Enter")).toEqual({
    "query.run": ["Alt+Enter"],
    "editor.quickFix": ["Ctrl+."],
  });
  const moved = resolveKeymap(applyRebind({}, map, "query.run", "Ctrl+T"));
  expect(keysFor(moved, "query.run")).toEqual(["Ctrl+T"]);
  expect(keysFor(moved, "query.new")).toEqual([]);
});

test("reset_removes_the_override", () => {
  const o = { "query.run": ["Ctrl+T"], "query.new": [] };
  expect(resetCommand(o, "query.run")).toEqual({ "query.new": [] });
  expect(o).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  expect(keysFor(resolveKeymap(resetCommand(o, "query.run")), "query.run")).toEqual(["Ctrl+Enter"]);
});

test("unknown_ids_in_overrides_are_ignored", () => {
  const map = resolveKeymap({ "no.such": ["Ctrl+Q"], "query.save": ["ctrl+shift+s"] });
  expect([...map.keys()]).toEqual(COMMANDS.map((c) => c.id));
  expect(keysFor(map, "query.save")).toEqual(["Ctrl+Shift+S"]);
});

describe("useCommandKeys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("runs_app_commands_and_prevents_every_registry_key", () => {
    const onNew = vi.fn();
    renderHook(() => useCommandKeys({ "query.new": onNew }));
    const t = ev({ ctrlKey: true, key: "t", code: "KeyT" });
    window.dispatchEvent(t);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(t.defaultPrevented).toBe(true);
    // F5 has no handler here, yet WebView2 must never reload.
    const f5 = ev({ key: "F5", code: "F5" });
    window.dispatchEvent(f5);
    expect(f5.defaultPrevented).toBe(true);
    const plain = ev({ key: "a", code: "KeyA" });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  test("skips_keys_already_handled_and_editor_commands", () => {
    const onNew = vi.fn();
    const onRun = vi.fn();
    renderHook(() => useCommandKeys({ "query.new": onNew, "query.run": onRun }));
    const t = ev({ ctrlKey: true, key: "t", code: "KeyT" });
    t.preventDefault();
    window.dispatchEvent(t);
    expect(onNew).not.toHaveBeenCalled();
    window.dispatchEvent(ev({ ctrlKey: true, key: "Enter", code: "Enter" }));
    expect(onRun).not.toHaveBeenCalled();
  });

  test("an_open_dialog_holds_the_commands", () => {
    const toggle = vi.fn();
    renderHook(() => useCommandKeys({ "assistant.toggle": toggle }));
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    const e = ev({ ctrlKey: true, altKey: true, key: "i", code: "KeyI" });
    window.dispatchEvent(e);
    expect(toggle).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  test("the_latest_handler_for_a_command_wins_and_unmount_removes_it", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useCommandKeys({ "tree.filter": outer }));
    const { unmount } = renderHook(() => useCommandKeys({ "tree.filter": inner }));
    const f = () => window.dispatchEvent(ev({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }));
    f();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    unmount();
    f();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  const filterKey = () => {
    const e = ev({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" });
    window.dispatchEvent(e);
    return e;
  };
  const pane = (parent: HTMLElement = document.body) => {
    const el = document.createElement("div");
    parent.appendChild(el);
    return el;
  };
  const focusIn = (el: HTMLElement) => {
    const input = document.createElement("input");
    el.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
  };

  test("a_focused_owner_wins_over_a_later_visible_one", () => {
    const focused = vi.fn();
    const visible = vi.fn();
    const a = pane();
    const b = pane();
    focusIn(a);
    renderHook(() => useCommandKeys({ "tree.filter": focused }, { region: { current: a } }));
    renderHook(() => useCommandKeys({ "tree.filter": visible }, { region: { current: b } }));
    filterKey();
    expect(focused).toHaveBeenCalledTimes(1);
    expect(visible).not.toHaveBeenCalled();
  });

  test("the_innermost_focused_owner_wins", () => {
    const inner = vi.fn();
    const outer = vi.fn();
    const out = pane();
    const inn = pane(out);
    focusIn(inn);
    renderHook(() => useCommandKeys({ "tree.filter": inner }, { region: { current: inn } }));
    renderHook(() => useCommandKeys({ "tree.filter": outer }, { region: { current: out } }));
    filterKey();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  test("a_visible_owner_wins_over_a_later_owner_in_a_hidden_pane", () => {
    const visible = vi.fn();
    const hidden = vi.fn();
    const shown = pane();
    const cover = pane();
    cover.hidden = true;
    const under = pane(cover);
    renderHook(() => useCommandKeys({ "tree.filter": visible }, { region: { current: shown } }));
    renderHook(() => useCommandKeys({ "tree.filter": hidden }, { region: { current: under } }));
    filterKey();
    expect(visible).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();
  });

  test("with_focus_in_neither_a_preferred_owner_on_screen_wins_whatever_the_order", () => {
    // Ctrl+Shift+N with focus on the board canvas, the Ask panel and the board pane both on screen:
    // the focused region wins, else the board pane (it says so with `preferWhenShown`), not the latest registered.
    for (const boardFirst of [true, false]) {
      const board = vi.fn();
      const ask = vi.fn();
      const boardPane = pane();
      const askPane = pane();
      focusIn(pane());
      const mount = [
        () => renderHook(() => useCommandKeys({ "tree.filter": board }, { region: { current: boardPane }, preferWhenShown: true })),
        () => renderHook(() => useCommandKeys({ "tree.filter": ask }, { region: { current: askPane } })),
      ];
      const hooks = (boardFirst ? mount : [...mount].reverse()).map((m) => m());
      filterKey();
      expect(board, `board first: ${boardFirst}`).toHaveBeenCalledTimes(1);
      expect(ask).not.toHaveBeenCalled();
      // Focus in the Ask panel: it wins.
      focusIn(askPane);
      filterKey();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(board).toHaveBeenCalledTimes(1);
      for (const h of hooks) h.unmount();
    }
  });

  test("an_owner_in_a_hidden_pane_never_runs_and_the_key_is_still_kept_from_the_browser", () => {
    const hidden = vi.fn();
    const cover = pane();
    cover.hidden = true;
    const under = pane(cover);
    focusIn(pane());
    renderHook(() => useCommandKeys({ "tree.filter": hidden }, { region: { current: under } }));
    const e = filterKey();
    expect(hidden).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  test("a_region_owner_wins_over_a_global_owner_registered_later", () => {
    const owner = vi.fn();
    const global = vi.fn();
    const shown = pane();
    renderHook(() => useCommandKeys({ "tree.filter": owner }, { region: { current: shown } }));
    renderHook(() => useCommandKeys({ "tree.filter": global }));
    filterKey();
    expect(owner).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  test("ctrl_n_is_new_chat_with_focus_in_the_ask_panel_and_new_connection_elsewhere", () => {
    const newChat = vi.fn();
    const newConnection = vi.fn();
    const panel = pane();
    renderHook(() => useCommandKeys({ "connection.new": newConnection }));
    renderHook(() => useCommandKeys({ "assistant.newChat": newChat }, { region: { current: panel } }));
    const ctrlN = () => window.dispatchEvent(ev({ ctrlKey: true, key: "n", code: "KeyN" }));
    ctrlN();
    expect(newConnection).toHaveBeenCalledTimes(1);
    expect(newChat).not.toHaveBeenCalled();
    focusIn(panel);
    ctrlN();
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(newConnection).toHaveBeenCalledTimes(1);
  });

  test("an_open_dialog_still_holds_a_region_command", () => {
    const owner = vi.fn();
    const shown = pane();
    focusIn(shown);
    renderHook(() => useCommandKeys({ "tree.filter": owner }, { region: { current: shown } }));
    const dialog = pane();
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const e = filterKey();
    expect(owner).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("KeymapProvider", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(KeymapProvider, null, children);
  const stored = { "query.new": ["Ctrl+Q"] };

  test("a_save_before_the_load_goes_over_the_stored_overrides_and_the_load_never_replaces_it", async () => {
    let answer: (v: unknown) => void = () => {};
    routeInvoke({ keymap: () => new Promise((r) => (answer = r)), save_keymap: () => null });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save({ "query.run": ["F9"] });
    });
    expect(callsTo("save_keymap")).toEqual([]);
    await act(async () => {
      answer(stored);
      await saving;
    });
    const merged = { "query.new": ["Ctrl+Q"], "query.run": ["F9"] };
    expect(callsTo("save_keymap")).toEqual([{ overrides: merged }]);
    expect(result.current.overrides).toEqual(merged);
    expect(keysFor(result.current.map, "query.run")).toEqual(["F9"]);
  });

  test("a_save_after_the_load_replaces_the_overrides", async () => {
    routeInvoke({ keymap: () => stored, save_keymap: () => null });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(result.current.overrides).toEqual(stored));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.run": ["F9"] } }]);
    expect(result.current.overrides).toEqual({ "query.run": ["F9"] });
  });

  test("a_save_after_a_failed_load_reads_again_first", async () => {
    let reads = 0;
    routeInvoke({
      keymap: () => {
        if (reads++ === 0) throw { kind: "storage", message: "no" };
        return stored;
      },
      save_keymap: () => null,
    });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("keymap")).toHaveLength(2);
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.new": ["Ctrl+Q"], "query.run": ["F9"] } }]);
  });

  test("a_save_when_the_keymap_stays_unreadable_saves_what_was_asked", async () => {
    routeInvoke({
      keymap: () => {
        throw { kind: "storage", message: "no" };
      },
      save_keymap: () => null,
    });
    const { result } = renderHook(() => useKeymap(), { wrapper });
    await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
    await act(() => result.current.save({ "query.run": ["F9"] }));
    expect(callsTo("save_keymap")).toEqual([{ overrides: { "query.run": ["F9"] } }]);
  });

  test("an_open_dialog_holds_a_command_run_from_an_editor_and_editor_ids_never_reach_app_handlers", () => {
    routeInvoke({ keymap: () => ({}), save_keymap: () => null });
    const onNew = vi.fn();
    const onRun = vi.fn();
    const { result } = renderHook(
      () => {
        useCommandKeys({ "query.new": onNew, "query.run": onRun });
        return useKeymap();
      },
      { wrapper },
    );
    expect(result.current.run("query.run")).toBe(false);
    expect(onRun).not.toHaveBeenCalled();
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(result.current.run("query.new")).toBe(true);
    expect(onNew).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    expect(result.current.run("query.new")).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

test("export_and_mermaid_are_app_commands_and_ctrl_e_has_no_clash", () => {
  const map = resolveKeymap({});
  expect(COMMANDS.find((x) => x.id === "export.open")).toMatchObject({
    title: "Export...",
    keys: ["Ctrl+E"],
    scope: "app",
  });
  expect(COMMANDS.find((x) => x.id === "flow.fromMermaid")).toMatchObject({
    title: "New flow from Mermaid",
    keys: [],
    scope: "app",
  });
  expect(findClash(map, "export.open", "Ctrl+E")).toBeNull();
  expect(hintFor(map, "export.open")).toBe("Ctrl+E");
});

test("visual_query_keys_are_app_commands_without_a_clash", () => {
  const map = resolveKeymap({});
  const want = [
    ["visualQuery.openInEditor", "Open the SQL in the editor", "Ctrl+Shift+E"],
    ["diagram.toggle", "Show or hide the diagram", "Ctrl+Shift+D"],
  ] as const;
  for (const [id, title, key] of want) {
    const c = COMMANDS.find((x) => x.id === id)!;
    expect(c).toMatchObject({ title, keys: [key], scope: "app" });
    expect(findClash(map, id, key)).toBeNull();
  }
  // Item 35: Visual Query adds tables by drag only; Ctrl+Shift+A is not a Visual Query key.
  expect(COMMANDS.some((c) => (c.id as string) === "visualQuery.addTable")).toBe(false);
});

test("diagram_file_commands_and_ctrl_alt_n_has_no_clash", () => {
  const map = resolveKeymap({});
  const want = [
    ["flow.new", "New diagram", ["Ctrl+Alt+N"]],
    ["flow.saveCopy", "Save a copy as...", []],
    ["flow.rename", "Rename diagram", []],
    ["flow.delete", "Delete diagram", []],
  ] as const;
  for (const [id, title, keys] of want) {
    expect(COMMANDS.find((x) => x.id === id)).toMatchObject({ title, keys, scope: "app" });
  }
  expect(findClash(map, "flow.new", "Ctrl+Alt+N")).toBeNull();
  expect(hintFor(map, "flow.new")).toBe("Ctrl+Alt+N");
});

test("quick_open_and_the_command_palette_are_rebindable_registry_commands", () => {
  const map = resolveKeymap({});
  // VS Code Ctrl+P; Ctrl+K as in Edge, and "Ctrl K searches tables" (requirements).
  expect(COMMANDS.find((c) => c.id === "quickOpen.show")).toMatchObject({ keys: ["Ctrl+P", "Ctrl+K"], scope: "app", category: "View" });
  expect(COMMANDS.find((c) => c.id === "palette.show")).toMatchObject({ keys: ["Ctrl+Shift+P"], scope: "app", category: "View" });
  for (const k of ["Ctrl+P", "Ctrl+K"]) expect(findClash(map, "quickOpen.show", k)).toBeNull();
  expect(findClash(map, "palette.show", "Ctrl+Shift+P")).toBeNull();
  const moved = resolveKeymap(applyRebind({}, map, "palette.show", "Ctrl+Alt+P"));
  expect(keysFor(moved, "palette.show")).toEqual(["Ctrl+Alt+P"]);
  // F1 opens Help in Windows apps: not bound.
  expect(COMMANDS.some((c) => c.keys.includes("F1"))).toBe(false);
});

test("every_command_has_a_category_for_the_palette", () => {
  const known = new Set(["Query", "Editor", "AI", "Tabs", "View", "Connection", "Tree", "Groups", "Data", "Visual Query", "Diagram"]);
  for (const c of COMMANDS) expect(known.has(c.category), c.id).toBe(true);
  const cat = (id: CommandId) => COMMANDS.find((c) => c.id === id)!.category;
  expect(cat("query.new")).toBe("Query");
  expect(cat("history.toggle")).toBe("Query");
  expect(cat("editor.rename")).toBe("Editor");
  expect(cat("editor.ask")).toBe("AI");
  expect(cat("assistant.toggle")).toBe("AI");
  expect(cat("tab.goto.3")).toBe("Tabs");
  expect(cat("home.open")).toBe("View");
  expect(cat("pane.next")).toBe("View");
  expect(cat("group.open.2")).toBe("Groups");
  expect(cat("tree.refresh")).toBe("Tree");
  expect(cat("export.open")).toBe("Data");
  expect(cat("diagram.toggle")).toBe("Visual Query");
  expect(cat("flow.new")).toBe("Diagram");
});

describe("the palette's view of the commands", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("ctrl_p_never_reaches_the_webview_even_when_nothing_has_it", async () => {
    routeInvoke({ keymap: () => ({ "quickOpen.show": ["Ctrl+K"], "palette.show": [] }), save_keymap: () => null });
    const { result } = renderHook(() => useKeymap(), { wrapper: ({ children }: { children: ReactNode }) => createElement(KeymapProvider, null, children) });
    await waitFor(() => expect(keysFor(result.current.map, "quickOpen.show")).toEqual(["Ctrl+K"]));
    for (const shiftKey of [false, true]) {
      const e = ev({ ctrlKey: true, shiftKey, key: "p", code: "KeyP" });
      window.dispatchEvent(e);
      // WebView2 prints on Ctrl+P and Ctrl+Shift+P (print preview): never.
      expect(e.defaultPrevented).toBe(true);
    }
  });

  test("a_command_is_available_while_an_owner_can_run_it", () => {
    const { result } = renderHook(() => useKeymap());
    expect(result.current.available("tree.filter")).toBe(false);
    const cover = document.createElement("div");
    document.body.append(cover);
    const under = document.createElement("div");
    cover.append(under);
    const hook = renderHook(() => useCommandKeys({ "tree.filter": vi.fn() }, { region: { current: under } }));
    expect(result.current.available("tree.filter")).toBe(true);
    // In a hidden pane it cannot run, so the palette hides it.
    cover.hidden = true;
    expect(result.current.available("tree.filter")).toBe(false);
    hook.unmount();
  });

  test("invoke_runs_editor_commands_for_the_palette_while_keys_never_do", () => {
    const onRun = vi.fn();
    const { result } = renderHook(() => {
      useCommandKeys({ "query.run": onRun });
      return useKeymap();
    });
    window.dispatchEvent(ev({ ctrlKey: true, key: "Enter", code: "Enter" }));
    expect(onRun).not.toHaveBeenCalled();
    expect(result.current.run("query.run")).toBe(false);
    expect(result.current.available("query.run")).toBe(true);
    expect(result.current.invoke("query.run")).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(result.current.invoke("query.runAll")).toBe(false);
  });

  test("a_palette_only_owner_never_takes_a_key", () => {
    const keyed = vi.fn();
    const palette = vi.fn();
    const { result } = renderHook(() => {
      useCommandKeys({ "query.save": keyed });
      useCommandKeys({ "query.save": palette }, { paletteOnly: true });
      return useKeymap();
    });
    window.dispatchEvent(ev({ ctrlKey: true, key: "s", code: "KeyS" }));
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(palette).not.toHaveBeenCalled();
    // The palette runs the latest owner, the editor's.
    expect(result.current.invoke("query.save")).toBe(true);
    expect(palette).toHaveBeenCalledTimes(1);
  });
});

describe("the print keys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("reach_their_commands_and_never_print_with_focus_in_a_cell_editor", () => {
    const quick = vi.fn();
    const palette = vi.fn();
    renderHook(() => useCommandKeys({ "quickOpen.show": quick, "palette.show": palette }));
    const { container } = render(<CellEditor initial="paid" multiline={false} onCommit={vi.fn()} onCancel={vi.fn()} />);
    const cell = container.querySelector("textarea")!;
    // The cell editor stops every key; fireEvent answers false when the default was prevented.
    expect(fireEvent.keyDown(cell, { key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(cell, { key: "k", code: "KeyK", ctrlKey: true })).toBe(false);
    expect(quick).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(cell, { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(palette).toHaveBeenCalledTimes(1);
  });

  test("run_once_from_anywhere_else", () => {
    const quick = vi.fn();
    renderHook(() => useCommandKeys({ "quickOpen.show": quick }));
    expect(fireEvent.keyDown(document.body, { key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
    expect(quick).toHaveBeenCalledTimes(1);
  });

  test("a_box_that_owns_its_keys_gets_them_but_never_prints", () => {
    const quick = vi.fn();
    const own = vi.fn();
    renderHook(() => useCommandKeys({ "quickOpen.show": quick }));
    const { container } = render(<input data-keys-own="" onKeyDown={own} />);
    expect(fireEvent.keyDown(container.querySelector("input")!, { key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
    expect(own).toHaveBeenCalledTimes(1);
    expect(quick).not.toHaveBeenCalled();
  });
});

test("step_8_follow_a_key_and_back_forward_are_app_commands_without_a_clash", () => {
  const map = resolveKeymap({});
  const want = [
    ["grid.followKey", "Go to referenced row", ["F4", "Ctrl+B"]],
    ["grid.rowsPointingHere", "Rows that point here", ["Alt+F7"]],
    ["nav.back", "Back", ["Alt+ArrowLeft", "Ctrl+Alt+ArrowLeft"]],
    ["nav.forward", "Forward", ["Alt+ArrowRight", "Ctrl+Alt+ArrowRight"]],
  ] as const;
  for (const [id, title, keys] of want) {
    expect(COMMANDS.find((x) => x.id === id)).toMatchObject({ title, keys, scope: "app" });
    for (const k of keys) expect(findClash(map, id, k)).toBeNull();
  }
  expect(hintFor(map, "grid.followKey")).toBe("F4");
  expect(hintFor(map, "grid.rowsPointingHere")).toBe("Alt+F7");
  // DBeaver's Alt+Space is not bound: on Windows it opens the window's system menu.
  expect(COMMANDS.some((c) => c.keys.includes("Alt+Space"))).toBe(false);
});

test("moving_a_column_has_dbeavers_keys_without_a_clash", () => {
  const map = resolveKeymap({});
  const want = [
    ["grid.moveColumnLeft", "Move column left", ["Shift+Alt+ArrowLeft"]],
    ["grid.moveColumnRight", "Move column right", ["Shift+Alt+ArrowRight"]],
  ] as const;
  for (const [id, title, keys] of want) {
    expect(COMMANDS.find((x) => x.id === id)).toMatchObject({ title, keys, scope: "app", category: "Data" });
    for (const k of keys) expect(findClash(map, id, k)).toBeNull();
  }
  // Rebindable like the other grid keys: an override takes their place.
  expect(hintFor(resolveKeymap({ "grid.moveColumnLeft": ["Ctrl+Shift+ArrowLeft"] }), "grid.moveColumnLeft")).toBe("Ctrl+Shift+ArrowLeft");
});

test("a_handler_knows_which_keys_ran_it", () => {
  const seen: (string | null)[] = [];
  const { unmount } = renderHook(() => useCommandKeys({ "nav.back": () => void seen.push(pressedKeys()) }));
  window.dispatchEvent(ev({ ctrlKey: true, altKey: true, key: "ArrowLeft", code: "ArrowLeft" }));
  window.dispatchEvent(ev({ altKey: true, key: "ArrowLeft", code: "ArrowLeft" }));
  expect(seen).toEqual(["Ctrl+Alt+ArrowLeft", "Alt+ArrowLeft"]);
  // Outside a key press (the palette runs a command), there are none.
  expect(pressedKeys()).toBeNull();
  expect(whilePressed("F4", () => pressedKeys())).toBe("F4");
  expect(pressedKeys()).toBeNull();
  unmount();
});
