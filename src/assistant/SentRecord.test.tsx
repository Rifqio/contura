import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import type { AiProviderKind, SentRecord as Sent } from "../api/types";
import { sentRecord } from "../test/aiStream";
import SentRecord, { NOT_KEPT } from "./SentRecord";

test("a_record_without_exact_shows_the_note", () => {
  const { exact: _, ...rest } = sentRecord();
  render(<SentRecord sent={rest as Sent} usage={null} onClose={vi.fn()} />);
  expect(screen.getByText(NOT_KEPT)).toBeTruthy();
  expect(document.querySelector(".sent-pop-exact")).toBeNull();
});

test("an_unknown_provider_shows_its_id", () => {
  render(<SentRecord sent={sentRecord({ provider: "mistral" as AiProviderKind })} usage={null} onClose={vi.fn()} />);
  expect(screen.getByText("mistral")).toBeTruthy();
});

test("a_record_whose_connection_failed_says_nothing_left", () => {
  render(<SentRecord sent={sentRecord()} usage={null} notSent onClose={vi.fn()} />);
  expect(screen.getByText("The connection failed before the request went out, so none of this left your PC.")).toBeTruthy();
});

const OUTLINE = {
  bytes: 1204,
  tokens: 344,
  hash: "aa11bb22cc33dd44",
  pickedAreas: 1,
  pickedTables: 6,
  dropped: 0,
  usage: null,
  exact: null,
  left: true,
};

test("a_record_where_only_the_outline_left_says_so", () => {
  render(<SentRecord sent={sentRecord({ outlineCall: true, outline: OUTLINE })} usage={null} notSent onClose={vi.fn()} />);
  expect(screen.getByText("Only the outline step left your PC. The main request did not.")).toBeTruthy();
  expect(screen.queryByText(/none of this left your PC/)).toBeNull();
});

test("outline_line_and_kept_text", () => {
  const { unmount } = render(<SentRecord sent={sentRecord({ outlineCall: true, outline: OUTLINE })} usage={null} onClose={vi.fn()} />);
  expect(screen.getByText("Outline step: 1,204 B, about 344 tokens, picked 1 area, 6 tables")).toBeTruthy();
  expect(screen.queryByLabelText("Exactly what the outline step sent")).toBeNull();
  unmount();
  render(
    <SentRecord
      sent={sentRecord({ outlineCall: true, exact: "main text", outline: { ...OUTLINE, pickedAreas: 2, pickedTables: 1, dropped: 2, exact: "outline text" } })}
      usage={null}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("Outline step: 1,204 B, about 344 tokens, picked 2 areas, 1 table, 2 names dropped")).toBeTruthy();
  expect(screen.getByText("Outline step", { selector: ".sent-pop-exact-head" })).toBeTruthy();
  expect(screen.getByLabelText("Exactly what the outline step sent").textContent).toBe("outline text");
});

test("old_record_without_outline", () => {
  const { outline: _o, ...rest } = sentRecord();
  render(<SentRecord sent={rest as Sent} usage={null} onClose={vi.fn()} />);
  expect(screen.queryByText(/Outline step/)).toBeNull();
});

test("kept_exact_text_shows", () => {
  const exact = "Question:\nWho bought <b>most</b>?";
  render(<SentRecord sent={sentRecord({ exact })} usage={null} onClose={vi.fn()} />);
  const pre = screen.getByLabelText("Exactly what was sent");
  expect(pre.tagName).toBe("PRE");
  expect(pre.textContent).toBe(exact);
  expect(pre.querySelector("b")).toBeNull();
  expect(screen.queryByText(NOT_KEPT)).toBeNull();
});

/** The Sent line opens the record; another control of the panel can hold focus while it is open. */
function Panel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-panel">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        Sent line
      </button>
      <textarea aria-label="Message" />
      {open && <SentRecord sent={sentRecord()} usage={null} onClose={() => setOpen(false)} />}
    </div>
  );
}

test("esc_closes_and_returns_focus", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Panel />
      <input aria-label="Elsewhere" />
    </>,
  );
  const line = screen.getByRole("button", { name: "Sent line" });
  await user.click(line);
  expect(screen.getByRole("dialog", { name: "Sent record" })).toBeTruthy();
  // Esc with focus elsewhere in the panel closes it too.
  await user.click(screen.getByRole("textbox", { name: "Message" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Sent record" })).toBeNull();
  expect(document.activeElement).toBe(line);

  // Esc inside it, and its Close button, return focus as well.
  await user.click(line);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Sent record" })).toBeNull();
  expect(document.activeElement).toBe(line);
  await user.click(line);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(line);

  // Esc outside the panel leaves it open.
  await user.click(line);
  await user.click(screen.getByRole("textbox", { name: "Elsewhere" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Sent record" })).toBeTruthy();
});
