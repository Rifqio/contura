import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ProposedChange } from "../../api/types";
import ProposalCard, { BrokenCard, PickCard, StaleCard } from "./ProposalCard";

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

test("stale_and_broken_cards", () => {
  const onDiscard = vi.fn();
  const onAskAgain = vi.fn();
  render(<StaleCard file="fulfilment" line={9} nowReads="Pack order" onDiscard={onDiscard} onAskAgain={onAskAgain} />);
  screen.getByText("fulfilment.flow changed on disk while I worked");
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
    "With these changes, line 14 would read Customs check > Warehouse :: an arrow needs a label after the colon. Auto-apply never lands a change that leaves a problem, so fulfilment.flow is as it was.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Review the changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix it" }));
  expect([onReview, onFix].map((f) => f.mock.calls.length)).toEqual([1, 1]);
});
