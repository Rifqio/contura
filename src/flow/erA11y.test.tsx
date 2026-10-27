// B3 Task 11: the accessibility pass over every ER control on a card (the boardA11y.test.tsx pattern): names and keyboard
// reach, focus rings in both themes, the copy rules, and reduced motion. jsdom applies no stylesheet and computes no
// style, so the rings are read from the CSS as text and the motion from the inline duration (R28, D8).
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ts from "typescript";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { EASE_IN, MOTION } from "../diagram/motion";
import { LangClient } from "../lang/client";
import { ER_NOTES } from "../lang/flow/edits";
import { parseFlow } from "../lang/flow/parse";
import canvasCss from "../styles/flow-canvas.css?raw";
import flowTabCss from "../styles/flow-tab.css?raw";
import tokensCss from "../styles/tokens.css?raw";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { columnMenuItems, shapeMenuItems } from "./canvasMenus";
import { ER_MESSAGES } from "./erCanvas";
import erCanvasSource from "./erCanvas.tsx?raw";
import { RELATE_MESSAGES } from "./erRelate";
import erRelateSource from "./erRelate.ts?raw";
import { buildFlowGraph } from "./flowNodes";
import FlowTab from "./FlowTab";
import flowTabSource from "./FlowTab.tsx?raw";
import kindNodesSource from "./kindNodes.tsx?raw";
import { shapesOf } from "./ShapePicker";
import useErRelateSource from "./useErRelate.ts?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

/** The test sets it: the file runs under reduced motion unless a test turns it off. */
let reduce = true;
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  reduce = true;
  cleanup();
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const ER = lines('diagram er "Billing"', "customers {", "  id int pk", "  email text not null", "}", "invoices {", "  id int pk", "  customer_id int", "  note text", "}");
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } });

function setup() {
  routeInvoke({ read_diagram: () => ({ text: ER, layout: LAYOUT }), write_diagram: () => null, write_diagram_layout: () => null });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="a11y" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Table ${table}"]`) as HTMLElement | null;
  const node = (table: string) => utils.container.querySelector(`.react-flow__node[data-id="${table}"]`) as HTMLElement;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const row = (table: string, column: string) =>
    [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  return { ...utils, card, node, strip, row };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup) {
  await waitFor(() => expect(s.card("invoices")).not.toBeNull(), { timeout: 4000 });
}

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });

/** The accessible name a control carries: its label, else its text, else its title. */
const nameOf = (el: HTMLElement) => (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("title") ?? "").trim();

/** Every item of an open menu is named; the menu holds the focus (a roving group: arrows move inside it). */
function namedMenu(menu: HTMLElement): string[] {
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  expect(items.length).toBeGreaterThan(0);
  for (const i of items) expect(nameOf(i), i.outerHTML.slice(0, 80)).not.toBe("");
  expect(menu.contains(document.activeElement)).toBe(true);
  return items.map(nameOf);
}

/** Moves the open menu's focus down to `label` with the arrow keys and picks it with Enter. */
async function menuPick(menu: HTMLElement, label: string) {
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const at = items.findIndex((i) => i.getAttribute("aria-label") === label || i.textContent?.startsWith(label));
  expect(at).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 40 && document.activeElement !== items[at]; i++) key("ArrowDown");
  expect(document.activeElement).toBe(items[at]);
  await userEvent.keyboard("{Enter}");
}

async function closeMenu() {
  key("Escape");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

test("every_er_control_is_named_and_reachable", async () => {
  const s = setup();
  await drawn(s);
  // The strip's one live region is there, empty, before anything is said (it is never inserted with its words).
  const live = within(s.strip()).getByRole("status");
  expect(live.textContent).toBe("");
  // The card: a node in the canvas's tab order, named by its table. Enter selects it, F2 opens the header's name field.
  const node = s.node("customers");
  expect(node.tabIndex).toBe(0);
  act(() => node.focus());
  key("Enter");
  await waitFor(() => expect(node.className).toContain("selected"));
  key("F2");
  const head = await screen.findByRole("textbox", { name: "Table name" });
  expect(s.card("customers")!.querySelector(".fkind-head")!.contains(head)).toBe(true);
  fireEvent.keyDown(head, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Table name" })).toBeNull());

  // The key gutter and "+ column": buttons, named, in the tab order.
  const card = s.card("customers")!;
  const guts = within(card).getAllByRole("button", { name: "Primary key" });
  expect(guts).toHaveLength(2);
  for (const g of guts) expect(g.tabIndex).toBe(0);
  const add = within(card).getByRole("button", { name: "Add column" });
  expect(add.tabIndex).toBe(0);

  // Tab steps from the selected card to its columns; F2 opens the column's name field, Tab its type field.
  act(() => node.focus());
  key("Tab");
  await waitFor(() => expect(s.row("customers", "id").className).toContain("is-selected"));
  key("F2");
  const name = await screen.findByRole("textbox", { name: "Column name" });
  await userEvent.type(name, "{Tab}");
  // The type field offers the types (its list), so it reads as a combobox.
  const type = await screen.findByRole("combobox", { name: "Column type" });
  expect(document.activeElement).toBe(type);
  // Its tab's own list (final review Minor 2).
  expect(document.getElementById(type.getAttribute("list") ?? "")?.tagName).toBe("DATALIST");
  fireEvent.keyDown(type, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Column type" })).toBeNull());

  // A hovered card shows its column ports: hidden from a screen reader, which reaches the row's menu by Shift+F10.
  fireEvent.pointerEnter(s.card("invoices")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.card("invoices")!.querySelectorAll(".fkind-port").length).toBeGreaterThan(0));
  for (const p of s.card("invoices")!.querySelectorAll(".fkind-port")) expect(p.getAttribute("aria-hidden"), p.outerHTML.slice(0, 80)).toBe("true");
  fireEvent.pointerLeave(s.card("invoices")!.querySelector(".fkind-head")!);

  // The column menu and the table menu, from the keyboard.
  act(() => s.node("invoices").focus());
  key("Enter");
  await waitFor(() => expect(s.node("invoices").className).toContain("selected"));
  key("Tab");
  key("Tab");
  await waitFor(() => expect(s.row("invoices", "customer_id").className).toContain("is-selected"));
  key("F10", { shiftKey: true });
  const columnMenu = await screen.findByRole("menu", { name: "invoices.customer_id actions" });
  expect(namedMenu(columnMenu)).toContain("Make a relationship from here");
  await closeMenu();
  // Esc lets the column go and keeps its table selected; Shift+F10 then opens the table's menu.
  key("Escape");
  await waitFor(() => expect(s.card("invoices")!.querySelector(".is-selected")).toBeNull());
  expect(s.node("invoices").className).toContain("selected");
  key("F10", { shiftKey: true });
  const tableMenu = await screen.findByRole("menu", { name: "invoices actions" });
  expect(namedMenu(tableMenu)).toContain("Add column");
  await closeMenu();

  // The pick: its prompt, its aim and its result each come into that same region, which stays mounted throughout.
  fireEvent.click(s.row("invoices", "customer_id"));
  await waitFor(() => expect(s.row("invoices", "customer_id").className).toContain("is-selected"));
  key("F10", { shiftKey: true });
  await menuPick(await screen.findByRole("menu", { name: "invoices.customer_id actions" }), "Make a relationship from here");
  const region = () => {
    const all = within(s.strip()).getAllByRole("status");
    expect(all).toEqual([live]);
    return live.textContent;
  };
  await waitFor(() => expect(region()).toContain(RELATE_MESSAGES.pick));
  expect(region()).toContain("Esc cancels.");
  key("ArrowDown");
  await waitFor(() => expect(region()).toContain("Aim: key of customers"));
  key("Tab");
  await waitFor(() => expect(region()).toContain("Aim: customers.id"));
  key("Enter");
  await waitFor(() => expect(region()).toBe("Linked invoices.customer_id > customers.id. Right-click the line to change it."));
  expect(s.container.querySelector(".is-pick")).toBeNull();
});

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/,\s*/g, ",\\s*");
  // After a rule's end, a comment's end or the start, so a longer selector ending the same never matches.
  const m = new RegExp(`(?:^|\\}|\\*/)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1];
}

/** The value of token `name` in each theme block of tokens.css: light, dark by attribute, dark by the system setting. */
function themed(name: string): string[] {
  const light = /:root, \.theme-light \{([\s\S]*?)\n\}/.exec(tokensCss)![1];
  const dark = /:root\[data-theme="dark"\], \.theme-dark \{([\s\S]*?)\n\}/.exec(tokensCss)![1];
  const system = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/.exec(tokensCss)![1];
  return [light, dark, system].map((block) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1] ?? "");
}

test("every_er_control_has_a_focus_ring", () => {
  // jsdom applies no stylesheet: the rules are read as text, as the board's styles tests do.
  const css = `${canvasCss}\n${flowTabCss}`;
  for (const sel of ["button.fkind-gut:focus-visible", ".fkind-addcol:focus-visible", ".fkind-ed:focus-visible"]) {
    expect(rule(css, sel), sel).toMatch(/outline:\s*2px solid var\(--c-focus\)/);
  }
  // The pick ring: the row or header the keyboard aims at while a relationship is picked (the canvas keeps the focus).
  expect(rule(css, ".fkind-er-row.is-pick, .fkind-head.is-pick")).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--c-accent\)/);
  // No rule for an ER control takes the ring away.
  for (const cls of ["fkind-gut", "fkind-addcol", "fkind-ed", "is-pick", "fkind-port", "fkind-er-row"]) {
    const rules = css.split("}").filter((r) => new RegExp(`\\.${cls}\\b[^{]*\\{`).test(r));
    expect(rules.length, cls).toBeGreaterThan(0);
    for (const r of rules) expect(r, cls).not.toMatch(/outline:\s*(none|0)\b/);
  }
  // Theme tokens only: the ring, the pick, the port, the selected row and a refused field read tokens set in both themes.
  for (const t of ["--c-focus", "--c-accent", "--c-danger-solid", "--c-danger-subtle", "--c-bg-surface", "--c-text"]) {
    const [light, dark, system] = themed(t);
    expect(light, `${t} light`).toMatch(/^#/);
    expect(dark, `${t} dark`).toMatch(/^#/);
    expect(system, `${t} system dark`).toBe(dark);
  }
  expect(rule(css, ".react-flow__handle.fkind-port")).toMatch(/border:\s*1\.5px solid var\(--c-accent\)/);
  expect(rule(css, ".fkind-er-row.is-selected")).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--c-accent\)/);
  // Contrast (the antislop-human checker, both themes): the type text on a selected or aimed row is 4.5:1 in the light
  // theme only at these tints or lighter (4.58 and 4.70; 22% read 4.17).
  expect(rule(css, ".fkind-er-row.is-selected")).toMatch(/background:\s*color-mix\(in srgb, var\(--c-accent\) 16%, transparent\)/);
  expect(rule(css, ".fkind-er-row.is-pick, .fkind-head.is-pick")).toMatch(/background:\s*color-mix\(in srgb, var\(--c-accent\) 14%, transparent\)/);
  // The hovered row: a tint of the hover token over the card, so the type text keeps 4.5:1 (4.82 light, 9.05 dark; the
  // bare token read 4.43 in light).
  expect(rule(css, ".fkind-er-row:hover")).toMatch(/background:\s*color-mix\(in srgb, var\(--c-bg-hover\) 70%, transparent\)/);
  // The strip's live region is never hidden while empty (display: none would take it out of the accessibility tree).
  expect(rule(css, ".flow-live:empty")).not.toMatch(/display:\s*none/);
  expect(rule(css, ".inline-edit.is-bad")).toMatch(/border-color:\s*var\(--c-danger-solid\)/);
});

/** Every string a source file can show: string and template literals and JSX text, read with the TypeScript parser. */
function copyOf(src: string, name: string): string[] {
  const found: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) found.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}

/** A message table's strings, its functions called with sample words. */
function messages(table: Record<string, unknown>): string[] {
  return Object.values(table).map((m) => (typeof m === "function" ? String((m as (...a: unknown[]) => unknown)("orders", "total", "customers", "id", 2)) : String(m)));
}

test("no_dash_or_banned_word_in_er_copy", () => {
  const noop = () => {};
  const copy = [
    ...messages(ER_MESSAGES),
    ...messages(RELATE_MESSAGES),
    ...messages(ER_NOTES),
    RELATE_MESSAGES.made("orders.customer_id", ">", "customers.id"),
    RELATE_MESSAGES.wholeTable("orders", "key"),
    RELATE_MESSAGES.wholeTable("orders", "body"),
    ER_MESSAGES.deletedWith("orders", "total", 1),
  ];
  // The column and table menus, every item and its tip when the frame is old form.
  const column = columnMenuItems({ flags: ["pk"], blocked: ER_NOTES.oldForm, rename: noop, editType: noop, toggle: noop, insert: noop, duplicate: noop, relate: noop, showInText: noop, remove: noop });
  const table = shapeMenuItems({ table: true, sized: true, connect: [], service: false, rename: noop, details: noop, addColumn: noop, addRelationship: noop, cut: noop, copy: noop, duplicate: noop, addConnected: noop, chooseIcon: noop, group: noop, fit: noop, showInText: noop, remove: noop });
  for (const i of [...column, ...table]) copy.push(String(i.label ?? ""), String((i as { title?: string }).title ?? ""));
  expect(column.length + table.length).toBeGreaterThan(15);
  // The Shapes tab's ER entries: their names, their hints and the text they show.
  for (const sh of shapesOf("er")) copy.push(sh.label, sh.hint ?? "", sh.code);
  // "Add relationship to..." says this while it waits for the table.
  const notice = /const linkNotice = \(table: string\) => `([^`]*)`/.exec(flowTabSource);
  expect(notice).not.toBeNull();
  copy.push(notice![1].replace("${table}", "customers"));
  // Every string the card, its store and the relationship code can show.
  for (const [file, src] of Object.entries({ "kindNodes.tsx": kindNodesSource, "erCanvas.tsx": erCanvasSource, "erRelate.ts": erRelateSource, "useErRelate.ts": useErRelateSource })) {
    copy.push(...copyOf(src, file));
  }
  expect(copy.length).toBeGreaterThan(200);
  const text = copy.join("\n");
  expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(text).not.toMatch(/\bcursor\b|\bcaret\b/i);
});

test("reduced_motion_stops_the_card_growth", async () => {
  // R28, D8: the card's growth is an inline transition whose duration is the motion table's; jsdom computes no style,
  // so the inline value is what is read.
  const d = parseFlow(ER).doc!;
  const at = { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } };
  const growth = () => buildFlowGraph(d, at, "modern", { grow: { customers: 1 } }).nodes.find((n) => n.id === "customers")!.style?.transition;
  reduce = true;
  expect(growth()).toBe(`height 0ms ${EASE_IN}`);
  reduce = false;
  expect(growth()).toBe(`height ${MOTION.settle}ms ${EASE_IN}`);
  // On the canvas: under reduced motion "+ column" opens its draft row and the card takes its new height at once.
  reduce = true;
  const s = setup();
  await drawn(s);
  const node = () => s.card("customers")!.closest(".react-flow__node") as HTMLElement;
  const before = parseFloat(node().style.height);
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await screen.findByRole("textbox", { name: "Column name" });
  await waitFor(() => expect(parseFloat(node().style.height)).toBe(before + 22));
  expect(node().style.transition).toBe(`height 0ms ${EASE_IN}`);
});
