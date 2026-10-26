import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import flowTabCss from "../styles/flow-tab.css?raw";
import { callsTo, routeInvoke } from "../test/invoke";
import { resetIcons } from "./icons";
import IconPicker from "./IconPicker";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const INDEX = [
  ["aws-dynamodb", "aws", "DynamoDB"],
  ["aws-dynamodb-dax", "aws", "DynamoDB Accelerator"],
  ["aws-s3", "aws", "Simple Storage Service"],
  ["azure-cosmos-db", "azure", "Azure Cosmos DB"],
  ["dynamite", "lucide", "dynamite"],
  ["users", "lucide", "users"],
  ["brand-postgresql", "simple", "PostgreSQL"],
  ["gcp-bigquery", "gcp", "BigQuery"],
].map(([name, set, title]) => ({ name, set, title, licence: null }));

const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`;

beforeEach(() => {
  resetIcons();
  routeInvoke({ icon_index: () => INDEX, icon: ({ name }) => svg(name as string) });
});
afterEach(cleanup);

const names = () => screen.getAllByRole("option").map((o) => o.getAttribute("data-name"));

test("the_picker_searches_every_set_with_the_provider_prefix_first", async () => {
  render(<IconPicker onPick={() => {}} onCancel={() => {}} />);
  const search = screen.getByRole("searchbox", { name: "Search icons" });
  await waitFor(() => expect(screen.getAllByRole("option").length).toBe(INDEX.length));
  // Typing the start of a provider prefix puts every provider icon first (as completion after icon: does).
  await userEvent.type(search, "a");
  expect(names()).toEqual(["aws-dynamodb", "aws-dynamodb-dax", "aws-s3", "azure-cosmos-db", "brand-postgresql", "dynamite"]);
  // Every set is searched, and a match after the provider prefix counts.
  await userEvent.clear(search);
  await userEvent.type(search, "dyn");
  expect(names()).toEqual(["dynamite", "aws-dynamodb", "aws-dynamodb-dax"]);
  await userEvent.clear(search);
  await userEvent.type(search, "aws-dyn");
  expect(names()).toEqual(["aws-dynamodb", "aws-dynamodb-dax"]);
  // As the frame shows them: the typed provider prefix is left off the labels.
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["dynamodb", "dynamodb-dax"]);
  await userEvent.clear(search);
  await userEvent.type(search, "postgres");
  expect(names()).toEqual(["brand-postgresql"]);
  await userEvent.clear(search);
  await userEvent.type(search, "nothing like it");
  expect(screen.queryAllByRole("option")).toEqual([]);
  expect(screen.getByText('No icon matches "nothing like it".')).toBeTruthy();
});

test("a_4_column_grid_with_the_highlighted_match", async () => {
  const onPick = vi.fn();
  render(<IconPicker onPick={onPick} onCancel={() => {}} />);
  const search = screen.getByRole("searchbox", { name: "Search icons" });
  await userEvent.type(search, "aws-dyn");
  const grid = screen.getByRole("listbox", { name: "Icons" });
  expect(grid.classList.contains("icon-picker-grid")).toBe(true);
  expect(flowTabCss).toMatch(/\.icon-picker-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4, 1fr\);/);
  // The best match is highlighted and named to assistive tech.
  const first = within(grid).getAllByRole("option")[0];
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(first.classList.contains("is-active")).toBe(true);
  expect(search.getAttribute("aria-activedescendant")).toBe(first.id);
  // Arrows move the highlight; Enter picks it.
  fireEvent.keyDown(search, { key: "ArrowRight" });
  expect(within(grid).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("aws-dynamodb-dax");
});

test("each_tile_is_the_icon_as_an_image_and_only_shown_icons_load", async () => {
  render(<IconPicker initial="aws-s" onPick={() => {}} onCancel={() => {}} />);
  await waitFor(() => expect(screen.getByRole("option").querySelector("img")).not.toBeNull());
  const img = screen.getByRole("option").querySelector("img")!;
  expect(img.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
  expect(document.querySelector(".icon-picker svg title")).toBeNull();
  // Only icons the grid shows are fetched.
  expect(new Set(callsTo("icon").map((a) => a.name))).not.toContain("users");
});

test("a_click_picks_and_escape_cancels", async () => {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  render(<IconPicker onPick={onPick} onCancel={onCancel} />);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search icons" }), "users");
  await userEvent.click(screen.getByRole("option"));
  expect(onPick).toHaveBeenCalledWith("users");
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search icons" }), { key: "Escape" });
  expect(onCancel).toHaveBeenCalled();
});

test("an_unreadable_index_says_so", async () => {
  routeInvoke({ icon_index: () => Promise.reject({ kind: "file", message: "the icon pack is damaged" }) });
  render(<IconPicker onPick={() => {}} onCancel={() => {}} />);
  expect(await screen.findByText("Couldn't read the icon list.")).toBeTruthy();
});

test("the_picker_tiles_draw_bare", async () => {
  render(<IconPicker onPick={() => {}} onCancel={() => {}} />);
  await waitFor(() => expect(screen.getAllByRole("option").length).toBe(INDEX.length));
  const tiles = [...document.querySelectorAll(".icon-picker-tile")];
  expect(tiles.length).toBe(INDEX.length);
  expect(tiles.filter((t) => !t.classList.contains("is-bare"))).toEqual([]);
});
