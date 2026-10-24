import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, Group } from "../api/types";
import { DEFAULT_UI_PREFS } from "../api/types";
import PlaceSidebar from "../app/PlaceSidebar";
import { PrefsProvider, useUngroupedLabel } from "../prefs/usePrefs";
import { ToastProvider } from "./Toast";
import appCss from "../styles/app.css?raw";
import { callsTo, routeInvoke } from "../test/invoke";
import ConnectionForm from "./ConnectionForm";
import GroupSwitcher from "./GroupSwitcher";
import Home from "./Home";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "indigo", hasImage: false },
  { id: "g2", name: "Acme", color: "sky", hasImage: false },
];

function conn(id: string, name: string, groupId: string | null): ConnectionConfig {
  return {
    id, name, dialect: "mysql", host: "127.0.0.1", port: 3306, user: "root", database: null, ssl: { mode: "disable" },
    file: null, queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false, groupId,
  };
}

const connections = [conn("a", "kfc-prod", "g1"), conn("c", "laragon", null)];

/** The Core's own checks, as the mocked save_group. */
function saveGroupLikeCore(input: Record<string, unknown>) {
  const { id, name, color } = (input as { input: { id: string; name: string; color: string } }).input;
  if (groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
    throw { kind: "invalidInput", message: `A Group is already named ${name}. Pick another name.` };
  }
  return { id, name, color, hasImage: false };
}

function prefsRoutes(stored: Record<string, unknown> = {}) {
  let prefs = { ...DEFAULT_UI_PREFS, ...stored };
  routeInvoke({
    suggested_connections: () => [],
    ui_prefs: () => prefs,
    save_ui_prefs: (a) => {
      prefs = a.prefs as typeof prefs;
    },
    save_group: saveGroupLikeCore,
  });
}

function home(onChanged = vi.fn()) {
  render(
    <PrefsProvider>
      <Home
        groups={groups}
        connections={connections}
        openIds={new Set()}
        recent={[]}
        onOpenGroup={vi.fn()}
        onOpenConnection={vi.fn()}
        onOpenUngrouped={vi.fn()}
        onOpenRecent={vi.fn()}
        onChanged={onChanged}
        onShowAllHistory={vi.fn()}
      />
    </PrefsProvider>,
  );
  return onChanged;
}

function sidebar(group: Group | undefined, onRenamed = vi.fn()) {
  render(
    <PrefsProvider>
      <PlaceSidebar
        group={group}
        groups={groups}
        placeName={group?.name ?? "Ungrouped"}
        hidden={false}
        empty={false}
        notice={null}
        onEditGroup={vi.fn()}
        onRenamed={onRenamed}
        onNewConnection={vi.fn()}
      >
        <div />
      </PlaceSidebar>
    </PrefsProvider>,
  );
  return onRenamed;
}

const heading = (name: string) => screen.getByRole("heading", { name });

/** Home's card menu: Rename (S9: a click on the name opens the place, so renaming is F2 or this). */
async function renameFromCardMenu(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `Group actions for ${name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
}

test("sidebar: double-click renames a Group, Enter saves it with its colour", async () => {
  prefsRoutes();
  const onRenamed = sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  const input = screen.getByRole("textbox", { name: "Rename KFC" }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(3);
  await userEvent.keyboard("Kentucky{Enter}");
  await waitFor(() => expect(onRenamed).toHaveBeenCalled());
  expect(callsTo("save_group")[0]).toEqual({ input: { id: "g1", name: "Kentucky", color: "indigo" } });
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("sidebar: blur saves and Esc cancels", async () => {
  prefsRoutes();
  const onRenamed = sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("Nope{Escape}");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(callsTo("save_group")).toHaveLength(0);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("Blurred");
  await userEvent.tab();
  await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
  expect(callsTo("save_group")[0]).toEqual({ input: { id: "g1", name: "Blurred", color: "indigo" } });
});

test("sidebar: a duplicate name (any case) is refused before saving and keeps editing", async () => {
  prefsRoutes();
  const onRenamed = sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("acme{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Group is already named acme. Pick another name.");
  expect(callsTo("save_group")).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: "Rename KFC" })).toBeTruthy();
  expect(onRenamed).not.toHaveBeenCalled();
});

test("sidebar: an empty Group name shows the Edit Group message", async () => {
  prefsRoutes();
  sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("{Backspace}{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("Give the Group a name, such as the client or project it is for.");
  expect(callsTo("save_group")).toHaveLength(0);
});

test("F2 on the focused header starts the rename", async () => {
  prefsRoutes();
  sidebar(groups[0]);
  heading("KFC").focus();
  await userEvent.keyboard("{F2}");
  expect(screen.getByRole("textbox", { name: "Rename KFC" })).toBeTruthy();
});

test("headers say how to rename and do not select their text", () => {
  prefsRoutes();
  sidebar(groups[0]);
  const h = heading("KFC");
  expect(h.getAttribute("title")).toBe("Double-click or press F2 to rename");
  expect(h.getAttribute("aria-keyshortcuts")).toBe("F2");
  expect(h.classList.contains("rename-label")).toBe(true);
  expect(/\.rename-label\s*\{[^}]*user-select:\s*none/.test(appCss)).toBe(true);
  cleanup();
  home();
  const open = screen.getByRole("button", { name: "Open KFC" });
  expect(open.getAttribute("title")).toBe("Press F2 to rename");
  expect(open.getAttribute("aria-keyshortcuts")).toBe("F2");
  expect(open.classList.contains("rename-label")).toBe(true);
});

test("the sidebar's second press of a double-click is kept from selecting text; a single press is not", () => {
  prefsRoutes();
  sidebar(groups[0]);
  const h = heading("KFC");
  expect(fireEvent.mouseDown(h, { detail: 1 })).toBe(true);
  expect(fireEvent.mouseDown(h, { detail: 2 })).toBe(false);
});

test("a Group cannot take the name Ungrouped goes by", async () => {
  prefsRoutes({ ungroupedLabel: "Loose ends" });
  sidebar(groups[0]);
  await waitFor(() => expect(callsTo("ui_prefs").length).toBeGreaterThan(0));
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("loose ends{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("That name is what Ungrouped is called. Pick another name.");
  expect(callsTo("save_group")).toHaveLength(0);
});

test("the Core's refusal is shown inline too", async () => {
  routeInvoke({
    suggested_connections: () => [],
    ui_prefs: () => DEFAULT_UI_PREFS,
    save_group: () => {
      throw { kind: "invalidInput", message: "A Group is already named Fresh. Pick another name." };
    },
  });
  sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("Fresh{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Group is already named Fresh. Pick another name.");
  expect(screen.getByRole("textbox", { name: "Rename KFC" })).toBeTruthy();
});

test("Home: the card menu's Rename renames a Group card; Esc cancels", async () => {
  prefsRoutes();
  const onChanged = home();
  await renameFromCardMenu("KFC");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Rename KFC" }));
  await userEvent.keyboard("Kentucky{Enter}");
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(callsTo("save_group")[0]).toEqual({ input: { id: "g1", name: "Kentucky", color: "indigo" } });
  await renameFromCardMenu("KFC");
  await userEvent.keyboard("Other{Escape}");
  expect(callsTo("save_group")).toHaveLength(1);
});

test("Home: a double-click on a card name opens the place and does not rename it (S9)", async () => {
  prefsRoutes();
  const onOpenGroup = vi.fn();
  render(
    <Home groups={groups} connections={connections} openIds={new Set()} recent={[]} onOpenGroup={onOpenGroup}
      onOpenConnection={vi.fn()} onOpenUngrouped={vi.fn()} onOpenRecent={vi.fn()} onChanged={vi.fn()} onShowAllHistory={vi.fn()} />,
  );
  await userEvent.dblClick(screen.getByRole("button", { name: "Open KFC" }));
  expect(onOpenGroup).toHaveBeenCalledTimes(1);
  expect(onOpenGroup).toHaveBeenCalledWith("g1");
  expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
});

test("Home: F2 on a card name renames it, and a duplicate is refused inline", async () => {
  prefsRoutes();
  home();
  screen.getByRole("button", { name: "Open KFC" }).focus();
  await userEvent.keyboard("{F2}acme{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Group is already named acme. Pick another name.");
});

test("Home: a single click opens the place at once", async () => {
  prefsRoutes();
  const onOpenGroup = vi.fn();
  render(
    <Home groups={groups} connections={connections} openIds={new Set()} recent={[]} onOpenGroup={onOpenGroup}
      onOpenConnection={vi.fn()} onOpenUngrouped={vi.fn()} onOpenRecent={vi.fn()} onChanged={vi.fn()} onShowAllHistory={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open KFC" }));
  // At once: no wait for a second click.
  expect(onOpenGroup).toHaveBeenCalledWith("g1");
});

test("Ungrouped label: renamed in the sidebar, it shows on Home, the switcher and the Connection form; Ungrouped restores it", async () => {
  prefsRoutes();
  // As in the Workspace, the sidebar is told the name Ungrouped goes by.
  function UngroupedSidebar() {
    const { label } = useUngroupedLabel();
    return (
      <PlaceSidebar group={undefined} groups={groups} placeName={label} hidden={false} empty={false} notice={null}
        onEditGroup={vi.fn()} onRenamed={vi.fn()} onNewConnection={vi.fn()}><div /></PlaceSidebar>
    );
  }
  const view = render(
    <PrefsProvider>
      <UngroupedSidebar />
      <Home groups={groups} connections={connections} openIds={new Set()} recent={[]} onOpenGroup={vi.fn()}
        onOpenConnection={vi.fn()} onOpenUngrouped={vi.fn()} onOpenRecent={vi.fn()} onChanged={vi.fn()} onShowAllHistory={vi.fn()} />
      <GroupSwitcher groups={groups} place={{ kind: "ungrouped" }} connectionCount={2} onHome={vi.fn()} onOpenGroup={vi.fn()}
        onOpenUngrouped={vi.fn()} onNewGroup={vi.fn()} onSettings={vi.fn()} />
      <ConnectionForm groups={groups} defaultGroupId={null} onSaved={vi.fn()} onCancel={vi.fn()} />
    </PrefsProvider>,
  );
  await userEvent.dblClick(heading("Ungrouped"));
  await userEvent.keyboard("Loose ends{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull());
  expect(callsTo("save_group")).toHaveLength(0);
  const last = () => callsTo("save_ui_prefs")[callsTo("save_ui_prefs").length - 1];
  expect(last()).toEqual({ prefs: { ...DEFAULT_UI_PREFS, ungroupedLabel: "Loose ends" } });
  // Sidebar header, Home card and summary, switcher trigger, and the form's Group picker.
  expect(heading("Loose ends")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Loose ends" })).toBeTruthy();
  expect(screen.getByText("2 Connections in 2 Groups, 1 Loose ends")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Switch Group, current / }).textContent).toContain("Loose ends");
  expect(within(screen.getByRole("dialog")).getByLabelText("Group").textContent).toContain("Loose ends");
  expect(screen.queryByText("Ungrouped")).toBeNull();
  // An empty name is refused; typing Ungrouped brings the default back, from the Home card this time.
  await renameFromCardMenu("Loose ends");
  await userEvent.keyboard("{Backspace}{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("Type a name. Ungrouped brings back the default.");
  await userEvent.keyboard("ungrouped{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull());
  expect(last()).toEqual({ prefs: { ...DEFAULT_UI_PREFS, ungroupedLabel: null } });
  expect(heading("Ungrouped")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ungrouped" })).toBeTruthy();
  view.unmount();
});

test("Ungrouped label: a name a Group already has (any case) is refused inline", async () => {
  prefsRoutes();
  sidebar(undefined);
  await userEvent.dblClick(heading("Ungrouped"));
  await userEvent.keyboard("kfc{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Group is already named kfc. Pick another name.");
  expect(screen.getByRole("textbox", { name: "Rename Ungrouped" })).toBeTruthy();
  expect(callsTo("save_ui_prefs")).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(heading("Ungrouped")).toBeTruthy();
});

test("a place switch while the sidebar title is edited cancels the edit, so Enter renames nothing", async () => {
  prefsRoutes();
  const props = { groups, hidden: false, empty: false, notice: null, onEditGroup: vi.fn(), onNewConnection: vi.fn() };
  const onRenamed = vi.fn();
  const view = render(
    <PrefsProvider>
      <PlaceSidebar {...props} group={groups[0]} placeName="KFC" onRenamed={onRenamed}><div /></PlaceSidebar>
    </PrefsProvider>,
  );
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("KFC Prod");
  view.rerender(
    <PrefsProvider>
      <PlaceSidebar {...props} group={groups[1]} placeName="Acme" onRenamed={onRenamed}><div /></PlaceSidebar>
    </PrefsProvider>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(heading("Acme")).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(callsTo("save_group")).toHaveLength(0);
  expect(callsTo("save_ui_prefs")).toHaveLength(0);
  expect(onRenamed).not.toHaveBeenCalled();
});

test("a save on blur leaves focus where the user clicked", async () => {
  prefsRoutes();
  const onRenamed = sidebar(groups[0]);
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("Kentucky");
  const elsewhere = screen.getByRole("button", { name: "New Connection" });
  await userEvent.click(elsewhere);
  await waitFor(() => expect(onRenamed).toHaveBeenCalled());
  await new Promise((r) => requestAnimationFrame(r));
  expect(document.activeElement).toBe(elsewhere);
});

test("a refused name on blur cancels the edit and says why, without taking focus back", async () => {
  prefsRoutes();
  render(
    <ToastProvider>
      <PrefsProvider>
        <PlaceSidebar group={groups[0]} groups={groups} placeName="KFC" hidden={false} empty={false} notice={null}
          onEditGroup={vi.fn()} onRenamed={vi.fn()} onNewConnection={vi.fn()}><div /></PlaceSidebar>
      </PrefsProvider>
    </ToastProvider>,
  );
  await userEvent.dblClick(heading("KFC"));
  await userEvent.keyboard("Acme");
  const elsewhere = screen.getByRole("button", { name: "New Connection" });
  await userEvent.click(elsewhere);
  expect((await screen.findByRole("status")).textContent).toContain("KFC keeps its name. A Group is already named Acme. Pick another name.");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(heading("KFC")).toBeTruthy();
  await new Promise((r) => requestAnimationFrame(r));
  expect(document.activeElement).toBe(elsewhere);
  expect(callsTo("save_group")).toHaveLength(0);
});

test("Home: Enter or Space on a card name opens the place at once", async () => {
  prefsRoutes();
  const onOpenGroup = vi.fn();
  const onOpenUngrouped = vi.fn();
  render(
    <Home groups={groups} connections={connections} openIds={new Set()} recent={[]} onOpenGroup={onOpenGroup}
      onOpenConnection={vi.fn()} onOpenUngrouped={onOpenUngrouped} onOpenRecent={vi.fn()} onChanged={vi.fn()} onShowAllHistory={vi.fn()} />,
  );
  screen.getByRole("button", { name: "Open KFC" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenGroup).toHaveBeenCalledWith("g1");
  screen.getByRole("button", { name: "Open Ungrouped" }).focus();
  await userEvent.keyboard(" ");
  expect(onOpenUngrouped).toHaveBeenCalledTimes(1);
});

test("Home: a mouse click opens at once, with nothing left pending once Home is gone", () => {
  prefsRoutes();
  vi.useFakeTimers();
  try {
    const onOpenGroup = vi.fn();
    const view = render(
      <Home groups={groups} connections={connections} openIds={new Set()} recent={[]} onOpenGroup={onOpenGroup}
        onOpenConnection={vi.fn()} onOpenUngrouped={vi.fn()} onOpenRecent={vi.fn()} onChanged={vi.fn()} onShowAllHistory={vi.fn()} />,
    );
    const name = screen.getByRole("button", { name: "Open KFC" });
    fireEvent.click(name, { detail: 1 });
    expect(onOpenGroup).toHaveBeenCalledWith("g1");
    view.unmount();
    vi.advanceTimersByTime(1000);
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("Ungrouped label: a Group's name is refused even when it is Ungrouped's own default", async () => {
  const withUngroupedGroup = [...groups, { id: "g3", name: "Ungrouped", color: "teal", hasImage: false } as Group];
  prefsRoutes({ ungroupedLabel: "Loose" });
  render(
    <PrefsProvider>
      <PlaceSidebar group={undefined} groups={withUngroupedGroup} placeName="Loose" hidden={false} empty={false} notice={null}
        onEditGroup={vi.fn()} onRenamed={vi.fn()} onNewConnection={vi.fn()}><div /></PlaceSidebar>
    </PrefsProvider>,
  );
  await userEvent.dblClick(heading("Loose"));
  await userEvent.keyboard("ungrouped{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Group is already named ungrouped. Pick another name.");
  expect(callsTo("save_ui_prefs")).toHaveLength(0);
});
