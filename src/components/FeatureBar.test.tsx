import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { featureGroups, LATER, PG_BACKUP } from "../app/features";
import FeatureBar, { featureTip } from "./FeatureBar";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // Nothing kept.
  }
});

const deps = (open: boolean, postgres = false) => ({
  target: open ? { connectionId: "c1", database: "shop", schema: null } : null,
  postgres,
  table: false,
  keys: { newQuery: "Ctrl+T", diagram: "Ctrl+Alt+N", ask: "Ctrl+Alt+I" },
  askReady: true,
  newQuery: vi.fn(),
  newVisualQuery: vi.fn(),
  newTable: vi.fn(),
  importInto: vi.fn(),
  exportTable: vi.fn(),
  transfer: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  compare: vi.fn(),
  newModel: vi.fn(),
  newDiagram: vi.fn(),
  history: vi.fn(),
  ask: vi.fn(),
});

test("item_16_every_feature_in_its_group_with_a_large_icon_and_its_name", () => {
  const d = deps(true);
  const f = featureGroups(d);
  render(<FeatureBar groups={f.groups} end={f.end} />);
  const bar = screen.getByRole("toolbar", { name: "Features" });
  const groups = within(bar).getAllByRole("group").map((g) => within(g).getAllByRole("button").map((b) => b.getAttribute("aria-label")));
  expect(groups).toEqual([
    ["New query", "Visual Query"],
    ["Table", "View", "Function"],
    ["Import", "Export", "Transfer"],
    ["Back up", "Restore"],
    ["Compare", "Model", "Diagram"],
    ["History"],
  ]);
  // Ask at the right end, after the groups.
  const all = within(bar).getAllByRole("button");
  expect(all[all.length - 1].getAttribute("aria-label")).toBe("Ask");
  // Each draws its own 28 px icon and its name.
  const query = within(bar).getByRole("button", { name: "New query" });
  expect(query.querySelector("svg.feature-icon")?.getAttribute("data-feature")).toBe("query");
  expect(query.querySelector("svg")?.getAttribute("width")).toBe("28");
  expect(query.textContent).toBe("New query");
  expect(query.getAttribute("data-tip")).toBe("New query (Ctrl+T)");
});

test("item_16_buttons_run_their_feature_and_later_ones_say_so", async () => {
  const d = deps(true);
  const f = featureGroups(d);
  render(<FeatureBar groups={f.groups} end={f.end} />);
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  expect(d.newDiagram).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(d.newTable).toHaveBeenCalledTimes(1);
  const view = screen.getByRole("button", { name: "View" });
  expect(view.getAttribute("aria-disabled")).toBe("true");
  expect(view.getAttribute("data-tip")).toBe(`View: ${LATER}`);
  expect(screen.getByRole("button", { name: "Function" }).getAttribute("aria-disabled")).toBe("true");
});

test("back_up_restore_and_compare_run_on_the_open_database", async () => {
  const d = deps(true);
  const f = featureGroups(d);
  render(<FeatureBar groups={f.groups} end={f.end} />);
  for (const name of ["Back up", "Restore", "Compare"]) {
    const b = screen.getByRole("button", { name });
    expect(b.getAttribute("aria-disabled")).not.toBe("true");
    expect(b.getAttribute("data-tip")).not.toContain(LATER);
    await userEvent.click(b);
  }
  expect(d.backup).toHaveBeenCalledTimes(1);
  expect(d.restore).toHaveBeenCalledTimes(1);
  expect(d.compare).toHaveBeenCalledTimes(1);
});

test("back_up_on_postgres_says_to_use_a_schema_and_the_others_still_run", async () => {
  const d = deps(true, true);
  const f = featureGroups(d);
  render(<FeatureBar groups={f.groups} end={f.end} />);
  const backup = screen.getByRole("button", { name: "Back up" });
  expect(backup.getAttribute("aria-disabled")).toBe("true");
  expect(backup.getAttribute("data-tip")).toBe(`Back up: ${PG_BACKUP}`);
  await userEvent.click(backup);
  expect(d.backup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(d.restore).toHaveBeenCalledTimes(1);
});

test("back_up_restore_and_compare_need_an_open_connection", () => {
  const f = featureGroups(deps(false));
  render(<FeatureBar groups={f.groups} end={f.end} />);
  for (const name of ["Back up", "Restore", "Compare"]) {
    expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
  }
});

test("item_16_with_nothing_open_the_connection_features_say_why", async () => {
  const d = deps(false);
  const f = featureGroups(d);
  render(<FeatureBar groups={f.groups} end={f.end} />);
  const vq = screen.getByRole("button", { name: "Visual Query" });
  expect(vq.getAttribute("data-tip")).toBe("Visual Query: Open a Connection first");
  await userEvent.click(vq);
  expect(d.newVisualQuery).not.toHaveBeenCalled();
  // New query works without a Connection.
  await userEvent.click(screen.getByRole("button", { name: "New query" }));
  expect(d.newQuery).toHaveBeenCalledTimes(1);
});

test("item_16_right_click_hides_the_labels_and_the_choice_is_kept", async () => {
  const f = featureGroups(deps(true));
  const { unmount } = render(<FeatureBar groups={f.groups} end={f.end} />);
  const bar = screen.getByRole("toolbar", { name: "Features" });
  fireEvent.contextMenu(bar, { clientX: 10, clientY: 10 });
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show labels" }));
  expect(bar.className).toContain("is-compact");
  expect(screen.getByRole("button", { name: "New query" }).textContent).toBe("");
  unmount();
  render(<FeatureBar groups={f.groups} end={f.end} />);
  expect(screen.getByRole("toolbar", { name: "Features" }).className).toContain("is-compact");
});

test("a_tip_without_a_key_is_just_the_words", () => {
  expect(featureTip({ id: "model", label: "Model", tip: "New Schema Model" })).toBe("New Schema Model");
});

/** At the minimum window width the groups clip inside their own box; Ask stays and the rest is under More. */
test("parity_P11_36_ask_stays_reachable_and_the_overflow_moves_into_more", async () => {
  const user = userEvent.setup();
  const groupsOf = () => Array.from(document.querySelectorAll<HTMLElement>(".feature-groups .feature-button"));
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("feature-groups") ? 500 : 0;
  });
  const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return Math.max(0, groupsOf().indexOf(this)) * 70;
  });
  const wide = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("feature-button") ? 64 : 0;
  });
  try {
    const d = deps(true);
    const f = featureGroups(d);
    render(<FeatureBar groups={f.groups} end={f.end} />);
    const bar = screen.getByRole("toolbar", { name: "Features" });
    // Ask is outside the clipped groups, at the right end.
    const ask = within(bar).getByRole("button", { name: "Ask" });
    expect(ask.closest(".feature-groups")).toBeNull();
    await user.click(ask);
    expect(d.ask).toHaveBeenCalledTimes(1);
    // The seven that fit stay; the rest are hidden in the strip and listed under More.
    expect(groupsOf().filter((b) => !b.hasAttribute("data-overflow")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "New query",
      "Visual Query",
      "Table",
      "View",
      "Function",
      "Import",
      "Export",
    ]);
    await user.click(within(bar).getByRole("button", { name: "More features" }));
    const menu = screen.getByRole("menu", { name: "More features" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.querySelector(".menu-label")?.textContent)).toEqual([
      "Transfer",
      "Back up",
      "Restore",
      "Compare",
      "Model",
      "Diagram",
      "History",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: /Diagram/ }));
    expect(d.newDiagram).toHaveBeenCalledTimes(1);
  } finally {
    width.mockRestore();
    left.mockRestore();
    wide.mockRestore();
  }
});

test("parity_P11_36_no_more_button_while_everything_fits", () => {
  // A laid-out box exactly as wide as the last button's right edge: everything fits. Two pixels less and the last
  // button moves into More, so this test fails if the fit check is off by more than its 1 px rounding allowance.
  const groupsOf = () => Array.from(document.querySelectorAll<HTMLElement>(".feature-groups .feature-button"));
  let slack = 0;
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("feature-groups") ? (groupsOf().length - 1) * 70 + 64 + slack : 0;
  });
  const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return Math.max(0, groupsOf().indexOf(this)) * 70;
  });
  const wide = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("feature-button") ? 64 : 0;
  });
  try {
    const f = featureGroups(deps(true));
    const fits = render(<FeatureBar groups={f.groups} end={f.end} />);
    expect(groupsOf().length).toBeGreaterThan(1);
    expect(groupsOf().filter((b) => b.hasAttribute("data-overflow"))).toEqual([]);
    expect(screen.queryByRole("button", { name: "More features" })).toBeNull();
    fits.unmount();
    slack = -2;
    render(<FeatureBar groups={f.groups} end={f.end} />);
    expect(groupsOf().filter((b) => b.hasAttribute("data-overflow"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "More features" })).toBeTruthy();
  } finally {
    width.mockRestore();
    left.mockRestore();
    wide.mockRestore();
  }
});
