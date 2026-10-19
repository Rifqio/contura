import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { callsTo, routeInvoke } from "../test/invoke";
import NewDiagramSheet from "./NewDiagramSheet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOW = new Date(2026, 9, 18, 15, 0);
const HOUR = 3_600_000;
const DIAGRAMS = [
  { name: "fulfilment", kind: "dfd", title: "Fulfilment", modifiedMs: NOW.getTime() - 2 * HOUR },
  { name: "refund-policy", kind: "flow", title: "Refund policy", modifiedMs: NOW.getTime() - 24 * HOUR },
  { name: "platform", kind: "cloud", title: "Platform", modifiedMs: NOW.getTime() - 72 * HOUR },
];

const LAYOUT_LR = `${JSON.stringify({ version: 1, nodes: {}, style: "modern", direction: "LR" }, null, 2)}\n`;

function setup(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({ list_diagrams: () => DIAGRAMS, write_diagram: () => undefined, ...over });
  const calls = { close: vi.fn(), created: vi.fn(), mermaid: vi.fn(), open: vi.fn() };
  render(
    <ToastProvider>
      <NewDiagramSheet now={NOW} onClose={calls.close} onCreated={calls.created} onMermaid={calls.mermaid} onOpenDiagram={calls.open} />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New diagram" });
  const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  return { dialog, name, calls };
}

test("every_kind_card_and_the_selected_one_has_the_outline_and_check", async () => {
  const { dialog } = setup();
  const group = within(dialog).getByRole("radiogroup", { name: "Kind" });
  const cards = within(group).getAllByRole("radio");
  expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
    "Data flow",
    "Flowchart",
    "Cloud architecture",
    "Entity relationship",
    "Sequence",
    "State",
    "Class",
    "Mind map",
    "Timeline",
  ]);
  expect(within(cards[0]).getByText("Processes, data stores and outside parties. Stores can link to tables.")).toBeTruthy();
  expect(within(cards[1]).getByText("Steps, decisions, input and output, start and end.")).toBeTruthy();
  expect(within(cards[2]).getByText("Services as provider icons, grouped by network or layer.")).toBeTruthy();
  // Data flow is picked first: the outline class and the check sit on that card only.
  expect(cards.map((c) => c.getAttribute("aria-checked")).slice(0, 3)).toEqual(["true", "false", "false"]);
  expect(cards[0].classList.contains("is-on")).toBe(true);
  expect(dialog.querySelectorAll(".new-diagram-check")).toHaveLength(1);
  expect(cards[0].querySelector(".new-diagram-check")).toBeTruthy();
  // Each card draws a preview.
  for (const c of cards) expect(c.querySelector(".new-diagram-preview")).toBeTruthy();
  await userEvent.click(cards[1]);
  expect(cards.map((c) => c.getAttribute("aria-checked")).slice(0, 3)).toEqual(["false", "true", "false"]);
  expect(cards[1].querySelector(".new-diagram-check")).toBeTruthy();
  expect(cards[0].classList.contains("is-on")).toBe(false);
  expect(within(dialog).getByText("The kind is the first line of the file, so you can change it later.")).toBeTruthy();
});

test("the_hint_names_the_file_in_the_diagrams_folder", async () => {
  const { dialog, name } = setup();
  await userEvent.type(name, "checkout");
  expect(
    within(dialog).getByText("Saved as checkout.flow in Contura's diagrams folder. Publish or Save a copy as puts it anywhere else."),
  ).toBeTruthy();
});

test("enter_creates_the_diagram_with_its_first_line_and_opens_it", async () => {
  const { name, calls } = setup();
  await userEvent.type(name, "checkout{Enter}");
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("checkout"));
  expect(callsTo("write_diagram")).toEqual([{ name: "checkout", text: 'diagram dfd "checkout"\n', layout: LAYOUT_LR, overwrite: false }]);
});

test("the_picked_kind_is_the_first_line", async () => {
  const { dialog, name, calls } = setup();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Flowchart" }));
  await userEvent.type(name, "refunds");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create/ }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("refunds"));
  expect(callsTo("write_diagram")[0].text).toBe('diagram flow "refunds"\n');
});

test("an_existing_name_asks_before_replacing_it", async () => {
  const { dialog, name, calls } = setup({
    write_diagram: (a) => {
      if (!a.overwrite) throw { kind: "diagramExists", message: { name: "checkout" } };
      return undefined;
    },
  });
  await userEvent.type(name, "checkout{Enter}");
  expect(await within(dialog).findByText("checkout.flow already exists. Replace it?")).toBeTruthy();
  expect(calls.created).not.toHaveBeenCalled();
  // Cancel keeps the sheet open and writes nothing more.
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(dialog).queryByText("checkout.flow already exists. Replace it?")).toBeNull();
  expect(calls.close).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create/ }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Replace" }));
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("checkout"));
  expect(callsTo("write_diagram").map((c) => c.overwrite)).toEqual([false, false, true]);
});

test("a_name_the_rule_refuses_shows_the_rule", async () => {
  const rule = 'Use a name without \\ / : * ? " < > | and under 120 characters.';
  const { dialog, name, calls } = setup({
    write_diagram: () => {
      throw { kind: "invalidInput", message: rule };
    },
  });
  await userEvent.type(name, "a:b{Enter}");
  expect((await within(dialog).findByRole("alert")).textContent).toBe(rule);
  expect(calls.created).not.toHaveBeenCalled();
});

test("create_is_off_until_there_is_a_name", async () => {
  const { dialog, name } = setup();
  const create = within(dialog).getByRole("button", { name: /^Create/ }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  await userEvent.type(name, "  ");
  expect(create.disabled).toBe(true);
  await userEvent.type(name, "x");
  expect(create.disabled).toBe(false);
});

test("recent_diagrams_list_with_their_kind_and_compact_time", async () => {
  const { dialog, calls } = setup();
  const recent = await within(dialog).findByRole("list", { name: "Recent diagrams" });
  await waitFor(() => expect(within(recent).getAllByRole("button")).toHaveLength(3));
  const rows = within(recent).getAllByRole("button");
  expect(rows.map((r) => r.textContent)).toEqual([
    "fulfilment.flowData flow, 2h ago",
    "refund-policy.flowFlowchart, 1d ago",
    "platform.flowCloud, 3d ago",
  ]);
  await userEvent.click(rows[1]);
  expect(calls.open).toHaveBeenCalledWith("refund-policy");
});

test("flow_from_mermaid_opens_the_mermaid_dialog", async () => {
  const { dialog, calls } = setup();
  expect(within(dialog).getByText("Have a Mermaid diagram already?")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Flow from Mermaid..." }));
  expect(calls.mermaid).toHaveBeenCalledTimes(1);
});

test("a_typed_dot_flow_is_dropped_once", async () => {
  const { dialog, name, calls } = setup();
  await userEvent.type(name, "checkout.FLOW");
  expect(
    within(dialog).getByText("Saved as checkout.flow in Contura's diagrams folder. Publish or Save a copy as puts it anywhere else."),
  ).toBeTruthy();
  await userEvent.type(name, "{Enter}");
  await waitFor(() => expect(calls.created).toHaveBeenCalledWith("checkout"));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: "checkout", text: 'diagram dfd "checkout"\n' });
});

test("replace_runs_before_replace_first", async () => {
  const order: string[] = [];
  routeInvoke({
    list_diagrams: () => [],
    write_diagram: (a) => {
      order.push(`write ${a.overwrite}`);
      if (!a.overwrite) throw { kind: "diagramExists", message: { name: "checkout" } };
      return undefined;
    },
  });
  const created = vi.fn();
  render(
    <ToastProvider>
      <NewDiagramSheet
        now={NOW}
        onClose={() => {}}
        onCreated={created}
        onMermaid={() => {}}
        onOpenDiagram={() => {}}
        beforeReplace={(n) => {
          order.push(`before ${n}`);
        }}
      />
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "New diagram" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "checkout{Enter}");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Replace" }));
  await waitFor(() => expect(created).toHaveBeenCalledWith("checkout"));
  expect(order).toEqual(["write false", "before checkout", "write true"]);
});

test("item_19_find_a_kind_by_a_word_or_a_group_and_create_names_the_kind", async () => {
  const { dialog, name } = setup();
  const kinds = () => within(within(dialog).getByRole("radiogroup", { name: "Kind" })).queryAllByRole("radio").map((c) => c.getAttribute("aria-label"));
  await userEvent.click(within(dialog).getByRole("radio", { name: "Planning" }));
  expect(kinds()).toEqual(["Mind map", "Timeline"]);
  await userEvent.click(within(dialog).getByRole("radio", { name: "All" }));
  await userEvent.type(within(dialog).getByRole("searchbox", { name: "Find a kind" }), "who calls");
  expect(kinds()).toEqual(["Sequence"]);
  await userEvent.clear(within(dialog).getByRole("searchbox", { name: "Find a kind" }));
  await userEvent.type(within(dialog).getByRole("searchbox", { name: "Find a kind" }), "zzz");
  expect(within(dialog).getByText("No kind matches. Try another word.")).toBeTruthy();
  await userEvent.clear(within(dialog).getByRole("searchbox", { name: "Find a kind" }));
  await userEvent.click(within(dialog).getByRole("radio", { name: "Sequence" }));
  await userEvent.type(name, "pay");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create sequence/ }));
  await waitFor(() => expect(callsTo("write_diagram")).toHaveLength(1));
  expect(callsTo("write_diagram")[0]).toMatchObject({ name: "pay", text: 'diagram sequence "pay"\n' });
});
