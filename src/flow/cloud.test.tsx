// Cloud diagrams in the flow tab: service tiles with the packed
// icons, nested group areas, the dotted line, the unknown-icon problem, the icon picker, Group and Icon credits.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import flowTabCss from "../styles/flow-tab.css?raw";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";
import { resetIcons } from "./icons";
import { linkBox } from "./interactions/geometry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => resetIcons());
afterEach(cleanup);

/** The cloud diagram. */
const PLATFORM = [
  'diagram cloud "Order API"',
  "Users [icon: users]",
  "Production [icon: aws-vpc] {",
  "  API Gateway [icon: aws-api-gateway]",
  "  Functions {",
  "    GET handler [icon: aws-lambda]",
  "    Authorizer [icon: aws-lambda]",
  "  }",
  "  Data {",
  "    Orders [icon: aws-dynamodb]",
  "  }",
  "  Role [icon: aws-iam-role]",
  "}",
  "Users > API Gateway: HTTPS",
  "GET handler > Orders: reads",
  "Authorizer ..> Role: assumes",
  "",
].join("\n");

const INDEX = ["users", "aws-vpc", "aws-api-gateway", "aws-lambda", "aws-dynamodb", "aws-iam-role", "aws-s3", "aws-cloudwatch", "database"].map((name) => ({
  name,
  set: name.startsWith("aws-") ? "aws" : "lucide",
  title: name,
  licence: null,
}));

const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>${name}</title></svg>`;

function setup(text = PLATFORM) {
  routeInvoke({
    read_diagram: () => ({ text, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    icon_index: () => INDEX,
    icon: ({ name }) => {
      if (!INDEX.some((e) => e.name === name)) throw { kind: "notFound", message: `${name as string} is not an icon` };
      return svg(name as string);
    },
    icon_sets: () => [{ id: "aws", title: "AWS Architecture Icons", licence: "AWS terms", source: "https://aws.amazon.com/architecture/icons/", note: "", notice: "" }],
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="platform" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string) => fireEvent.keyDown(canvasEl(), { key });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  return { ...utils, client, view, text: () => view().state.doc.toString(), node, press, strip };
}

type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, label = "Service Users") {
  await waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
}

const decoded = (img: Element) => {
  const src = img.getAttribute("src") ?? "";
  return decodeURIComponent(src.slice(src.indexOf(",") + 1));
};

test("a_48px_tile_shows_the_icon_unchanged_with_the_name_under_it", async () => {
  const s = setup();
  await drawn(s);
  const users = s.node("Service Users")!;
  await waitFor(() => expect(users.querySelector(".fnode-tile img")).not.toBeNull());
  const tile = users.querySelector(".fnode-tile") as HTMLElement;
  // The icon's own file, as an image from a data: URL; nothing of it is put into the page as markup.
  expect(tile.querySelector("img")!.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
  expect(decoded(tile.querySelector("img")!)).toBe(svg("users"));
  expect(s.container.querySelector(".react-flow__node svg title")).toBeNull();
  expect(tile.nextElementSibling?.classList.contains("fnode-name")).toBe(true);
  expect(tile.nextElementSibling?.textContent).toBe("Users");
  // No icon sits on a plate: general and provider icons both draw bare.
  expect(tile.classList.contains("fnode-tile-bare")).toBe(true);
  const gateway = s.node("Service API Gateway")!;
  await waitFor(() => expect(gateway.querySelector(".fnode-tile img")).not.toBeNull());
  expect(gateway.querySelector(".fnode-tile")!.classList.contains("fnode-tile-bare")).toBe(true);
  expect(decoded(gateway.querySelector(".fnode-tile img")!)).toBe(svg("aws-api-gateway"));
});

test("opening_a_diagram_loads_only_the_icons_it_uses", async () => {
  const s = setup();
  await drawn(s);
  await waitFor(() => expect(s.node("Service Role")!.querySelector("img")).not.toBeNull());
  const asked = callsTo("icon").map((a) => a.name as string);
  // Each icon once, and only the ones the diagram names: aws-s3, aws-cloudwatch and database are never read.
  expect(new Set(asked)).toEqual(new Set(["users", "aws-vpc", "aws-api-gateway", "aws-lambda", "aws-dynamodb", "aws-iam-role"]));
  expect(asked.length).toBe(6);
  // The index (names only) is read once, for the unknown-icon check and completion.
  expect(callsTo("icon_index")).toHaveLength(1);
});

test("nested_groups_draw_as_tinted_areas_with_labels", async () => {
  const s = setup();
  await drawn(s);
  const area = (name: string) => s.container.querySelector(`.flow-area[aria-label="Group ${name}"]`) as HTMLElement;
  for (const g of ["Production", "Functions", "Data"]) {
    expect(area(g)).not.toBeNull();
    expect(area(g).querySelector(".flow-area-name")?.textContent).toBe(g);
  }
  // The outer group is dashed; the groups inside it have a solid edge.
  expect(area("Production").classList.contains("is-inner")).toBe(false);
  expect(area("Functions").classList.contains("is-inner")).toBe(true);
  expect(area("Data").classList.contains("is-inner")).toBe(true);
  // A group's own icon sits before its label, as an image.
  await waitFor(() => expect(area("Production").querySelector("img.flow-area-icon")).not.toBeNull());
  expect(decoded(area("Production").querySelector("img")!)).toBe(svg("aws-vpc"));
  // The frame's group pair: the teal edge and its tint at 70 percent.
  expect(flowTabCss).toMatch(/\.flow-area\s*\{[^}]*border:\s*1px dashed var\(--c-group-teal\);[^}]*background:\s*color-mix\(in srgb, var\(--c-group-teal-tint\) 70%, transparent\);/);
  // A group with no icon of its own shows the 16 px group-colour square before its label.
  expect(area("Functions").querySelector(".flow-area-swatch")).not.toBeNull();
  expect(area("Production").querySelector(".flow-area-swatch")).toBeNull();
  expect(flowTabCss).toMatch(/\.flow-area-swatch\s*\{[^}]*width:\s*16px;[^}]*background:\s*var\(--c-group-teal\);/);
  expect(flowTabCss).toMatch(/\.flow-area\.is-inner\s*\{[^}]*border-style:\s*solid;/);
});

test("a_group_whose_icon_is_missing_shows_the_swatch_as_the_export_does", async () => {
  const s = setup(['diagram cloud "x"', "Edge [icon: aws-nothing] {", "  Users [icon: users]", "}", ""].join("\n"));
  await drawn(s, "Service Users");
  const area = s.container.querySelector('.flow-area[aria-label="Group Edge"]') as HTMLElement;
  await waitFor(() => expect(area.querySelector(".flow-area-swatch")).not.toBeNull());
  expect(area.querySelector("img")).toBeNull();
});

test("the_dotted_line_draws_dotted_with_its_label", async () => {
  const s = setup();
  await drawn(s);
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__edge")).toHaveLength(3));
  const dotted = s.container.querySelectorAll(".react-flow__edge.flow-line-dotted");
  expect(dotted).toHaveLength(1);
  // An "assumes" line is a permission, not data: dotted, with no arrowhead.
  expect(dotted[0].querySelector("path.react-flow__edge-path")?.getAttribute("marker-end")).toBeNull();
  const solid = [...s.container.querySelectorAll(".react-flow__edge")].filter((e) => !e.classList.contains("flow-line-dotted"));
  for (const e of solid) expect(e.querySelector("path.react-flow__edge-path")?.getAttribute("marker-end")).toBeTruthy();
  expect([...s.container.querySelectorAll(".flow-chip")].map((c) => c.textContent)).toContain("assumes");
  expect(flowTabCss).toMatch(/\.flow-line\.flow-line-dotted \.react-flow__edge-path\s*\{[^}]*stroke-dasharray:/);
});

test("lines_and_ports_meet_a_service_s_48px_tile", () => {
  // The node is 104 px wide with the name under the tile: lines route to the tile, centred at the top.
  expect(linkBox("service", { x: 100, y: 40, w: 104, h: 72 })).toEqual({ x: 128, y: 40, w: 48, h: 48 });
  expect(linkBox("dfd", { x: 100, y: 40, w: 168, h: 52 })).toEqual({ x: 100, y: 40, w: 168, h: 52 });
  expect(flowTabCss).toMatch(/\.react-flow__node-service \.react-flow__handle\.fnode-handle\[data-side="b"\]\s*\{[^}]*top:\s*48px;/);
});

test("an_unknown_icon_shows_the_dashed_cube_tile_and_the_problem", async () => {
  const s = setup(['diagram cloud "Order API"', "Users [icon: users]", "Orders [icon: aws-dynamdb]", "Users > Orders", ""].join("\n"));
  await drawn(s);
  await waitFor(() => expect(s.node("Service Orders")!.querySelector(".fnode-tile-unknown")).not.toBeNull());
  expect(s.node("Service Orders")!.querySelector("img")).toBeNull();
  // The worker has the icon names, so the check runs and names the nearest icon.
  const problems = await screen.findByRole("region", { name: "Problems" });
  await waitFor(() => expect(within(problems).getByText("aws-dynamdb is not an icon. Did you mean aws-dynamodb?")).toBeTruthy());
  expect(within(problems).getByRole("button", { name: "Line 3" })).toBeTruthy();
  // A hint, not an error: the drawing stays current.
  expect(s.container.querySelector(".flow-canvas.is-stale")).toBeNull();
  await userEvent.click(within(problems).getByRole("button", { name: "Use aws-dynamodb" }));
  await waitFor(() => expect(s.text()).toContain("Orders [icon: aws-dynamodb]"));
  await waitFor(() => expect(s.node("Service Orders")!.querySelector(".fnode-tile img")).not.toBeNull());
});

test("choose_icon_from_the_strip_sets_the_icon_in_the_text", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.node("Service Users")!, { key: "Enter" });
  await userEvent.click(await within(s.strip()).findByRole("button", { name: "Choose icon" }));
  const picker = await screen.findByRole("dialog", { name: "Choose an icon" });
  const search = within(picker).getByRole("searchbox", { name: "Search icons" });
  expect(search.getAttribute("value") ?? (search as HTMLInputElement).value).toBe("users");
  await userEvent.clear(search);
  await userEvent.type(search, "aws-cloudw");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(s.text()).toContain("Users [icon: aws-cloudwatch]\n"));
  expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
});

test("add_a_service_opens_the_picker_for_it", async () => {
  const s = setup();
  await drawn(s);
  s.press("r");
  s.press("Enter");
  // The name opens first (diagram step 6); kept, the service has the board's default icon and its picker opens.
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new service" }), { key: "Enter" });
  await waitFor(() => expect(s.text()).toContain("Service [icon: aws-lambda]\n"));
  const picker = await screen.findByRole("dialog", { name: "Choose an icon" });
  await userEvent.type(within(picker).getByRole("searchbox", { name: "Search icons" }), "database");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(s.text()).toContain("Service [icon: database]\n"));
  // Esc on the picker leaves the new service as it is.
  s.press("r");
  s.press("Enter");
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new service" }), { key: "Enter" });
  await waitFor(() => expect(s.text()).toContain("Service 2 [icon: aws-lambda]\n"));
  const again = await screen.findByRole("dialog", { name: "Choose an icon" });
  fireEvent.keyDown(within(again).getByRole("searchbox", { name: "Search icons" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull());
  expect(s.text()).toContain("Service 2 [icon: aws-lambda]\n");
  // Focus is back on the canvas, so its keys work at once.
  expect(document.activeElement).toBe(s.container.querySelector(".flow-canvas"));
  fireEvent.keyDown(document.activeElement!, { key: "r" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new service" }), { key: "Enter" });
  await waitFor(() => expect(s.text()).toContain("Service 3 [icon: aws-lambda]\n"));
});

test("typing_icon_colon_in_the_text_opens_the_grid_picker", async () => {
  const s = setup();
  await drawn(s);
  const line = "Users [icon: users]";
  const at = s.text().indexOf(line) + line.length;
  // A new service typed on a new line, up to `icon:`.
  for (const ch of "\nCache [icon:") {
    const pos = s.view().state.selection.main.head === 0 ? at : s.view().state.selection.main.head;
    act(() => {
      s.view().dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + ch.length }, userEvent: "input.type" });
    });
  }
  const picker = await screen.findByRole("dialog", { name: "Choose an icon" });
  await userEvent.type(within(picker).getByRole("searchbox", { name: "Search icons" }), "aws-s3");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(s.text()).toContain("Users [icon: users]\nCache [icon: aws-s3\n"));
  expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
  // Typing goes on where it was: the editor has focus again, after the name.
  expect(s.view().hasFocus).toBe(true);
  expect(s.view().state.selection.main.head).toBe(s.text().indexOf("aws-s3") + "aws-s3".length);
});

test("group_that_cannot_be_written_says_why", async () => {
  const text = ['diagram cloud "Order API"', "Users [icon: users]", "Gateway [icon: aws-api-gateway]", "", "Users > Gateway", ""].join("\n");
  const s = setup(text);
  await drawn(s);
  fireEvent.keyDown(s.node("Service Gateway")!, { key: "Enter" });
  await waitFor(() => expect(within(s.strip()).getByText("Gateway")).toBeTruthy());
  // Gateway's line is typed away and the text has an error: the faded drawing still shows it, selected.
  const from = s.text().indexOf("Gateway [icon");
  act(() => {
    s.view().dispatch({ changes: { from, to: from + "Gateway [icon: aws-api-gateway]".length, insert: "Users >" } });
  });
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  s.press("g");
  s.press("Enter");
  expect(await within(s.strip()).findByText("Couldn't group these services. Fix the text first.")).toBeTruthy();
});

test("group_puts_the_selected_services_in_a_new_group_as_one_undo", async () => {
  const text = ['diagram cloud "Order API"', "Users [icon: users]", "Gateway [icon: aws-api-gateway]", "Lambda [icon: aws-lambda]", "", "Users > Gateway", ""].join("\n");
  const s = setup(text);
  await drawn(s);
  fireEvent.keyDown(s.node("Service Gateway")!, { key: "Enter" });
  await waitFor(() => expect(within(s.strip()).getByText("Gateway")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "Group" }));
  s.press("Enter");
  // C1: the new group's name opens in edit; Enter keeps it (diagram step 3).
  await userEvent.type(await screen.findByRole("textbox", { name: "Group name" }), "{Enter}");
  await waitFor(() => expect(s.text()).toContain("Group [icon: aws-vpc] {\n  Gateway [icon: aws-api-gateway]\n}\n"));
  await waitFor(() => expect(s.container.querySelector('.flow-area[aria-label="Group Group"]')).not.toBeNull());
  // One undo takes the whole change back.
  const { undo } = await import("@codemirror/commands");
  act(() => {
    undo(s.view());
  });
  expect(s.text()).toBe(text);
});

test("group_with_nothing_selected_says_what_it_needs", async () => {
  const s = setup();
  await drawn(s);
  s.press("g");
  s.press("Enter");
  expect(await within(s.strip()).findByText("Select the services to group first.")).toBeTruthy();
  expect(s.text()).toBe(PLATFORM);
});

test("icon_credits_opens_the_credits", async () => {
  const s = setup();
  await drawn(s);
  await userEvent.click(within(s.strip()).getByRole("button", { name: "Icon credits" }));
  const dialog = await screen.findByRole("dialog", { name: "Icon credits" });
  expect(await within(dialog).findByRole("region", { name: "AWS Architecture Icons" })).toBeTruthy();
});
