// The follow-up card: the assistant's one question as text, a reply box, Cancel and Continue.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import FollowUpCard from "./FollowUpCard";

afterEach(cleanup);

const box = () => screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement;

test("it_shows_the_question_as_text_only", () => {
  const { container } = render(<FollowUpCard question={'Which <b>table</b>? <img src=x onerror="alert(1)"> **now**'} onContinue={() => {}} onCancel={() => {}} />);
  // The tags and the markdown marks are the text itself: nothing was parsed.
  expect(screen.getByText('Which <b>table</b>? <img src=x onerror="alert(1)"> **now**')).toBeTruthy();
  expect(container.querySelector("b, img, strong")).toBeNull();
});

test("continue_with_blank_sends_choose_something_sensible", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  expect(box().placeholder).toBe("Leave it blank and I'll choose something sensible");
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  // The reply goes as it is; the hook and the Core word a blank one for the model ("Choose something sensible.").
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue).toHaveBeenCalledWith("");
});

test("continue_sends_the_typed_reply", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  fireEvent.change(box(), { target: { value: "orders" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(onContinue).toHaveBeenCalledWith("orders");
});

test("ctrl_enter_continues", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  fireEvent.change(box(), { target: { value: "orders" } });
  // Plain Enter is a new line.
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue).toHaveBeenCalledWith("orders");
});

test("cancel_closes_and_sends_nothing", () => {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={onCancel} />);
  fireEvent.change(box(), { target: { value: "orders" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onContinue).not.toHaveBeenCalled();
});

test("focus_goes_to_the_reply", () => {
  render(<FollowUpCard question="Which table?" onContinue={() => {}} onCancel={() => {}} />);
  expect(document.activeElement).toBe(box());
});

test("a_reply_given_before_is_shown_again_and_the_box_is_capped", () => {
  render(<FollowUpCard question="Which table?" reply="orders" onContinue={() => {}} onCancel={() => {}} />);
  expect(box().value).toBe("orders");
  expect(box().maxLength).toBe(2000);
});

test("an_ime_composing_enter_does_not_continue", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true, isComposing: true });
  expect(onContinue).not.toHaveBeenCalled();
});

test("meta_enter_continues", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  fireEvent.change(box(), { target: { value: "orders" } });
  fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
  expect(onContinue).toHaveBeenCalledWith("orders");
});

test("ctrl_enter_outside_the_reply_box_does_nothing", () => {
  const onContinue = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={() => {}} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(screen.getByRole("group"), { key: "Enter", ctrlKey: true });
  expect(onContinue).not.toHaveBeenCalled();
});

test("escape_is_ignored", () => {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  render(<FollowUpCard question="Which table?" onContinue={onContinue} onCancel={onCancel} />);
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
});
