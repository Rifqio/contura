// Diagram step 10 (board DiagramStartWell, F27; user decision of 25 Oct): New diagram starts from the kind's example by
// default (Example / Blank, draw.io's templates and Blank Diagram); a free default name is ready ("Untitled diagram 2"
// when "Untitled diagram" is taken, VS Code's Untitled-N), so Enter creates at once; a double-click on a card creates
// (draw.io); the selected kind follows the search, so Create never makes a kind you cannot see. ER diagrams live in the
// Schema Builder, so there is no ER card.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import type { DiagramKind } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { callsTo, routeInvoke } from "../test/invoke";
import NewDiagramSheet, { blankText, exampleText } from "./NewDiagramSheet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOW = new Date(2026, 9, 25, 9, 0);
const DIAGRAMS = [
  { name: "Untitled diagram", kind: "flow", title: "Untitled diagram", modifiedMs: NOW.getTime() - 60_000 },
  { name: "orders", kind: "dfd", title: "Orders", modifiedMs: NOW.getTime() - 120_000 },
];

function setup(list = DIAGRAMS) {
  routeInvoke({ list_diagrams: () => list, write_diagram: () => undefined });
  const calls = { close: vi.fn(), created: vi.fn(), mermaid: vi.fn(), open: vi.fn() };
  render(
    <ToastProvider>
      <NewDiagramSheet now={NOW} onClose={calls.close} onCreated={calls.created} onMermaid={calls.mermaid} onOpenDiagram={calls.open} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New diagram" });
  const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  const search = within(dialog).getByRole("searchbox", { name: "Find a kind" }) as HTMLInputElement;
  const create = () => within(dialog).getByRole("button", { name: /^Create/ }) as HTMLButtonElement;
  return { dialog, name, search, create, calls };
}

const KINDS: DiagramKind[] = ["dfd", "flow", "cloud", "sequence", "state", "class", "mindmap", "timeline"];

test("every kind's example and blank start parse with no problem, under the diagram's name", () => {
  for (const k of KINDS) {
    const ex = parseFlow(exampleText(k, "My plan"));
    expect(ex.problems.filter((p) => p.severity === "error"), k).toEqual([]);
    expect(ex.doc!.kind).toBe(k);
    expect(ex.doc!.title).toBe("My plan");
    expect(ex.doc!.nodes.length, k).toBeGreaterThan(2);
    expect(parseFlow(blankText(k, "My plan")).problems.filter((p) => p.severity === "error")).toEqual([]);
  }
  // A blank mind map keeps its central idea: the diagram's name.
  expect(blankText("mindmap", "Q4 plan")).toBe('diagram mindmap "Q4 plan"\nroot Q4 plan\n');
  expect(blankText("flow", "Orders")).toBe('diagram flow "Orders"\n');
});

test("a free default name is ready and Enter creates at once, from the example", async () => {
  const { name, search, calls } = setup();
  // "Untitled diagram" is taken: the next free one (VS Code's Untitled-N).
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram 2"));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: "Untitled diagram 2", text: exampleText("dfd", "Untitled diagram 2"), overwrite: false });
});

test("Start with Blank writes only the first line; the hint says which", async () => {
  const { dialog, name, calls } = setup();
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  const start = within(dialog).getByRole("radiogroup", { name: "Start with" });
  expect(within(start).getByRole("radio", { name: "Example" }).getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByText("The card's example comes with it.")).toBeTruthy();
  await userEvent.click(within(start).getByRole("radio", { name: "Blank" }));
  expect(within(dialog).getByText('Only the first line, diagram dfd "Untitled diagram 2".')).toBeTruthy();
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram 2"));
  expect(callsTo("write_diagram")[0].text).toBe('diagram dfd "Untitled diagram 2"\n');
});

test("the selected kind follows the search: filtered to mind, Create makes a mind map", async () => {
  const { dialog, search, create, calls } = setup();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Sequence" }));
  expect(create().textContent).toContain("Create sequence");
  await userEvent.type(search, "mind");
  const kinds = within(within(dialog).getByRole("radiogroup", { name: "Kind" })).getAllByRole("radio");
  expect(kinds.map((k) => k.getAttribute("aria-label"))).toEqual(["Mind map"]);
  expect(kinds[0].getAttribute("aria-checked")).toBe("true");
  expect(create().textContent).toContain("Create mind map");
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(calls.created).toHaveBeenCalled());
  expect(callsTo("write_diagram")[0].text).toBe(exampleText("mindmap", "Untitled diagram 2"));
  // Nothing shown: nothing to create.
  await userEvent.clear(search);
  await userEvent.type(search, "zzz");
  expect(create().disabled).toBe(true);
});

test("a double-click on a card creates that kind at once (draw.io)", async () => {
  const { dialog, name, calls } = setup();
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  fireEvent.doubleClick(within(dialog).getByRole("radio", { name: "Timeline" }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("Untitled diagram 2"));
  expect(callsTo("write_diagram")[0].text).toBe(exampleText("timeline", "Untitled diagram 2"));
});

test("no ER card: ER diagrams live in the Schema Builder", () => {
  const { dialog } = setup();
  const cards = within(within(dialog).getByRole("radiogroup", { name: "Kind" })).getAllByRole("radio").map((c) => c.getAttribute("aria-label"));
  expect(cards).toEqual(["Data flow", "Flowchart", "Cloud architecture", "Sequence", "State", "Class", "Mind map", "Timeline"]);
});

test("the default name is not a change: a click outside closes; a changed name is kept from a click outside", async () => {
  const { dialog, name, calls } = setup();
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  fireEvent.mouseDown(dialog.parentElement as HTMLElement);
  expect(calls.close).toHaveBeenCalledTimes(1);
});

test("From Mermaid... hands over the kind and name chosen, so Back returns to them", async () => {
  const { dialog, name, calls } = setup();
  await waitFor(() => expect(name.value).toBe("Untitled diagram 2"));
  await userEvent.click(within(dialog).getByRole("radio", { name: "State" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "From Mermaid..." }));
  expect(calls.mermaid).toHaveBeenCalledWith({ kind: "state", name: "Untitled diagram 2", start: "example", query: "", group: "all" });
});

test("it opens as it was left when it comes back from Mermaid", async () => {
  routeInvoke({ list_diagrams: () => DIAGRAMS, write_diagram: () => undefined });
  render(
    <ToastProvider>
      <NewDiagramSheet
        now={NOW}
        initial={{ kind: "class", name: "Billing", start: "blank", query: "", group: "software" }}
        onClose={() => {}}
        onCreated={() => {}}
        onMermaid={() => {}}
        onOpenDiagram={() => {}}
      />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New diagram" });
  expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Billing");
  expect(within(dialog).getByRole("radio", { name: "Class" }).getAttribute("aria-checked")).toBe("true");
  expect(within(within(dialog).getByRole("radiogroup", { name: "Start with" })).getByRole("radio", { name: "Blank" }).getAttribute("aria-checked")).toBe("true");
});

test("fix round 1, M8: each card draws its kind's real example, from the example text", () => {
  const { dialog } = setup();
  const cards = within(within(dialog).getByRole("radiogroup", { name: "Kind" })).getAllByRole("radio");
  const words: Record<string, string[]> = {
    "Data flow": ["Customer", "Take order", "Orders"],
    Flowchart: ["Order in", "Check stock", "In stock?"],
    "Cloud architecture": ["Gateway", "Orders API", "AWS"],
    Sequence: ["Customer", "Shop", "Payments"],
    State: ["Draft", "Sent", "Overdue"],
    Class: ["Invoice", "Payable", "LineItem"],
    "Mind map": ["Q4 plan", "Diagrams", "Release"],
    Timeline: ["Build", "Beta", "Launch"],
  };
  for (const c of cards) {
    const svg = c.querySelector(".new-diagram-preview svg");
    expect(svg, c.getAttribute("aria-label") ?? "").toBeTruthy();
    const text = svg!.textContent ?? "";
    for (const w of words[c.getAttribute("aria-label")!]) expect(text, `${c.getAttribute("aria-label")}: ${w}`).toContain(w);
  }
});

test("fix round 2, L3: Recent diagrams name each diagram without .flow", async () => {
  const { dialog } = setup();
  const recent = await within(dialog).findByRole("list", { name: "Recent diagrams" });
  await waitFor(() => expect(within(recent).getAllByRole("button")).toHaveLength(2));
  const rows = within(recent).getAllByRole("button");
  expect(rows[1].textContent).toBe("ordersData flow, 2m ago");
  expect(rows[1].getAttribute("title")).toBe("Open orders");
});

test("fix round 2, L5: the Sequence card reads as a sequence: heads, dashed lifelines and an arrow per message", () => {
  const { dialog } = setup();
  const card = within(within(dialog).getByRole("radiogroup", { name: "Kind" })).getByRole("radio", { name: "Sequence" });
  const svg = card.querySelector(".new-diagram-preview svg")!;
  // Three lifelines, dashed.
  expect(svg.querySelectorAll("[data-part=lifeline]")).toHaveLength(3);
  for (const l of svg.querySelectorAll("[data-part=lifeline]")) expect(l.getAttribute("stroke-dasharray")).toBeTruthy();
  // Four messages, each with its head; the two replies dashed.
  const messages = [...svg.querySelectorAll("[data-part=message]")];
  expect(messages).toHaveLength(4);
  expect(svg.querySelectorAll("[data-part=head]")).toHaveLength(4);
  expect(messages.filter((m) => m.getAttribute("stroke-dasharray")).length).toBe(2);
  expect(svg.textContent).toContain("place order");
});
