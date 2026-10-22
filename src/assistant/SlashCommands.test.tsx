import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import SlashCommands, { optionId } from "./SlashCommands";
import { SLASH_COMMANDS, type SlashCommand, slashKey } from "./slash";

afterEach(cleanup);

/** The composer's part: the textarea drives the list through `slashKey`, as the panel does. */
function Harness({ onRun, onClose, unavailable }: { onRun(c: SlashCommand): void; onClose(): void; unavailable?: Record<string, string> }) {
  const [active, setActive] = useState(0);
  return (
    <>
      <textarea
        aria-label="Message"
        aria-controls="cmds"
        aria-activedescendant={optionId("cmds", SLASH_COMMANDS[active].name)}
        onKeyDown={(e) => {
          const k = slashKey(e.key, active, SLASH_COMMANDS.length);
          if (k === null) return;
          e.preventDefault();
          if (k === "run") onRun(SLASH_COMMANDS[active]);
          else if (k === "close") onClose();
          else setActive(k.active);
        }}
      />
      <SlashCommands id="cmds" commands={SLASH_COMMANDS} active={active} unavailable={unavailable} onRun={onRun} />
    </>
  );
}

test("keyboard_moves_and_runs", async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  render(<Harness onRun={onRun} onClose={() => {}} />);
  expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(7);
  await user.click(screen.getByLabelText("Message"));
  await user.keyboard("{ArrowDown}{ArrowDown}");
  const third = screen.getByRole("option", { name: /\/history/ });
  expect(third.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Message").getAttribute("aria-activedescendant")).toBe(third.id);
  await user.keyboard("{Enter}");
  expect(onRun).toHaveBeenCalledTimes(1);
  expect(onRun.mock.calls[0][0].name).toBe("history");
});

test("wraps_and_escape_closes", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Harness onRun={() => {}} onClose={onClose} />);
  await user.click(screen.getByLabelText("Message"));
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("option", { name: /\/clear/ }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: /\/compact/ }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("click_runs_and_unavailable_note_shows", async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  render(<Harness onRun={onRun} onClose={() => {}} unavailable={{ log: "No answer yet" }} />);
  expect(screen.getByRole("option", { name: /\/log/ }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("No answer yet")).toBeTruthy();
  await user.click(screen.getByRole("option", { name: /\/new/ }));
  expect(onRun.mock.calls[0][0].name).toBe("new");
});

test("empty_list_says_no_command_matches", () => {
  render(<SlashCommands id="x" commands={[]} active={0} draft="/xyz" onRun={() => {}} />);
  expect(screen.getByText("No command matches /xyz. Delete the / to ask a question.")).toBeTruthy();
});
