import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { useDismiss } from "./useDismiss";

/** A popover that stays mounted when dismissed: its owner only counts the closes. */
function Kept({ onClose }: { onClose: () => void }) {
  const inside = useRef<HTMLDivElement>(null);
  useDismiss(true, [inside], onClose);
  return (
    <>
      <div ref={inside}>
        <button type="button">Inside</button>
      </div>
      <button type="button">Outside</button>
    </>
  );
}

test("a_popover_that_stays_mounted_can_be_dismissed_again_once_per_press", async () => {
  const onClose = vi.fn();
  render(<Kept onClose={onClose} />);
  // One press brings pointerdown and mousedown: one close.
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  expect(onClose).toHaveBeenCalledTimes(2);
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(4);
  // A press inside never closes.
  await userEvent.click(screen.getByRole("button", { name: "Inside" }));
  expect(onClose).toHaveBeenCalledTimes(4);
  // A bare mousedown (no pointer events) still closes.
  fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
  expect(onClose).toHaveBeenCalledTimes(5);
});
