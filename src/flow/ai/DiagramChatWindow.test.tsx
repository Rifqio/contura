// The diagram chat draws the newest 20 turns (memory: a long thread kept every turn's DOM): earlier ones wait behind
// "Show <n> earlier", and an earlier proposal card is one line saying what became of it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { textStore } from "../../assistant/answerStream";
import type { AiMessage, AiThread, ProposedChange, ToolOutcome } from "../../api/types";
import { routeInvoke } from "../../test/invoke";
import { GROQ } from "../../test/settingsRoutes";
import DiagramAssistant from "./DiagramAssistant";
import { foldedOutcome } from "./proposal";
import type { DiagramAsk } from "./useDiagramAsk";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  routeInvoke({
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => null,
  });
});
afterEach(() => cleanup());

const ok = { kind: "ok" } as const;
const CHANGES: ProposedChange[] = [
  { index: 0, op: { add_node: { name: "Check", kind: "process", id: "1.1" } }, status: ok, dependsOn: [] },
  { index: 1, op: { add_flow: { from: "Checkout", to: "Check", label: "risk" } }, status: ok, dependsOn: [0] },
];

/** One Ask with its proposal, rejected as Run D's asks were. */
const turn = (n: number, outcome: ToolOutcome | null = { accepted: 0, rejected: 2, auto: false, at: n }): AiMessage[] => [
  { role: "user", text: `add a step called Check ${n}`, context: [], at: n * 10 },
  {
    role: "assistant",
    text: `Adding Check ${n}.`,
    context: [],
    at: n * 10 + 1,
    record: { toolUse: { tool: "propose_diagram_changes", file: "checkout", input: "{}", proposal: { file: "checkout", baseHash: "b", changes: CHANGES }, outcome } } as never,
  },
];

const fakeAi = (thread: AiThread | null): DiagramAsk =>
  ({
    place: "diagram:checkout",
    version: 1,
    preview: async () => null,
    thread,
    working: null,
    streamed: textStore(),
    waiting: null,
    landed: null,
    failure: null,
    airing: new Set(),
    pending: 0,
    locked: false,
    ghost: null,
    lines: [],
    overlay: null,
    removal: null,
    notSaved: null,
    clearFailure: () => {},
    send: async () => {},
    stop: () => {},
  }) as unknown as DiagramAsk;

const panel = (ai: DiagramAsk) => <DiagramAssistant ai={ai} name="checkout" kind="dfd" selected={[]} mode="review" onMode={() => {}} onShowText={() => {}} onUndo={() => {}} />;
const chatNodes = () => document.querySelector(".flow-chat")!.querySelectorAll("*").length;

test("the_chat_dom_stays_bounded_across_50_asks", () => {
  const thread: AiThread = { id: "t1", place: "diagram:checkout", title: "Check", messages: [], updatedAt: 1 };
  const view = render(panel(fakeAi(thread)));
  const counts: number[] = [];
  for (let n = 1; n <= 50; n++) {
    thread.messages = [...thread.messages, ...turn(n)];
    view.rerender(panel(fakeAi({ ...thread })));
    counts.push(chatNodes());
  }
  // It grows with each of the first 20 turns, then stays put: the 21st turn on adds only the "Show 20 earlier" row.
  expect(counts[19]).toBeGreaterThan(counts[0]);
  const after = counts.slice(20);
  expect(Math.max(...after)).toBe(Math.min(...after));
  expect(after[0] - counts[19]).toBeLessThanOrEqual(2);
  expect(screen.getByRole("button", { name: "Show 20 earlier" })).toBeTruthy();
  expect(screen.queryByText("add a step called Check 30")).toBeNull();
  expect(screen.getByText("add a step called Check 31")).toBeTruthy();
});

test("show_earlier_brings_back_turns_with_their_cards_as_one_line", () => {
  const thread: AiThread = { id: "t1", place: "diagram:checkout", title: "Check", updatedAt: 1, messages: [] };
  for (let n = 1; n <= 25; n++) thread.messages.push(...turn(n, n === 2 ? { accepted: 2, rejected: 0, auto: false, at: 1 } : n === 3 ? { accepted: 1, rejected: 1, auto: false, at: 1 } : n === 4 ? null : undefined));
  render(panel(fakeAi(thread)));
  // The newest 20 turns keep their full cards.
  expect(screen.getAllByRole("region", { name: "Changes" })).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "Show 5 earlier" }));
  expect(screen.queryByRole("button", { name: /earlier/ })).toBeNull();
  expect(screen.getByText("add a step called Check 1")).toBeTruthy();
  expect(screen.getAllByRole("region", { name: "Changes" })).toHaveLength(20);
  expect(screen.getByText("Applied: 2 changes.")).toBeTruthy();
  expect(screen.getByText("Partly applied: 1 of 2 changes.")).toBeTruthy();
  expect(screen.getByText("Not reviewed: 2 changes.")).toBeTruthy();
  expect(screen.getAllByText("Rejected: 2 changes.")).toHaveLength(2);
});

test("folded_outcome_wording", () => {
  expect(foldedOutcome(CHANGES, { accepted: 2, rejected: 0, auto: true, at: 1 })).toBe("Applied: 2 changes.");
  expect(foldedOutcome([...CHANGES, { ...CHANGES[0], index: 2, status: { kind: "dropped", message: "x" } } as ProposedChange], null)).toBe("Not reviewed: 2 of 3 changes.");
});
