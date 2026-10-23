// The diagram assistant inside the diagram tab: Send, the read-only hold, Review first, Auto-apply, the remove
// confirm, the landing as one undo step, the tool result and the thread (board 11.5).
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { saveAiSettings, withTurn } from "../../api/client";
import type { AiEvent, AiThread, AppendTurn, DiagramAskRequest, DiagramProposal, ModelList, Preview, ProposedChange } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { turnViewOf } from "../../test/aiThreads";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { done, failed, sent, step } from "../../test/aiStream";
import { GROQ, modelInfo, modelList } from "../../test/settingsRoutes";
import FlowTab from "../FlowTab";
import { flowEntry } from "../flowRegistry";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default(p);
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
});

const DFD = [
  'diagram dfd "Checkout"',
  "",
  "Customer [entity]",
  "Checkout [process, id: 1.0]",
  "Orders [store, id: D1, table: shop.orders]",
  "",
  "Payments {",
  "  Charge card [process, id: 2.0]",
  "  Card network [entity]",
  "}",
  "",
  "Customer > Checkout: order details",
  "Checkout > Orders: new order",
  "Checkout > Charge card: amount",
  "Charge card <> Card network: authorise",
  "Orders --> Checkout: stock level",
  "",
].join("\n");

const ok = { kind: "ok" } as const;
const change = (index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: ok, dependsOn });

/** A fraud check after Checkout: a shape, two lines to and from it, and the old line to Orders removed. */
const FRAUD: ProposedChange[] = [
  change(0, { add_node: { name: "Fraud check", kind: "process", id: "1.1" } }),
  change(1, { add_flow: { from: "Checkout", to: "Fraud check", label: "risk" } }, [0]),
  change(2, { remove_flow: { from: "Checkout", to: "Orders", label: "new order" } }),
  change(3, { add_flow: { from: "Fraud check", to: "Orders", label: "cleared" } }, [0]),
];

/** The model's tool JSON as the Core passes it on. */
const INPUT = '{"file":"checkout","base_hash":"b1","ops":[]}';
const proposal = (changes: ProposedChange[]): DiagramProposal => ({ file: "checkout", baseHash: "b1", changes });
const answer = (changes: ProposedChange[] | null, text = "I'll add a fraud check between Checkout and Orders."): AiEvent[] => [
  { type: "delta", text },
  ...(changes ? [{ type: "proposal", proposal: proposal(changes), input: INPUT } as AiEvent] : []),
  done(),
];

type Sink = { onmessage: (e: AiEvent) => void };

let threads: AiThread[] = [];
let failWrites = false;
let failSave = false;
/** Each thread an Ask saved, as the Core holds it after the save. */
let saved: AiThread[] = [];
let failRecord = false;
let replies: AiEvent[][] = [];
let holdAsk = false;
/** "Propose diagram changes" in the global AI settings. */
let toolOn = true;
/** What the Core refuses a preview with, when it does. */
let previewError: unknown = null;
/** What the file on disk holds now when it is not what the tab read. */
let disk: string | null = null;
/** The models the Core knows without the network; null: no provider is set up. */
let known: ModelList | null = null;
/** What reading the AI settings fails with, when it does. */
let settingsFail: unknown = null;
const sinks: Sink[] = [];

/** The Core's preview of a diagram Ask: the question, the file and the selection, locked on. */
function previewOf(r: DiagramAskRequest): Preview {
  const lock = "The changes are written against this text";
  const items: Preview["items"] = [
    { kind: "question", label: "Question", bytes: r.question.length, tokens: 4, locked: null, on: true },
    { kind: "diagram", label: `${r.file}.flow`, bytes: r.text.length, tokens: 100, locked: lock, on: true },
  ];
  if (r.scope.kind === "selection") items.push({ kind: "diagram", label: `Selection, ${r.scope.names.length} shapes`, bytes: 20, tokens: 5, locked: lock, on: true });
  return {
    items,
    tables: { full: [], namesOnly: [], leftOut: [], reasons: [] },
    totalBytes: 2911,
    tokens: 700,
    exact: `<<contura:context id=8f2c>>\n${r.text}<</contura:context id=8f2c>>\nFile: ${r.file}.flow. base_hash: 3f9a0c1e7b2d4a55.\n\nQuestion: ${r.question}`,
    notes: [],
    log: [],
    context: null,
    rows: null,
  };
}

function setup(opts: { text?: string; layout?: string | null; name?: string; onOpenSettings?(): void } = {}) {
  const files = { text: opts.text ?? DFD, layout: opts.layout ?? null };
  routeInvoke({
    read_diagram: () => (disk === null ? files : { text: disk, layout: files.layout }),
    write_diagram: () => {
      if (failWrites) throw { kind: "io", message: "the disk is full" };
      return null;
    },
    write_diagram_layout: () => {
      if (failWrites) throw { kind: "io", message: "the disk is full" };
      return null;
    },
    list_ai_threads: (a) =>
      threads.filter((t) => t.place === a.place).map((t) => ({ id: t.id, place: t.place, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length, topics: 0 })),
    get_ai_thread: (a) => {
      const t = threads.find((x) => x.id === a.threadId);
      return t ? { thread: t, topics: [], compactions: [] } : null;
    },
    save_ai_thread: (a) => {
      if (failSave) throw { kind: "io", message: "the store is locked" };
      const t = a.thread as AiThread;
      threads = [...threads.filter((x) => x.id !== t.id), t];
      saved.push(t);
      return { thread: t, topics: [], compactions: [] };
    },
    ai_append_turn: (a) => {
      if (failSave) throw { kind: "io", message: "the store is locked" };
      const turn = a.turn as AppendTurn;
      const before = threads.find((x) => x.id === turn.threadId) ?? null;
      const v = turnViewOf(turn, before);
      const t = withTurn(before, v);
      threads = [...threads.filter((x) => x.id !== t.id), t];
      saved.push(t);
      return v;
    },
    ai_known_models: () => {
      if (known) return known;
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    save_ai_settings: () => null,
    ai_settings: () => {
      if (settingsFail) throw settingsFail;
      return { settings: { ...GROQ, diagramTool: toolOn }, groupOverride: false, keySaved: true, keyLast4: "abcd" };
    },
    ai_diagram_preview: (a) => {
      if (previewError) throw previewError;
      return previewOf(a.request as DiagramAskRequest);
    },
    ai_diagram_ask: (a) => {
      const sink = a.events as Sink;
      sinks.push(sink);
      if (holdAsk) return null;
      const events = replies.shift() ?? [];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => {
      if (failRecord) throw { kind: "io", message: "the store is locked" };
      return a.outcome;
    },
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={opts.name ?? "checkout"} client={client} onOpenSettings={opts.onOpenSettings} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`);
  return { ...utils, client, view, text, node };
}

type Setup = ReturnType<typeof setup>;

beforeEach(() => {
  threads = [];
  replies = [];
  holdAsk = false;
  toolOn = true;
  previewError = null;
  disk = null;
  known = null;
  settingsFail = null;
  failWrites = false;
  failSave = false;
  saved = [];
  failRecord = false;
  sinks.length = 0;
});

async function drawn(s: Setup) {
  await waitFor(() => expect(s.node("Process Checkout")).not.toBeNull(), { timeout: 4000 });
}

const assistantTab = () => screen.getByRole("tab", { name: /^Assistant/ });
const box = () => screen.getByRole("textbox", { name: "Describe a change" });
const card = () => screen.getByRole("region", { name: "Changes to review" });
const rows = () => [...card().querySelectorAll(".crow")].map((r) => [r.querySelector(".mk")!.textContent, r.querySelector(".tx")!.textContent, r.classList.contains("off")]);
const asks = () => callsTo("ai_diagram_ask").map((c) => c.request as DiagramAskRequest);
/** The canvas node `id` as the tab last drew it. */
const drawnNode = (id: string) => canvas.props?.nodes.find((n) => n.id === id);
const last = <T,>(a: T[]): T | undefined => a[a.length - 1];
const order = () => vi.mocked(invoke).mock.calls.map(([c]) => c);

/** Opens the Assistant and sends `q` with Enter. */
async function send(q: string) {
  fireEvent.click(assistantTab());
  fireEvent.change(box(), { target: { value: q } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(asks().length).toBeGreaterThan(0));
}

/** Waits for the review card of the last answer. */
async function reviewing() {
  await waitFor(() => expect(screen.getByRole("region", { name: "Changes to review" })).toBeTruthy());
}

test("send_flushes_then_asks_with_outline", async () => {
  const s = setup();
  await drawn(s);
  // An edit not yet saved: Send writes it first, so the Core reads what the tab holds.
  act(() => s.view().dispatch({ changes: { from: s.text().length, insert: "Refunds [process, id: 3.0]\n" } }));
  replies = [answer(null)];
  await send("Add a fraud check after Checkout");
  const calls = order();
  expect(calls.lastIndexOf("write_diagram")).toBeGreaterThanOrEqual(0);
  expect(calls.lastIndexOf("write_diagram")).toBeLessThan(calls.indexOf("ai_diagram_ask"));
  const r = asks()[0];
  expect(r.file).toBe("checkout");
  expect(r.text).toBe(s.text());
  expect(r.question).toBe("Add a fraud check after Checkout");
  expect(r.scope).toEqual({ kind: "whole" });
  // No history is sent: every Ask is a new one on the current text.
  expect(r.threadId ?? null).toBeNull();
  expect(typeof r.requestId).toBe("string");
  // The outline is the worker's, of the text sent.
  expect(r.outline.kind).toBe("dfd");
  expect(r.outline.nodes.map((n) => n.name)).toEqual(["Customer", "Checkout", "Orders", "Charge card", "Card network", "Refunds"]);
  expect(r.outline.nodes.find((n) => n.name === "Orders")).toMatchObject({ id: "D1", table: true });
  expect(r.outline.links).toHaveLength(5);
  // The composer empties and the question shows in the thread.
  await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe(""));
  expect(await screen.findByText("Add a fraud check after Checkout")).toBeTruthy();
});

test("text_is_read_only_while_working", async () => {
  const s = setup();
  await drawn(s);
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.view().state.readOnly).toBe(true));
  // The editor says so, with Stop; the composer gives way to the working line; the canvas takes no edits.
  expect(screen.getByText("The assistant is editing. The text is read-only until it finishes.")).toBeTruthy();
  expect(screen.getByText("Working on checkout.flow. Stop it to type.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Describe a change" })).toBeNull();
  expect(screen.getByText("AI is editing Checkout")).toBeTruthy();
  expect(canvas.props!.readOnly).toBe(true);
  // Delete on the canvas does nothing while it works.
  act(() => canvas.props!.onSelect!(["Customer"]));
  fireEvent.keyDown(s.container.querySelector(".flow-canvas")!, { key: "Delete" });
  expect(s.text()).toBe(DFD);

  // Esc stops it: the Core is told by the diagram's place, and the text is editable again.
  fireEvent.keyDown(screen.getByText("Working on checkout.flow. Stop it to type."), { key: "Escape" });
  await waitFor(() => expect(callsTo("ai_cancel_place")).toEqual([{ place: "diagram:checkout" }]));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect(screen.queryByText("The assistant is editing. The text is read-only until it finishes.")).toBeNull();
  expect(canvas.props!.readOnly).toBe(false);
  expect(box()).toBeTruthy();

  // Stop in the editor's banner stops a second Ask the same way.
  await send("Try again");
  await waitFor(() => expect(s.view().state.readOnly).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
  const banner = screen.getByText("The assistant is editing. The text is read-only until it finishes.").closest(".flow-ebar") as HTMLElement;
  fireEvent.click(within(banner).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(callsTo("ai_cancel_place")).toHaveLength(2));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
});

test("closing_the_tab_stops_the_ask", async () => {
  const s = setup();
  await drawn(s);
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.view().state.readOnly).toBe(true));
  // Opening another diagram in the tab stops it, and nothing of it follows into the other one.
  threads = [
    {
      id: "o1",
      place: "diagram:other",
      title: "Name the stores",
      updatedAt: 3,
      messages: [
        { role: "user", text: "Name the stores", context: [], at: 1 },
        { role: "assistant", text: "They are named.", context: [], at: 2 },
      ],
    },
  ];
  s.rerender(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="other" client={s.client} />
    </div>,
  );
  await waitFor(() => expect(callsTo("ai_cancel_place")).toEqual([{ place: "diagram:checkout" }]));
  // The old Ask's answer arriving late changes nothing here.
  act(() => answer(FRAUD).forEach((e) => sinks[0].onmessage(e)));
  expect(await screen.findByText("Name the stores")).toBeTruthy();
  expect(screen.getByText("They are named.")).toBeTruthy();
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect((box() as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByText("Add a fraud check after Checkout")).toBeNull();
  expect(saved.filter((t) => t.place === "diagram:checkout")).toEqual([]);
  expect(screen.queryByRole("region", { name: "Changes to review" })).toBeNull();
  cleanup();

  // Closing the tab stops it too, and an answer that arrives afterwards lands nothing.
  vi.mocked(invoke).mockClear();
  const t = setup();
  await drawn(t);
  await send("Add a fraud check after Checkout");
  t.unmount();
  await waitFor(() => expect(callsTo("ai_cancel_place")).toEqual([{ place: "diagram:checkout" }]));
  act(() => answer(FRAUD).forEach((e) => sinks[sinks.length - 1].onmessage(e)));
  expect(callsTo("write_diagram")).toEqual([]);
  expect(callsTo("ai_record_tool_result")).toEqual([]);
});

test("review_lists_changes_and_lands_one_step", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await reviewing();
  expect(screen.getByText("I'll add a fraud check between Checkout and Orders.")).toBeTruthy();
  expect(within(card()).getByText("4 changes")).toBeTruthy();
  expect(rows()).toEqual([
    ["+", "Fraud check [process, id: 1.1]", false],
    ["+", "Checkout > Fraud check: risk", false],
    ["-", "Checkout > Orders: new order", false],
    ["+", "Fraud check > Orders: cleared", false],
  ]);
  expect(within(card()).getByText("Lands as one undo step")).toBeTruthy();
  expect(within(card()).getByRole("button", { name: /^Accept all/ })).toBeTruthy();
  // The count waits on the Assistant tab; the text stays read-only and shows the changes as ghost marks.
  expect(assistantTab().querySelector(".pcount")?.textContent).toBe("4");
  expect(s.view().state.readOnly).toBe(true);
  expect(screen.getByText("4 changes from the assistant are marked below.")).toBeTruthy();
  expect(s.container.querySelector(".cm-flow-ghost")?.textContent).toContain("Fraud check [process, id: 1.1]");
  expect(s.container.querySelector(".cm-flow-ghost-old")?.textContent).toContain("Checkout > Orders: new order");
  // The canvas draws the proposal: the new shape with its badge, the removed line in red.
  await waitFor(() => expect(drawnNode("Fraud check")?.data.state).toBe("suggested"));
  const edges = canvas.props!.edges;
  expect(edges.filter((e) => e.className?.includes("is-ai-del")).map((e) => [e.source, e.target])).toEqual([["Checkout", "Orders"]]);
  expect(edges.filter((e) => e.className?.includes("is-ai-add")).map((e) => [e.source, e.target])).toEqual([
    ["Checkout", "Fraud check"],
    ["Fraud check", "Orders"],
  ]);

  // "Show in the text" switches to the Editor.
  fireEvent.click(within(card()).getByRole("button", { name: "Show in the text" }));
  expect(screen.getByRole("tab", { name: /^Editor/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(assistantTab());

  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Fraud check [process, id: 1.1]"));
  expect(s.text()).toContain("Checkout > Fraud check: risk");
  expect(s.text()).toContain("Fraud check > Orders: cleared");
  expect(s.text()).not.toContain("Checkout > Orders: new order");
  expect(screen.getByText("Done. I added Fraud check and 2 lines and removed 1 line, as one undo step. The new parts are ringed on the canvas for a moment.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Changes to review" })).toBeNull();
  expect(assistantTab().querySelector(".pcount")).toBeNull();
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  // One step: one undo gives the text back.
  act(() => {
    undo(s.view());
  });
  expect(s.text()).toBe(DFD);
});

test("reject_takes_dependents", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await reviewing();
  const row = (i: number) => card().querySelectorAll(".crow")[i] as HTMLElement;
  // The two lines to and from the new shape need it: rejecting the shape rejects them.
  fireEvent.click(within(row(0)).getByRole("button", { name: "Reject this change" }));
  expect(rows().map((r) => r[2])).toEqual([true, true, false, true]);
  expect(within(card()).getByRole("button", { name: /^Accept 1/ })).toBeTruthy();
  expect(assistantTab().querySelector(".pcount")?.textContent).toBe("1");
  // Accepting a line again takes back the shape it needs, not the other line.
  fireEvent.click(within(row(1)).getByRole("button", { name: "Accept this change" }));
  expect(rows().map((r) => r[2])).toEqual([false, false, false, true]);
  fireEvent.click(within(row(0)).getByRole("button", { name: "Reject this change" }));
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept 1/ }));
  await waitFor(() => expect(s.text()).not.toContain("Checkout > Orders: new order"));
  // No dangling line: nothing of the rejected shape landed.
  expect(s.text()).not.toContain("Fraud check");
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(1));
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 1, rejected: 3, auto: false });
});

test("ctrl_enter_accepts", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await reviewing();
  fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(s.text()).toContain("Fraud check [process, id: 1.1]"));
});

test("auto_apply_lands_at_once", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  expect(screen.getByRole("radio", { name: "Auto-apply" }).getAttribute("aria-checked")).toBe("true");
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.text()).toContain("Fraud check [process, id: 1.1]"));
  expect(s.text()).not.toContain("Checkout > Orders: new order");
  expect(screen.queryByRole("region", { name: "Changes to review" })).toBeNull();
  expect(await screen.findByText("Done. I added Fraud check and 2 lines and removed 1 line, as one undo step. The new parts are ringed on the canvas for a moment.")).toBeTruthy();
  // The new shape is ringed for a moment.
  await waitFor(() => expect(drawnNode("Fraud check")?.data.state).toBe("airing"));
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(1));
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 4, rejected: 0, auto: true });
  // Undo in the answer takes it back in one step.
  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(s.text()).toBe(DFD);
  // The mode is remembered.
  expect(screen.getByRole("radio", { name: "Auto-apply" }).getAttribute("aria-checked")).toBe("true");
});

test("remove_four_shapes_asks_even_in_auto", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  const redraw: ProposedChange[] = [
    change(0, { remove_node: { target: "Customer" } }),
    change(1, { remove_node: { target: "Checkout" } }),
    change(2, { remove_node: { target: "Orders" } }),
    change(3, { remove_node: { target: "Charge card" } }),
    change(4, { add_node: { name: "Shop", kind: "process", id: "1.0" } }),
  ];
  replies = [answer(redraw, "Starting over with one process."), answer(redraw, "Starting over with one process.")];
  await send("Start over with a simpler flow");
  expect(await screen.findByText("Remove 4 shapes and 5 lines?")).toBeTruthy();
  expect(screen.getByText("This would remove 4 shapes and 5 lines: Customer, Checkout, Orders and Charge card. Then I'd draw 1 new shape.")).toBeTruthy();
  expect(screen.getByText("Removing more than 3 shapes always asks, even with Auto-apply on. The links from Orders to their tables go too.")).toBeTruthy();
  // Nothing landed while it asks, and the text stays read-only.
  expect(s.text()).toBe(DFD);
  expect(s.view().state.readOnly).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review each change" })).toBeTruthy();

  // Cancel lands nothing and records it.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(1));
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 0, rejected: 5, auto: true });
  expect(s.text()).toBe(DFD);
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));

  // "Remove and redraw" lands the whole set.
  await send("Start over with a simpler flow");
  fireEvent.click(await screen.findByRole("button", { name: "Remove and redraw" }));
  await waitFor(() => expect(s.text()).toContain("Shop [process, id: 1.0]"));
  expect(s.text()).not.toContain("Customer");
  expect(s.text()).toContain("Card network");
});

test("one_undo_restores_the_text", async () => {
  const crlf = DFD.replace(/\n/g, "\r\n");
  const positions = { Customer: { x: 0, y: 0 }, Checkout: { x: 240, y: 0 }, Orders: { x: 480, y: 0 }, "Charge card": { x: 240, y: 160 }, "Card network": { x: 480, y: 160 } };
  const layout = `${JSON.stringify({ version: 1, nodes: positions, style: "modern", direction: "LR" }, null, 2)}\n`;
  const s = setup({ text: crlf, layout });
  await drawn(s);
  // The selection is the scope.
  act(() => canvas.props!.onSelect!(["Checkout", "Orders"]));
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("button", { name: "Whole diagram" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "2 selected" }));
  expect(screen.getByRole("button", { name: "2 selected" })).toBeTruthy();
  replies = [answer(FRAUD.slice(0, 3))];
  await send("Add a fraud check after Checkout");
  expect(asks()[0].scope).toEqual({ kind: "selection", names: ["Checkout", "Orders"] });
  await reviewing();
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Fraud check"));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  // Saved with CRLF, then one Ctrl+Z on the canvas gives the original bytes back.
  await waitFor(() => expect(last(callsTo("write_diagram"))?.text).toContain("Fraud check [process, id: 1.1]\r\n"));
  fireEvent.keyDown(s.container.querySelector(".flow-canvas")!, { key: "z", ctrlKey: true });
  expect(s.text()).toBe(DFD);
  await waitFor(() => expect(last(callsTo("write_diagram"))?.text).toBe(crlf), { timeout: 3000 });
  // The layout keeps the old positions.
  const saved = JSON.parse(last(callsTo("write_diagram"))!.layout as string) as { nodes: Record<string, { x: number; y: number }> };
  expect(saved.nodes).toEqual(positions);
});

test("tool_result_recorded", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(FRAUD), answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await reviewing();
  // The thread is saved with the proposal in the answer's record, under the diagram's place.
  await waitFor(() => expect(saved.length).toBeGreaterThan(0));
  const thread = last(saved)!;
  expect(thread.place).toBe("diagram:checkout");
  const a = thread.messages.find((m) => m.role === "assistant")!;
  expect(a.record?.toolUse).toMatchObject({ tool: "propose_diagram_changes", file: "checkout", input: INPUT, outcome: null, proposal: proposal(FRAUD) });
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(1));
  const r = callsTo("ai_record_tool_result")[0];
  expect(r.threadId).toBe(thread.id);
  expect(r.messageAt).toBe(a.at);
  expect(r.outcome).toMatchObject({ accepted: 4, rejected: 0, auto: false });
  expect(typeof (r.outcome as { at: number }).at).toBe("number");

  // Rejecting everything records accepted 0 and leaves the text.
  await send("Add a fraud check after Checkout");
  await reviewing();
  const before = s.text();
  fireEvent.click(within(card()).getByRole("button", { name: "Reject all" }));
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(2));
  expect(callsTo("ai_record_tool_result")[1].outcome).toMatchObject({ accepted: 0, rejected: 4, auto: false });
  expect(s.text()).toBe(before);
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
});

test("no_proposal_text", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(null, "That diagram already checks for fraud.")];
  await send("Add a fraud check after Checkout");
  expect(await screen.findByText("That diagram already checks for fraud.")).toBeTruthy();
  expect(await screen.findByText("No changes proposed.")).toBeTruthy();
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect(screen.queryByRole("region", { name: "Changes to review" })).toBeNull();
  expect(callsTo("ai_record_tool_result")).toEqual([]);
});

test("thread_reloads_with_the_card", async () => {
  threads = [
    {
      id: "t1",
      place: "diagram:checkout",
      title: "Add a fraud check",
      updatedAt: 10,
      messages: [
        { role: "user", text: "Add a fraud check", context: [], at: 5 },
        {
          role: "assistant",
          text: "I'll add a fraud check between Checkout and Orders.",
          context: [],
          at: 6,
          record: {
            sent: null,
            usage: null,
            millis: null,
            stop: null,
            mark: null,
            error: null,
            sqlBlocks: [],
            notes: [],
            thinking: null,
            log: [],
            steps: [],
            actions: [],
            context: null,
            commandError: null,
            toolUse: { tool: "propose_diagram_changes", file: "checkout", input: "{}", proposal: proposal(FRAUD), outcome: { accepted: 4, rejected: 0, auto: false, at: 7 } },
          },
        },
      ],
    },
  ];
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  expect(await screen.findByText("Add a fraud check")).toBeTruthy();
  expect(callsTo("list_ai_threads")).toEqual([{ place: "diagram:checkout" }]);
  // The stored proposal shows again as its card, with nothing left to accept.
  const shown = await screen.findByRole("region", { name: "Changes" });
  expect(within(shown).getByText("4 changes")).toBeTruthy();
  expect(shown.querySelectorAll(".crow")).toHaveLength(4);
  expect(within(shown).queryByRole("button", { name: /^Accept/ })).toBeNull();
  // What the user did with it, from the saved outcome.
  expect(within(shown).getByText("Accepted 4 of 4.")).toBeTruthy();
  expect(assistantTab().querySelector(".pcount")).toBeNull();
  expect(s.view().state.readOnly).toBe(false);
  // A new Ask sends no history and adds to the same thread.
  replies = [answer(null)];
  await send("And a refund step");
  expect(asks()[0].threadId ?? null).toBeNull();
  await waitFor(() => expect(last(saved)?.messages).toHaveLength(4));
  expect(last(saved)!.id).toBe("t1");
});

test("nothing_in_the_side_panel_has_hover_text", async () => {
  const s = setup();
  await drawn(s);
  const panel = s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  const titles = () => [...panel.querySelectorAll("[title]")].map((e) => e.outerHTML.slice(0, 80));
  // A failed save: its message shows, with no hover text.
  failWrites = true;
  act(() => s.view().dispatch({ changes: { from: 0, insert: "// x\n" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull(), { timeout: 3000 });
  expect(titles()).toEqual([]);
  failWrites = false;
  // A working Ask streaming a code block, then a review card: none of it carries a title either.
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  act(() => sinks[0].onmessage({ type: "delta", text: "Like this:\n\n```\nSELECT * FROM orders;\n```\n" }));
  await waitFor(() => expect(panel.querySelector(".answer-code")).not.toBeNull());
  expect(titles()).toEqual([]);
  act(() => [{ type: "proposal", proposal: proposal(FRAUD), input: INPUT } as AiEvent, done()].forEach((e) => sinks[0].onmessage(e)));
  await reviewing();
  expect(panel.querySelector(".answer-code")).not.toBeNull();
  expect(titles()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));
  const rail = s.container.querySelector('nav[aria-label="Side panel, hidden"]') as HTMLElement;
  expect(rail.querySelectorAll("[title]")).toHaveLength(0);
});

test("a_failed_save_stops_the_send", async () => {
  const s = setup();
  await drawn(s);
  failWrites = true;
  act(() => s.view().dispatch({ changes: { from: 0, insert: "// x\n" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull(), { timeout: 3000 });
  fireEvent.click(assistantTab());
  fireEvent.change(box(), { target: { value: "Add a fraud check" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(await screen.findByText("Not saved, so nothing was sent. Save the diagram, then send it again.")).toBeTruthy();
  expect(callsTo("ai_diagram_ask")).toEqual([]);
  // Send empties the box and the refused send puts the question back in the next render.
  await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe("Add a fraud check"));
  expect(s.view().state.readOnly).toBe(false);
});

test("a_turn_or_outcome_that_could_not_be_kept_says_so", async () => {
  const s = setup();
  await drawn(s);
  // The models could not be listed: the panel says why.
  fireEvent.click(assistantTab());
  expect(await screen.findByText("No AI provider is set up. Connect one in Settings.")).toBeTruthy();
  failSave = true;
  replies = [answer(FRAUD), answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await reviewing();
  expect(await screen.findByText(/^Not saved: /)).toBeTruthy();
  // The turn still shows; its outcome is not sent for a thread the Core does not have.
  expect(screen.getByText("Add a fraud check after Checkout")).toBeTruthy();
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Fraud check"));
  expect(callsTo("ai_record_tool_result")).toEqual([]);

  // Saved, but the outcome fails: that shows too.
  failSave = false;
  failRecord = true;
  await send("Add a fraud check after Checkout");
  await reviewing();
  expect(screen.queryByText(/^Not saved: /)).toBeNull();
  fireEvent.click(within(card()).getByRole("button", { name: "Reject all" }));
  expect(await screen.findByText(/^Not saved: /)).toBeTruthy();
});

test("auto_apply_that_cannot_land_keeps_its_note", async () => {
  const s = setup();
  await drawn(s);
  // Many parses, so the restarted worker's count does not reach the version the Ask was made on.
  for (let i = 0; i < 4; i++) {
    act(() => s.view().dispatch({ changes: { from: s.text().length, insert: `// note ${i}\n` } }));
    await waitFor(() => expect(s.container.querySelector(".flow-saved")).toBeTruthy(), { timeout: 3000 });
  }
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.view().state.readOnly).toBe(true));
  act(() => (s.client as unknown as { worker: { onerror(): void } }).worker.onerror());
  await new Promise((r) => setTimeout(r, 50));
  act(() => answer(FRAUD).forEach((e) => sinks[0].onmessage(e)));
  // The text is no longer the one the changes were made against: the changed card, not a note. It changed in the
  // app, not on disk, so the card does not blame another program.
  expect(await screen.findByText("checkout.flow changed while I worked")).toBeTruthy();
  expect(screen.getByText("The text changed in the editor after the assistant answered, so none of these changes were applied.")).toBeTruthy();
  expect(screen.queryByText(/Another program changed the file/)).toBeNull();
  expect(screen.queryByText(/changed on disk/)).toBeNull();
  expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ask again on the current text" })).toBeTruthy();
  expect(s.text()).not.toContain("Fraud check");
});

test("the_remove_question_keeps_the_banner_and_bands_clear", async () => {
  const s = setup();
  await drawn(s);
  const redraw: ProposedChange[] = ["Customer", "Checkout", "Orders", "Charge card"].map((t, i) => change(i, { remove_node: { target: t } }));
  replies = [answer(redraw), answer(FRAUD)];
  await send("Start over");
  expect(await screen.findByText("Remove 4 shapes and 5 lines?")).toBeTruthy();
  // The editor says changes wait, with Reject all only.
  const banner = screen.getByText("4 changes from the assistant are marked below.").closest(".flow-ebar") as HTMLElement;
  expect([...banner.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Reject all"]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));

  // Review: a rejected row makes the banner count what lands; Show in the text bands lines; Reject all clears them.
  await send("Add a fraud check after Checkout");
  await reviewing();
  fireEvent.click(within(card().querySelectorAll(".crow")[2] as HTMLElement).getByRole("button", { name: "Reject this change" }));
  fireEvent.click(within(card()).getByRole("button", { name: "Show in the text" }));
  const bar = screen.getByText("3 changes from the assistant are marked below.").closest(".flow-ebar") as HTMLElement;
  expect(within(bar).getByRole("button", { name: "Accept 3" })).toBeTruthy();
  await waitFor(() => expect(s.container.querySelectorAll(".cm-line.cm-flow-band").length).toBeGreaterThan(0));
  fireEvent.click(within(bar).getByRole("button", { name: "Reject all" }));
  await waitFor(() => expect(s.container.querySelectorAll(".cm-line.cm-flow-band")).toHaveLength(0));
});

test("working_shows_the_core_steps_and_the_canvas_outline", async () => {
  const s = setup();
  await drawn(s);
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-ai-working")).not.toBeNull());
  act(() => {
    sinks[0].onmessage({ type: "status", step: "Reading checkout.flow" });
    sinks[0].onmessage({ type: "status", step: "Checking the changes" });
  });
  const steps = [...s.container.querySelectorAll(".flow-assist .step")].map((e) => [e.textContent, e.className]);
  expect(steps).toEqual([
    ["Reading checkout.flow", "step done"],
    ["Checking the changes", "step now"],
  ]);
  // The tabs say it in text, not a label on a bare span.
  expect(screen.getByRole("tab", { name: /^Editor/ }).textContent).toContain("Read-only");
  expect(assistantTab().textContent).toContain("Working");
  expect(s.container.querySelectorAll(".ptab [aria-label]")).toHaveLength(0);
  act(() => [done()].forEach((e) => sinks[0].onmessage(e)));
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-ai-working")).toBeNull());
});

// ----- the five error states (board 11.5)

const panelTitles = (s: Setup) => [...(s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement).querySelectorAll("[title]")].map((e) => e.outerHTML.slice(0, 80));
const Q = "Add a fraud check after Checkout";

test("file_changed_card_and_actions", async () => {
  const s = setup();
  await drawn(s);
  replies = [[failed({ kind: "fileChanged", file: "checkout", line: 5, nowReads: "Checkout [process, id: 9.9]" })]];
  await send(Q);
  expect(await screen.findByText("checkout.flow changed on disk while I worked")).toBeTruthy();
  expect(document.querySelector(".ccard.warnc2 .ebody")!.textContent).toBe(
    "Another program changed the file after you asked (line 5 now reads Checkout [process, id: 9.9], a git pull perhaps). These changes were made against the old text, so none of them were applied.",
  );
  expect([...document.querySelectorAll(".ccard.warnc2 button")].map((b) => b.textContent)).toEqual(["Discard", "Ask again on the current text"]);
  expect(panelTitles(s)).toEqual([]);
  // Nothing was applied, and the text is editable again.
  expect(s.text()).toBe(DFD);
  expect(s.view().state.readOnly).toBe(false);

  // Ask again reads the file, then sends the same question on what it holds.
  disk = DFD.replace("Checkout [process, id: 1.0]", "Checkout [process, id: 1.0]\nPack order [process, id: 1.5]");
  replies = [answer(null)];
  fireEvent.click(screen.getByRole("button", { name: "Ask again on the current text" }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].question).toBe(Q);
  expect(asks()[1].text).toBe(disk);
  expect(s.text()).toBe(disk);
  expect(screen.queryByText("checkout.flow changed on disk while I worked")).toBeNull();
  cleanup();

  // Discard drops the card and the kept question; nothing is sent.
  threads = [];
  const t = setup();
  await drawn(t);
  replies = [[failed({ kind: "fileChanged", file: "checkout", line: null, nowReads: null })]];
  await send(Q);
  await screen.findByRole("button", { name: "Discard" });
  expect((box() as HTMLTextAreaElement).value).toBe(Q);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByText("checkout.flow changed on disk while I worked")).toBeNull();
  expect((box() as HTMLTextAreaElement).value).toBe("");
  expect(asks()).toHaveLength(3);
});

test("stale_version_at_landing_shows_changed_card", async () => {
  const s = setup();
  await drawn(s);
  // Many parses, so the restarted worker's count does not reach the version the Ask was made on.
  for (let i = 0; i < 4; i++) {
    act(() => s.view().dispatch({ changes: { from: s.text().length, insert: `// note ${i}\n` } }));
    await waitFor(() => expect(s.container.querySelector(".flow-saved")).toBeTruthy(), { timeout: 3000 });
  }
  const before = s.text();
  holdAsk = true;
  await send(Q);
  await waitFor(() => expect(s.view().state.readOnly).toBe(true));
  // The worker restarts: the parse the proposal was made on is gone, so the landing does not apply.
  act(() => (s.client as unknown as { worker: { onerror(): void } }).worker.onerror());
  await new Promise((r) => setTimeout(r, 50));
  act(() => answer(FRAUD).forEach((e) => sinks[0].onmessage(e)));
  await reviewing();
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  expect(await screen.findByText("checkout.flow changed while I worked")).toBeTruthy();
  expect(screen.getByText("The text changed in the editor after the assistant answered, so none of these changes were applied.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Changes to review" })).toBeNull();
  expect(s.text()).toBe(before);
  // Discard lets the text go and records that nothing landed.
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect(callsTo("ai_record_tool_result")).toHaveLength(1);
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 0, rejected: 4 });
});

/** A fraud check whose first line goes after "the check": two shapes answer to it. */
const UNCLEAR: ProposedChange[] = [
  change(0, { add_node: { name: "Fraud check", kind: "process", id: "1.1" } }),
  {
    index: 1,
    op: { add_flow: { from: "the check", to: "Fraud check", label: "risk" } },
    status: {
      kind: "ambiguous",
      field: "from",
      word: "the check",
      candidates: [
        { name: "Checkout", id: "1.0", line: 4, detail: "line 4, order details" },
        { name: "Charge card", id: "2.0", line: 8, detail: "line 8, amount" },
      ],
    },
    dependsOn: [0],
  },
];

test("unclear_pick_resolves_and_lands", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(UNCLEAR)];
  await send(Q);
  expect(await screen.findByText('Two shapes could be "the check": which one should come after the new step?')).toBeTruthy();
  const picks = [...document.querySelectorAll(".pickrow")].map((b) => b.textContent);
  expect(picks).toEqual(["1.0Checkoutline 4, order details", "2.0Charge cardline 8, amount"]);
  expect(screen.getByText("Nothing changes until you pick.")).toBeTruthy();
  expect(panelTitles(s)).toEqual([]);
  // Nothing changed yet, and the text is still held.
  expect(s.text()).toBe(DFD);
  // The lock is drawn only while the assistant works: the text is free to type in, and nothing holds it.
  expect(s.view().state.readOnly).toBe(false);
  expect(flowEntry("checkout")?.isHeld?.()).toBe(false);
  fireEvent.click(document.querySelectorAll(".pickrow")[0]);
  // Review first: the word is now the shape's name, in the review card.
  await reviewing();
  // The review holds the text again.
  expect(s.view().state.readOnly).toBe(true);
  expect(rows()).toEqual([
    ["+", "Fraud check [process, id: 1.1]", false],
    ["+", "Checkout > Fraud check: risk", false],
  ]);
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Checkout > Fraud check: risk"));
  expect(s.text()).toContain("Fraud check [process, id: 1.1]");
  cleanup();

  // Auto-apply goes on to land it at once.
  const t = setup();
  await drawn(t);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [answer(UNCLEAR)];
  await send(Q);
  fireEvent.click((await screen.findAllByRole("button", { name: /Charge card/ }))[0]);
  await waitFor(() => expect(t.text()).toContain("Charge card > Fraud check: risk"));
  expect(screen.getByText(/^Done\. I added Fraud check and 1 line/)).toBeTruthy();
});

test("unclear_cancel_changes_nothing", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(UNCLEAR)];
  await send(Q);
  await screen.findByText('Two shapes could be "the check": which one should come after the new step?');
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect(s.text()).toBe(DFD);
  expect(document.querySelector(".pickrow")).toBeNull();
  await waitFor(() => expect(callsTo("ai_record_tool_result")).toHaveLength(1));
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 0 });
});

const DROP: ProposedChange = {
  index: 4,
  op: { add_flow: { from: "Fraud check", to: "Shipping", label: "held" } },
  status: { kind: "dropped", reason: "unknownShape", message: "there is no shape called Shipping in this diagram" },
  dependsOn: [0],
};

test("checker_card_texts", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer([...FRAUD, DROP])];
  await send(Q);
  await reviewing();
  expect(within(card()).getByText("4 of 5 changes")).toBeTruthy();
  const dropped = card().querySelector(".crow.dropped") as HTMLElement;
  expect([dropped.querySelector(".mk")!.textContent, dropped.querySelector(".dtag")!.textContent]).toEqual(["!", "dropped"]);
  expect(within(card()).getByText("Contura dropped one change: there is no shape called Shipping in this diagram. The other 4 still fit together.")).toBeTruthy();
  expect([...card().querySelectorAll(".ccard-foot button")].map((b) => b.textContent)).toEqual(["Reject all", "Ask to fix it", "Accept 4Ctrl+Enter"]);
  expect(panelTitles(s)).toEqual([]);
});

test("ask_to_fix_it_question", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer([...FRAUD, DROP]), answer(null)];
  await send(Q);
  await reviewing();
  fireEvent.click(within(card()).getByRole("button", { name: "Ask to fix it" }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].question).toBe("Some changes could not be used: there is no shape called Shipping in this diagram. Propose them again so they fit this diagram.");
  // A new Ask on the current text; the first set was left (recorded as none accepted).
  expect(asks()[1].text).toBe(DFD);
  expect(callsTo("ai_record_tool_result")[0].outcome).toMatchObject({ accepted: 0 });
  expect(s.text()).toBe(DFD);
});

test("would_break_card_and_review", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  // A new shape of a kind the diagram does not know: the text would have a problem.
  const clash = [change(0, { add_node: { name: "Fraud check", kind: "bogus", id: "1.1" } })];
  replies = [answer(clash), answer(null)];
  await send(Q);
  expect(await screen.findByText("Not applied: the text would have a problem")).toBeTruthy();
  const body = document.querySelector(".ccard.warnc2 .ebody")!.textContent!;
  expect(body).not.toContain("..");
  expect(body).toMatch(/^With these changes, line \d+ would read Fraud check \[bogus, id: 1\.1\]: .+\. Auto-apply never lands a change that leaves a problem, so checkout\.flow is as it was\.$/);
  expect(s.text()).toBe(DFD);
  expect([...document.querySelectorAll(".ccard.warnc2 .efoot button")].map((b) => b.textContent)).toEqual(["Review the changes", "Ask to fix it"]);
  expect(panelTitles(s)).toEqual([]);

  // Review the changes opens the review card.
  fireEvent.click(screen.getByRole("button", { name: "Review the changes" }));
  await reviewing();
  expect(rows()).toEqual([["+", "Fraud check [bogus, id: 1.1]", false]]);
  fireEvent.click(within(card()).getByRole("button", { name: "Reject all" }));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  replies = [answer(clash), answer(null)];
  await send(Q);
  await screen.findByText("Not applied: the text would have a problem");
  const message = body.replace(/^.*would read Fraud check \[bogus, id: 1\.1\]: /, "").replace(/\. Auto-apply never.*$/, "");
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(asks()[2].question).toBe(`Some changes could not be used: ${message}. Propose them again so they fit this diagram.`);
});

test("provider_error_keeps_the_question", async () => {
  const s = setup();
  await drawn(s);
  // No Sent record: the Ask leaves nothing, and the composer gets its question back.
  replies = [[failed({ kind: "network", host: "api.groq.com" })], answer(null)];
  await send(Q);
  expect(await screen.findByText("Could not reach api.groq.com.")).toBeTruthy();
  expect(screen.getByText("Nothing was changed. Your request is kept below, so you can send it again.")).toBeTruthy();
  expect((box() as HTMLTextAreaElement).value).toBe(Q);
  expect(panelTitles(s)).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].question).toBe(Q);
  expect((box() as HTMLTextAreaElement).value).toBe("");
  await waitFor(() => expect(screen.queryByText("Could not reach api.groq.com.")).toBeNull());
  cleanup();

  // The rate limit counts down as in the thread; with a Sent record the turn is kept and shows the same card.
  const t = setup();
  await drawn(t);
  replies = [[sent(), failed({ kind: "rateLimited", retryAfterSecs: 20 })]];
  await send(Q);
  expect(await screen.findByText("The provider is limiting requests.")).toBeTruthy();
  expect(screen.getByText(/^Retrying in 20s\./)).toBeTruthy();
  expect(screen.getByText("Nothing was changed. Your request is kept below, so you can send it again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
  // The question comes back once the kept turn is saved, which can land a tick after the card.
  await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe(Q));
  expect(panelTitles(t)).toEqual([]);
});

test("tool_rejected_and_bad_input_texts", async () => {
  const s = setup();
  await drawn(s);
  replies = [[failed({ kind: "toolRejected", name: "run_sql" })], [failed({ kind: "badToolInput" })], [failed({ kind: "badFileName" })]];
  await send(Q);
  expect(await screen.findByText("The assistant asked for a tool Contura does not offer. Nothing was changed.")).toBeTruthy();
  // Only the brief's line and Retry: the kept-request line belongs to the provider card.
  expect(screen.queryByText(/Your request is kept below/)).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("The assistant's changes could not be read. Nothing was changed.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("This diagram's file name holds a character the assistant cannot send. Rename the file and ask again.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(panelTitles(s)).toEqual([]);
});

test("a_set_that_does_not_fit_says_so", async () => {
  const s = setup();
  await drawn(s);
  // Charge card has no line to Orders: the Core passed the change, but it does not land on the text.
  replies = [answer([change(0, { remove_flow: { from: "Charge card", to: "Orders", label: null } })])];
  await send(Q);
  await reviewing();
  fireEvent.click(within(card()).getByRole("button", { name: /^Accept all/ }));
  expect(await screen.findByText("These changes do not fit together. Review them again, or ask to fix it.")).toBeTruthy();
  expect(screen.queryByText(/The text changed meanwhile/)).toBeNull();
  expect(s.text()).toBe(DFD);
});

test("an_answer_shows_its_notes", async () => {
  const s = setup();
  await drawn(s);
  const note = "checkout.flow: Text in this diagram looks like it gives the assistant instructions. Read its changes with care.";
  replies = [[{ type: "delta", text: "I'll add a fraud check." }, done({ notes: [note] })]];
  await send(Q);
  const shown = await screen.findByText(note);
  // Built as the database Ask panel draws a note: above the answer, with its icon.
  const p = shown.closest("p")!;
  expect(p.classList.contains("answer-note")).toBe(true);
  expect(p.getAttribute("role")).toBe("note");
  const said = screen.getByText("I'll add a fraud check.");
  expect(shown.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("older_failed_turns_have_no_stale_actions", async () => {
  const s = setup();
  await drawn(s);
  // Two failed turns: the older shows the text alone, only the newest can be discarded or asked again.
  replies = [[sent(), failed({ kind: "fileChanged", file: "checkout", line: 5, nowReads: "x" })], [sent(), failed({ kind: "fileChanged", file: "checkout", line: 6, nowReads: "y" })]];
  await send("First question");
  await screen.findByRole("button", { name: "Discard" });
  fireEvent.click(screen.getByRole("button", { name: "Ask again on the current text" }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  await waitFor(() => expect(screen.getAllByText("checkout.flow changed on disk while I worked").length).toBe(2));
  expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Ask again on the current text" })).toHaveLength(1);
  cleanup();

  // A reloaded thread's failed turn shows the card text with no actions.
  const record = { sent: null, usage: null, millis: null, stop: null, mark: "failed", error: { kind: "fileChanged", file: "checkout", line: 5, nowReads: "x" }, sqlBlocks: [], notes: [], thinking: null, log: [], steps: [], actions: [], context: null, commandError: null, toolUse: null };
  threads = [
    {
      id: "t9",
      place: "diagram:checkout",
      title: "Old",
      updatedAt: 10,
      messages: [
        { role: "user", text: "Old question", context: [], at: 5 },
        { role: "assistant", text: "", context: [], at: 6, record },
        { role: "user", text: "Newer question", context: [], at: 7 },
        { role: "assistant", text: "Fine.", context: [], at: 8 },
      ],
    } as unknown as AiThread,
  ];
  const t = setup();
  await drawn(t);
  fireEvent.click(assistantTab());
  expect(await screen.findByText("checkout.flow changed on disk while I worked")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Ask again on the current text" })).toBeNull();
  expect(asks()).toHaveLength(2);
});

test("an_unfitting_pick_says_so_and_stays", async () => {
  const s = setup();
  await drawn(s);
  // Checkout has a line to Orders; Charge card has none.
  const unfit: ProposedChange[] = [
    {
      index: 0,
      op: { remove_flow: { from: "the check", to: "Orders", label: null } },
      status: {
        kind: "ambiguous",
        field: "from",
        word: "the check",
        candidates: [
          { name: "Charge card", id: "2.0", line: 8, detail: "line 8, amount" },
          { name: "Checkout", id: "1.0", line: 4, detail: "line 4, order details" },
        ],
      },
      dependsOn: [],
    },
  ];
  replies = [answer(unfit)];
  await send(Q);
  await screen.findByText(/^Two shapes could be "the check": which one did you mean\?/);
  fireEvent.click(document.querySelectorAll(".pickrow")[0]);
  expect(await screen.findByText("That choice does not fit the text. Pick another, or cancel.")).toBeTruthy();
  expect(document.querySelectorAll(".pickrow")).toHaveLength(2);
  expect(s.text()).toBe(DFD);
  fireEvent.click(document.querySelectorAll(".pickrow")[1]);
  await reviewing();
  expect(rows()).toEqual([["-", "Checkout > Orders", false]]);
});

test("the_hold_is_released_when_the_tab_closes", async () => {
  const s = setup();
  await drawn(s);
  replies = [answer(FRAUD)];
  await send(Q);
  await reviewing();
  const entry = flowEntry("checkout")!;
  expect(entry.isHeld?.()).toBe(true);
  s.unmount();
  expect(entry.isHeld?.()).toBe(false);
});

test("a_message_ending_in_a_full_stop_is_not_doubled", async () => {
  const s = setup();
  await drawn(s);
  const stopped: ProposedChange = { ...DROP, status: { kind: "dropped", reason: "unknownShape", message: "there is no shape called Shipping." } };
  replies = [answer([...FRAUD, stopped]), answer(null)];
  await send(Q);
  await reviewing();
  expect(within(card()).getByText("Contura dropped one change: there is no shape called Shipping. The other 4 still fit together.")).toBeTruthy();
  fireEvent.click(within(card()).getByRole("button", { name: "Ask to fix it" }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].question).toBe("Some changes could not be used: there is no shape called Shipping. Propose them again so they fit this diagram.");
});

// ----- Sends, Show log and the tool-off note (board 11.12)

const previews = () => callsTo("ai_diagram_preview").map((c) => c.request as DiagramAskRequest);
const sendsBox = () => screen.getByRole("group", { name: "Sends" });

test("diagram_sends_rows_locked_on", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.change(box(), { target: { value: "Add a fraud check" } });
  // The Sends line comes from the Core's preview of this Ask, once typing settles.
  await waitFor(() => expect(previews().some((r) => r.question === "Add a fraud check")).toBe(true));
  const r = last(previews())!;
  expect(r.file).toBe("checkout");
  expect(r.text).toBe(s.text());
  expect(r.scope).toEqual({ kind: "whole" });
  expect(r.outline.nodes.map((n) => n.name)).toContain("Charge card");
  const rows = async () => {
    await waitFor(() => expect(within(sendsBox()).getAllByRole("listitem").length).toBeGreaterThan(1));
    return within(sendsBox())
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".send-pill")!.textContent);
  };
  expect(await rows()).toEqual(["Question", "checkout.flow"]);
  for (const pill of sendsBox().querySelectorAll(".send-pill")) expect(pill.getAttribute("aria-disabled")).toBe("true");
  expect(within(sendsBox()).getByText("The changes are written against this text")).toBeTruthy();
  // A selection adds its locked row.
  act(() => canvas.props!.onSelect!(["Customer", "Checkout", "Orders"]));
  fireEvent.click(screen.getByRole("button", { name: "Whole diagram" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "3 selected" }));
  await waitFor(() => expect(last(previews())!.scope).toEqual({ kind: "selection", names: ["Customer", "Checkout", "Orders"] }));
  await waitFor(async () => expect(await rows()).toEqual(["Question", "checkout.flow", "Selection, 3 shapes"]));
  const panel = s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  expect(panel.querySelectorAll("[title]")).toHaveLength(0);
});

test("show_exactly_is_the_turn", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.change(box(), { target: { value: "Add a fraud check" } });
  await waitFor(() => expect(within(sendsBox()).getAllByRole("listitem")).toHaveLength(2));
  fireEvent.click(within(sendsBox()).getByRole("button", { name: "Show exactly" }));
  const exact = sendsBox().querySelector("pre.payload")!.textContent!;
  expect(exact).toBe(previewOf(last(previews())!).exact);
  expect(exact.endsWith("File: checkout.flow. base_hash: 3f9a0c1e7b2d4a55.\n\nQuestion: Add a fraud check")).toBe(true);
  expect(within(sendsBox()).getByText("To Groq, openai/gpt-oss-20b.")).toBeTruthy();
});

test("sends_never_previews_while_an_ask_runs", async () => {
  const s = setup();
  await drawn(s);
  holdAsk = true;
  await send("Add a fraud check after Checkout");
  const before = previews().length;
  act(() => canvas.props!.onSelect!(["Customer"]));
  await new Promise((r) => setTimeout(r, 400));
  expect(previews().length).toBe(before);
});

test("sent_line_and_show_log_for_a_diagram_answer", async () => {
  const s = setup();
  await drawn(s);
  replies = [
    [
      sent({ kinds: ["question", "diagram"], bytes: 2911 }),
      step("diagram", "checkout.flow, 2,418 B", { rule: "Diagrams are not database data: no AI access level applies." }),
      step("request", "2,911 B, one tool"),
      step("answer", "1 tool call, by the model", { byModel: true }),
      step("toolCheck", "4 proposed, 0 dropped", { evidence: [["#1 add_node", "ok", "kept"]] }),
      ...answer(FRAUD),
    ],
  ];
  await send("Add a fraud check after Checkout");
  await reviewing();
  // The Sent line names the one tool, and opens the Sent record.
  const line = await screen.findByRole("button", { name: /Sent 2,911 B to Groq, gpt-oss-20b, one tool/ });
  fireEvent.click(line);
  const record = screen.getByRole("dialog", { name: "Sent record" });
  expect(within(record).getByText("your question, the diagram text")).toBeTruthy();
  expect(within(record).getByText("propose_diagram_changes, counted in Size and Hash")).toBeTruthy();
  fireEvent.click(within(record).getByRole("button", { name: "Close" }));
  // Show log takes the panel's place, on Steps, and Back returns to the thread.
  fireEvent.click(screen.getByRole("button", { name: "Show log" }));
  const log = screen.getByRole("region", { name: "Answer log" });
  expect(within(log).getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(within(log).getByText("Tool check")).toBeTruthy();
  // The Tool check row opens expanded (board 11.12).
  expect(within(log).getByText("Tool check").closest(".prow")!.getAttribute("aria-expanded")).toBe("true");
  expect([...log.querySelectorAll(".prow")].filter((r) => r.getAttribute("aria-expanded") === "true").map((r) => r.querySelector(".lb")!.textContent)).toEqual(["Tool check"]);
  expect(screen.queryByRole("textbox", { name: "Describe a change" })).toBeNull();
  const panel = s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  expect(panel.querySelectorAll("[title]")).toHaveLength(0);
  fireEvent.click(within(log).getByRole("button", { name: "Back to the answer" }));
  expect(screen.getByRole("region", { name: "Changes to review" })).toBeTruthy();
  expect(box()).toBeTruthy();
});

test("an_error_card_has_show_log", async () => {
  const s = setup();
  await drawn(s);
  replies = [[sent({ kinds: ["question", "diagram"] }), step("diagram", "checkout.flow, 2,418 B"), failed({ kind: "badToolInput" })]];
  await send("Add a fraud check");
  await screen.findByText("The assistant's changes could not be read. Nothing was changed.");
  fireEvent.click(screen.getByRole("button", { name: "Show log" }));
  const log = screen.getByRole("region", { name: "Answer log" });
  expect([...log.querySelectorAll(".prow .lb")].map((l) => l.textContent)).toEqual(["Diagram"]);
});

test("tool_off_note_and_open_settings", async () => {
  toolOn = false;
  const onOpenSettings = vi.fn();
  const s = setup({ onOpenSettings });
  await drawn(s);
  fireEvent.click(assistantTab());
  const note = await screen.findByText("The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.");
  expect(screen.queryByRole("textbox", { name: "Describe a change" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Sends" })).toBeNull();
  expect(callsTo("ai_diagram_preview")).toHaveLength(0);
  fireEvent.click(within(note.closest(".ccard") as HTMLElement).getByRole("button", { name: "Open Settings" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  const panel = s.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  expect(panel.querySelectorAll("[title]")).toHaveLength(0);
});

test("a_tool_off_error_shows_the_same_note", async () => {
  const s = setup({ onOpenSettings: () => {} });
  await drawn(s);
  fireEvent.click(assistantTab());
  // Turned off in Settings after the tab read it: the Core refuses the Ask.
  const ask = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "ai_diagram_ask") throw { kind: "ai", message: { kind: "toolOff" } };
    return ask(cmd, args as never);
  });
  fireEvent.change(box(), { target: { value: "Add a fraud check" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(await screen.findByText("The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Describe a change" })).toBeNull();
});

test("the_switch_is_read_again_when_the_assistant_comes_back", async () => {
  toolOn = false;
  const s = setup({ onOpenSettings: () => {} });
  await drawn(s);
  fireEvent.click(assistantTab());
  await screen.findByText("The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.");
  // Turned on in Settings while the Editor was in view: the composer and its Sends line come back.
  fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
  toolOn = true;
  fireEvent.click(assistantTab());
  expect(await screen.findByRole("textbox", { name: "Describe a change" })).toBeTruthy();
  expect(screen.queryByText("The assistant cannot suggest diagram changes: Propose diagram changes is off in Settings.")).toBeNull();
  await waitFor(() => expect(previews().length).toBeGreaterThan(0));
});

test("a_refused_preview_shows_why_in_the_sends_line", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.change(box(), { target: { value: "Add a fraud check" } });
  await waitFor(() => expect(within(sendsBox()).getAllByRole("listitem")).toHaveLength(2));
  previewError = { kind: "ai", message: { kind: "badFileName" } };
  fireEvent.change(box(), { target: { value: "Add a fraud check now" } });
  expect(await within(sendsBox()).findByText("This diagram's file name holds a character the assistant cannot send. Rename the file and ask again.")).toBeTruthy();
  expect(within(sendsBox()).queryAllByRole("listitem")).toHaveLength(0);
});

// ---- Parity with the step 11 boards (P11) ----

test("parity_P11_18_the_model_picker_follows_a_model_change_in_settings", async () => {
  known = modelList([modelInfo({ id: "fx-stall", name: "fx-stall" })], null, "fx-stall");
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  expect(await screen.findByRole("button", { name: "Model: fx-stall" })).toBeTruthy();
  // Settings saves another model while the .flow tab stays open.
  known = modelList([modelInfo({ id: "fx-diagram", name: "fx-diagram" })], null, "fx-diagram");
  await act(async () => {
    await saveAiSettings(null, { ...GROQ, model: "fx-diagram" }, false, { t: "keep" });
  });
  expect(await screen.findByRole("button", { name: "Model: fx-diagram" })).toBeTruthy();
});

test("parity_P11_34_the_first_added_shape_is_brought_into_view", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await waitFor(() => expect(s.text()).toContain("Fraud check [process, id: 1.1]"));
  // The canvas is asked to show the new shape, so its ring is seen.
  await waitFor(() => expect(canvas.props?.reveal).toBe("Fraud check"));
});

test("parity_P11_34_undoing_the_landing_removes_its_undo", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await screen.findByText(/^Done\. I added Fraud check/);
  expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
  // Ctrl+Z on the canvas takes the landing back: the card no longer offers Undo.
  fireEvent.keyDown(s.container.querySelector(".flow-canvas")!, { key: "z", ctrlKey: true });
  expect(s.text()).toBe(DFD);
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull());
  expect(screen.getByText(/^Done\. I added Fraud check/)).toBeTruthy();
});

test("a_redo_after_undo_offers_undo_again", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await screen.findByText(/^Done\. I added Fraud check/);
  const landedText = s.text();
  const canvasEl = s.container.querySelector(".flow-canvas")!;
  fireEvent.keyDown(canvasEl, { key: "z", ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull());
  // Ctrl+Y brings the landing back: the card offers Undo and "Show in the text" again.
  fireEvent.keyDown(canvasEl, { key: "y", ctrlKey: true });
  expect(s.text()).toBe(landedText);
  expect(await screen.findByRole("button", { name: /^Undo/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show in the text" })).toBeTruthy();
  // And Undo from the card takes it back once more.
  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(s.text()).toBe(DFD);
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull());
});

test("parity_P11_24_a_second_rate_limit_in_a_row_is_not_retried_on_its_own", async () => {
  const s = setup();
  await drawn(s);
  // The request left both times (a Sent record), as with a real provider.
  replies = [
    [sent(), failed({ kind: "rateLimited", retryAfterSecs: 1 })],
    [sent(), failed({ kind: "rateLimited", retryAfterSecs: 1 })],
    answer(null),
  ];
  await send(Q);
  expect(await screen.findByText(/^Retrying in 1s\./)).toBeTruthy();
  // The first one retries on its own once the wait is over.
  await waitFor(() => expect(asks()).toHaveLength(2), { timeout: 3000 });
  // The second in a row leaves Retry to the user (the first turn's card, now older, says the same without actions).
  await waitFor(() => expect(screen.queryByText(/^Retrying in/)).toBeNull());
  expect(await screen.findAllByText("The provider asks to wait 1s. Retry when the wait is over. Nothing was answered yet.")).toHaveLength(2);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2500));
  });
  expect(asks()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("parity_P11_18_a_failed_settings_read_after_a_change_says_so", async () => {
  known = modelList([modelInfo({ id: "fx-stall", name: "fx-stall" })], null, "fx-stall");
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  await screen.findByRole("button", { name: "Model: fx-stall" });
  settingsFail = { kind: "store", message: "the store is locked" };
  await act(async () => {
    await saveAiSettings(null, { ...GROQ, model: "fx-diagram" }, false, { t: "keep" });
  });
  expect(await screen.findByText(/^Could not read the AI settings\./)).toBeTruthy();
});

test("parity_P11_34_undoing_the_landing_hides_show_in_the_text", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(assistantTab());
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [answer(FRAUD)];
  await send("Add a fraud check after Checkout");
  await screen.findByText(/^Done\. I added Fraud check/);
  expect(screen.getByRole("button", { name: "Show in the text" })).toBeTruthy();
  fireEvent.keyDown(s.container.querySelector(".flow-canvas")!, { key: "z", ctrlKey: true });
  expect(s.text()).toBe(DFD);
  // The lines it pointed at are gone, so it has nothing to show.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Show in the text" })).toBeNull());
});

test("parity_P11_24_a_successful_retry_resets_the_rate_limit_count", async () => {
  const s = setup();
  await drawn(s);
  replies = [
    [sent(), failed({ kind: "rateLimited", retryAfterSecs: 1 })],
    answer([...FRAUD, DROP]),
    [sent(), failed({ kind: "rateLimited", retryAfterSecs: 1 })],
    answer(null),
  ];
  await send(Q);
  // The first rate limit retries on its own, and that retry answers.
  await waitFor(() => expect(asks()).toHaveLength(2), { timeout: 3000 });
  await reviewing();
  // A rate limit on another path (Ask to fix it) is the first in a row again: it counts down and retries once.
  fireEvent.click(within(card()).getByRole("button", { name: "Ask to fix it" }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(await screen.findByText(/^Retrying in 1s\./)).toBeTruthy();
  await waitFor(() => expect(asks()).toHaveLength(4), { timeout: 3000 });
});
