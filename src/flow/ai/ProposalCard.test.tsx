import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ProposedChange } from "../../api/types";
import ProposalCard, { BrokenCard, droppedNote, PickCard, StaleCard } from "./ProposalCard";

afterEach(() => cleanup());

const ok = { kind: "ok" } as const;
const CHANGES: ProposedChange[] = [
  { index: 0, op: { add_node: { name: "Fraud check", kind: "process", id: "1.1" } }, status: ok, dependsOn: [] },
  { index: 1, op: { add_flow: { from: "Checkout", to: "Fraud check", label: "risk" } }, status: ok, dependsOn: [0] },
  { index: 2, op: { remove_flow: { from: "Checkout", to: "Orders", label: null } }, status: ok, dependsOn: [] },
];
const DROPPED: ProposedChange = {
  index: 3,
  op: { add_flow: { from: "Fraud check", to: "Shipping", label: "held" } },
  status: { kind: "dropped", reason: "unknownShape", message: "there is no shape called Shipping in this diagram" },
  dependsOn: [],
};

function renderCard(changes: ProposedChange[], rejected: number[] = []) {
  const on = { onReject: vi.fn(), onAccept: vi.fn(), onRejectAll: vi.fn(), onAcceptAll: vi.fn(), onShowText: vi.fn() };
  const utils = render(<ProposalCard changes={changes} kind="dfd" rejected={new Set(rejected)} {...on} />);
  return { ...on, ...utils };
}

const accept = () => screen.getByRole("button", { name: /^Accept (all|\d)/ });

test("accept_label_counts", () => {
  renderCard(CHANGES);
  expect(screen.getByText("3 changes")).toBeTruthy();
  expect(accept().textContent).toBe("Accept allCtrl+Enter");
  cleanup();

  // One rejected: the button counts what lands.
  renderCard(CHANGES, [2]);
  expect(screen.getByText("3 changes")).toBeTruthy();
  expect(accept().textContent).toBe("Accept 2Ctrl+Enter");
  cleanup();

  // A dropped change: "<k> of <n> changes", and the rest is counted.
  renderCard([...CHANGES, DROPPED]);
  expect(screen.getByText("3 of 4 changes")).toBeTruthy();
  expect(accept().textContent).toBe("Accept 3Ctrl+Enter");
  const rows = document.querySelectorAll(".crow");
  expect(rows[3].querySelector(".mk")!.textContent).toBe("!");
  expect(within(rows[3] as HTMLElement).queryByRole("button")).toBeNull();
  cleanup();

  // Everything rejected: nothing to accept.
  renderCard(CHANGES, [0, 1, 2]);
  expect((screen.getByRole("button", { name: /^Accept 0/ }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  // One change reads in the singular.
  renderCard([CHANGES[2]]);
  expect(screen.getByText("1 change")).toBeTruthy();
});

test("rows_and_actions", () => {
  const on = renderCard(CHANGES, [1]);
  const rows = [...document.querySelectorAll(".crow")].map((r) => [r.querySelector(".mk")!.textContent, r.querySelector(".tx")!.textContent]);
  expect(rows).toEqual([
    ["+", "Fraud check [process, id: 1.1]"],
    ["+", "Checkout > Fraud check: risk"],
    ["-", "Checkout > Orders"],
  ]);
  const row = (i: number) => document.querySelectorAll(".crow")[i] as HTMLElement;
  expect(row(1).classList.contains("off")).toBe(true);
  expect(within(row(1)).getByRole("button", { name: "Accept this change" }).getAttribute("aria-pressed")).toBe("false");
  expect(within(row(0)).getByRole("button", { name: "Accept this change" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(row(0)).getByRole("button", { name: "Reject this change" }));
  expect(on.onReject).toHaveBeenCalledWith(0);
  fireEvent.click(within(row(1)).getByRole("button", { name: "Accept this change" }));
  expect(on.onAccept).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
  expect(on.onRejectAll).toHaveBeenCalled();
  fireEvent.click(accept());
  expect(on.onAcceptAll).toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("region", { name: "Changes to review" }), { key: "Enter", ctrlKey: true });
  expect(on.onAcceptAll).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Show in the text" }));
  expect(on.onShowText).toHaveBeenCalled();
  // No hover text anywhere on the card.
  expect(document.querySelectorAll("[title]")).toHaveLength(0);
});

test("a_card_that_only_shows", () => {
  render(<ProposalCard changes={CHANGES} kind="dfd" />);
  const card = screen.getByRole("region", { name: "Changes" });
  expect(within(card).getByText("3 changes")).toBeTruthy();
  expect(within(card).queryAllByRole("button")).toHaveLength(0);
});

test("checker_card_texts", () => {
  const onAskFix = vi.fn();
  const on = { onReject: vi.fn(), onAccept: vi.fn(), onRejectAll: vi.fn(), onAcceptAll: vi.fn() };
  render(<ProposalCard changes={[...CHANGES, DROPPED]} kind="dfd" rejected={new Set()} onAskFix={onAskFix} {...on} />);
  expect(screen.getByText("3 of 4 changes")).toBeTruthy();
  const dropped = document.querySelector(".crow.dropped") as HTMLElement;
  expect(dropped.querySelector(".mk")!.textContent).toBe("!");
  expect(dropped.querySelector(".dtag")!.textContent).toBe("dropped");
  expect(within(dropped).queryByRole("button")).toBeNull();
  screen.getByText("Contura dropped one change: there is no shape called Shipping in this diagram. The other 3 still fit together.");
  expect([...document.querySelectorAll(".ccard-foot button")].map((b) => b.textContent)).toEqual(["Reject all", "Ask to fix it", "Accept 3Ctrl+Enter"]);
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect(onAskFix).toHaveBeenCalledWith(["there is no shape called Shipping in this diagram"]);
  cleanup();

  // More than one: the count and the messages joined by "; ".
  const second: ProposedChange = { ...DROPPED, index: 4, status: { kind: "dropped", reason: "unknownShape", message: "there is no shape called Billing in this diagram" } };
  render(<ProposalCard changes={[...CHANGES, DROPPED, second]} kind="dfd" rejected={new Set()} onAskFix={onAskFix} {...on} />);
  screen.getByText("Contura dropped 2 changes: there is no shape called Shipping in this diagram; there is no shape called Billing in this diagram. The other 3 still fit together.");
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect(onAskFix).toHaveBeenLastCalledWith(["there is no shape called Shipping in this diagram", "there is no shape called Billing in this diagram"]);
});

test("pick_card_texts", () => {
  const cands = [
    { name: "Take order", id: "1.0", line: 8, detail: "line 8, checks stock" },
    { name: "Bill customer", id: "3.0", line: 10, detail: "line 10, checks payment" },
    { name: "Ship", id: null, line: 12, detail: "line 12" },
  ];
  const onPick = vi.fn();
  const onCancel = vi.fn();
  const flow = { index: 1, op: { add_flow: { from: "the check", to: "Customs", label: null } }, status: { kind: "ambiguous", field: "from", word: "the check", candidates: cands.slice(0, 2) }, dependsOn: [] } as ProposedChange;
  render(<PickCard change={flow} onPick={onPick} onCancel={onCancel} />);
  screen.getByText('Two shapes could be "the check": which one should come after the new step?');
  expect([...document.querySelectorAll(".pickrow")].map((b) => b.textContent)).toEqual(["1.0Take orderline 8, checks stock", "3.0Bill customerline 10, checks payment"]);
  screen.getByText("Nothing changes until you pick.");
  fireEvent.click(document.querySelectorAll(".pickrow")[1]);
  expect(onPick).toHaveBeenCalledWith(cands[1]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
  cleanup();

  // Three, then the number; a change that is not a new line asks "which one did you mean?".
  const rename = { index: 0, op: { rename_node: { target: "the check", name: "Gate" } }, status: { kind: "ambiguous", field: "target", word: "the check", candidates: cands }, dependsOn: [] } as ProposedChange;
  render(<PickCard change={rename} onPick={onPick} onCancel={onCancel} />);
  screen.getByText('Three shapes could be "the check": which one did you mean?');
  cleanup();
  const many = { ...rename, status: { kind: "ambiguous", field: "target", word: "the check", candidates: [...cands, ...cands, ...cands] } } as ProposedChange;
  render(<PickCard change={many} onPick={onPick} onCancel={onCancel} />);
  screen.getByText('9 shapes could be "the check": which one did you mean?');
});

test("a_pick_with_nothing_in_its_frame_says_so", () => {
  // Task 11 fix round 1: the board offers only the frame's own shapes; with none, the card says why and offers Cancel.
  const onCancel = vi.fn();
  const none = { index: 0, op: { rename_node: { target: "pay", name: "Charge" } }, status: { kind: "ambiguous", field: "target", word: "pay", candidates: [] }, dependsOn: [], frame: "Refund" } as ProposedChange;
  render(<PickCard change={none} frame="Refund" onPick={vi.fn()} onCancel={onCancel} />);
  screen.getByText('Nothing in Refund matches "pay".');
  screen.getByText("Cancel, then ask again with the shape's name.");
  expect(document.querySelectorAll(".pickrow")).toHaveLength(0);
  expect(screen.getByRole("group", { name: "Pick a shape in Refund" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
  cleanup();
  // One left in the frame reads in the singular, naming the frame.
  const one = { ...none, status: { kind: "ambiguous", field: "target", word: "pay", candidates: [{ name: "Pay", id: null, line: 3, detail: "line 3" }] } } as ProposedChange;
  render(<PickCard change={one} frame="Refund" onPick={vi.fn()} onCancel={onCancel} />);
  screen.getByText('One shape in Refund could be "pay": which one did you mean?');
});

test("stale_and_broken_cards", () => {
  const onDiscard = vi.fn();
  const onAskAgain = vi.fn();
  render(<StaleCard file="fulfilment" line={9} nowReads="Pack order" onDiscard={onDiscard} onAskAgain={onAskAgain} />);
  screen.getByText("fulfilment changed on disk while I worked");
  expect(document.querySelector(".ebody")!.textContent).toBe(
    "Another program changed the file after you asked (line 9 now reads Pack order, a git pull perhaps). These changes were made against the old text, so none of them were applied.",
  );
  expect(document.querySelector(".ebody b")!.textContent).toBe("Pack order");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask again on the current text" }));
  expect([onDiscard, onAskAgain].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  cleanup();

  const onReview = vi.fn();
  const onFix = vi.fn();
  render(<BrokenCard file="fulfilment" broke={{ line: 14, lineText: "Customs check > Warehouse :", message: "an arrow needs a label after the colon" }} onReview={onReview} onAskFix={onFix} />);
  screen.getByText("Not applied: the text would have a problem");
  expect(document.querySelector(".ebody")!.textContent).toBe(
    "With these changes, line 14 would read Customs check > Warehouse :: an arrow needs a label after the colon. Auto-apply never lands a change that leaves a problem, so fulfilment is as it was.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Review the changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect([onReview, onFix].map((f) => f.mock.calls.length)).toEqual([1, 1]);
});

/** A change in frame `frame` (Plan D Decision 2: the resolved title). */
const inFrame = (frame: string, index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: ok, dependsOn, frame });

test("the_change_list_groups_by_frame_with_accept_frame", () => {
  const on = { onReject: vi.fn(), onAccept: vi.fn(), onRejectAll: vi.fn(), onAcceptAll: vi.fn(), onAcceptFrame: vi.fn(), onRejectFrame: vi.fn(), onAskFix: vi.fn() };
  // Out of text order on purpose: the list follows the board, with the new frame last (Decision 12).
  const changes: ProposedChange[] = [
    inFrame("Refunds", 0, { add_frame: { title: "Refunds", kind: "flow" } }),
    inFrame("Orders ERD", 1, { add_column: { table: "orders", name: "paid_at", type: "timestamp" } }),
    inFrame("Checkout flow", 2, { add_node: { name: "Fraud check" } }),
    inFrame("Refunds", 3, { add_node: { name: "Ask" } }, [0]),
    inFrame("Checkout flow", 4, { remove_node: { target: "Pay later" } }),
    { ...inFrame("Orders ERD", 5, { remove_column: { table: "orders", column: "legacy" } }), status: { kind: "dropped", reason: "unknownColumn", message: "there is no column called legacy in orders." } },
  ];
  render(<ProposalCard changes={changes} kind={null} frames={["Checkout flow", "Orders ERD"]} rejected={new Set([3])} {...on} />);
  const groups = screen.getAllByRole("group");
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Checkout flow, 2 changes", "Orders ERD, 2 changes", "Refunds, 2 changes"]);
  // Each header names the frame and counts its changes; its rows keep their own Accept and Reject.
  expect(within(groups[0]).getByText("Checkout flow, 2 changes")).toBeTruthy();
  expect(within(groups[0]).getAllByRole("button", { name: "Accept this change" })).toHaveLength(2);
  expect([...groups[0].querySelectorAll(".crow .tx")].map((r) => r.textContent)).toEqual(["Fraud check", "Pay later"]);
  expect(groups[1].querySelectorAll(".crow")).toHaveLength(2);
  fireEvent.click(within(groups[1]).getByRole("button", { name: "Accept frame" }));
  expect(on.onAcceptFrame).toHaveBeenCalledWith("Orders ERD");
  fireEvent.click(within(groups[2]).getByRole("button", { name: "Reject frame" }));
  expect(on.onRejectFrame).toHaveBeenCalledWith("Refunds");
  fireEvent.click(within(groups[0]).getAllByRole("button", { name: "Reject this change" })[0]);
  expect(on.onReject).toHaveBeenCalledWith(2);
  // The dropped change names its frame, in the note and in what "Ask to fix it" sends.
  screen.getByText("Contura dropped one change in Orders ERD: there is no column called legacy in orders. The other 5 still fit together.");
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect(on.onAskFix).toHaveBeenCalledWith(["Orders ERD: there is no column called legacy in orders."]);
  // The outcome counts stay the card's: one footer, "Accept <k>".
  expect(screen.getByRole("button", { name: /^Accept 4/ })).toBeTruthy();
  cleanup();

  // Dropped in two frames: each message names its own.
  const spread: ProposedChange[] = [
    changes[2],
    { ...inFrame("Checkout flow", 6, { add_flow: { from: "Cart", to: "Ship" } }), status: { kind: "dropped", reason: "unknownShape", message: "there is no shape called Ship in this diagram" } },
    changes[5],
  ];
  render(<ProposalCard changes={spread} kind={null} frames={["Checkout flow", "Orders ERD"]} rejected={new Set()} {...on} />);
  screen.getByText("Contura dropped 2 changes: there is no shape called Ship in this diagram (in Checkout flow); there is no column called legacy in orders (in Orders ERD). The other change still fits together.");
});

test("a_one_frame_board_shows_no_group_header", () => {
  const on = { onReject: vi.fn(), onAccept: vi.fn(), onRejectAll: vi.fn(), onAcceptAll: vi.fn(), onAcceptFrame: vi.fn(), onRejectFrame: vi.fn(), onAskFix: vi.fn() };
  const changes = CHANGES.map((c) => ({ ...c, frame: "Checkout" }));
  render(<ProposalCard changes={[...changes, { ...DROPPED, frame: "Checkout" }]} kind="dfd" frames={["Checkout"]} rejected={new Set()} {...on} />);
  expect(screen.queryAllByRole("group")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Accept frame" })).toBeNull();
  expect(screen.queryByText(/Checkout, \d changes/)).toBeNull();
  expect(document.querySelectorAll(".crow")).toHaveLength(4);
  // Nor does the dropped message name the only diagram there is.
  screen.getByText("Contura dropped one change: there is no shape called Shipping in this diagram. The other 3 still fit together.");
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect(on.onAskFix).toHaveBeenCalledWith(["there is no shape called Shipping in this diagram"]);
});

test("a_card_that_only_shows_groups_without_frame_buttons", () => {
  const changes = [inFrame("Checkout flow", 0, { add_node: { name: "Fraud check" } }), inFrame("Orders ERD", 1, { add_column: { table: "orders", name: "paid_at" } })];
  render(<ProposalCard changes={changes} kind={null} frames={["Checkout flow", "Orders ERD"]} outcome="Accepted 1 of 2." />);
  expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Checkout flow, 1 change", "Orders ERD, 1 change"]);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

test("grouping_by_frame_on_a_clashing_title_shows_each_title_once", () => {
  // Two frames share "Checkout" (B1 decision 9): one group for the title, in its first place, never two.
  const changes = [
    inFrame("Refund", 0, { add_node: { name: "Wait" } }),
    inFrame("Checkout", 1, { add_node: { name: "Fraud check" } }),
    inFrame("Checkout", 2, { remove_node: { target: "Pay later" } }),
  ];
  render(<ProposalCard changes={changes} kind={null} frames={["Checkout", "Refund", "Checkout"]} rejected={new Set()} onAcceptAll={() => {}} onAcceptFrame={() => {}} onRejectFrame={() => {}} />);
  expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Checkout, 2 changes", "Refund, 1 change"]);
  expect(document.querySelectorAll(".crow")).toHaveLength(3);
});

test("a_sentence_message_joins_the_note_in_lower_case", () => {
  // Task 2 minor 7: a frame's message is a sentence ("There is already ..."), a change's a clause; joined after the
  // colon both read as one sentence. A name at the start of a message keeps its capital.
  const drop = (index: number, message: string): ProposedChange => ({ index, op: { add_node: { name: `N${index}` } }, status: { kind: "dropped", reason: "unknownShape", message }, dependsOn: [] });
  const changes = [drop(0, "There is already a diagram called Shipping on this board."), drop(1, "there is no column called x in orders"), CHANGES[0]];
  expect(droppedNote(changes)).toBe("Contura dropped 2 changes: there is already a diagram called Shipping on this board; there is no column called x in orders. The other change still fits together.");
  expect(droppedNote([drop(0, "A board holds at most 50 diagrams.")])).toBe("Contura dropped one change: a board holds at most 50 diagrams.");
  expect(droppedNote([drop(0, "The change does not name a diagram on this board.")])).toBe("Contura dropped one change: the change does not name a diagram on this board.");
  expect(droppedNote([drop(0, "New diagrams are added on a board.")])).toBe("Contura dropped one change: new diagrams are added on a board.");
  expect(droppedNote([drop(0, "Shipping is not a diagram kind")])).toBe("Contura dropped one change: Shipping is not a diagram kind.");
});
