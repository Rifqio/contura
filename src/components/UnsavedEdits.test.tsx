import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import UnsavedEdits, { tableBody } from "./UnsavedEdits";

function setup(over: Partial<Parameters<typeof UnsavedEdits>[0]> = {}) {
  const fns = { onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() };
  render(
    <UnsavedEdits
      title="Save changes to orders?"
      body={tableBody(1, "shop.public.orders", "shop-staging", false)}
      production={false}
      busy={false}
      {...fns}
      {...over}
    />,
  );
  return fns;
}

test("table_copy", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  expect(dialog.className).toContain("dialog-size-confirm");
  expect(screen.getByRole("heading", { name: "Save changes to orders?" })).toBeTruthy();
  expect(dialog.querySelector(".dialog-body")!.textContent).toBe(
    "You have 1 Pending Edit in shop.public.orders on shop-staging. Closing the tab without saving loses it.",
  );
});

test("several_edits_say_them", () => {
  setup({ body: tableBody(4, "shop.public.orders", "freight-prod", true), production: true });
  const body = document.querySelector(".dialog-body")!;
  expect(body.textContent).toContain("You have 4 Pending Edits in shop.public.orders on freight-prod (Production).");
  expect(body.textContent).toContain("loses them.");
  expect(body.textContent).toContain("Save on PROD shows the SQL and asks you to confirm before anything runs.");
});

test("production_variant_save_on_prod_and_focus_on_cancel", async () => {
  const fns = setup({ production: true });
  expect(screen.queryByRole("button", { name: /^Save Ctrl\+S/ })).toBeNull();
  const save = screen.getByRole("button", { name: "Save on PROD..." });
  expect(save.className).toContain("button-prod");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Cancel/ }));
  await userEvent.click(save);
  expect(fns.onSave).toHaveBeenCalled();
});

test("focus_starts_on_save_outside_production", () => {
  setup();
  const save = screen.getByRole("button", { name: /^Save/ });
  expect(save.className).toContain("button-primary");
  expect(save.textContent).toContain("Ctrl+S");
  expect(document.activeElement).toBe(save);
});

test("discard_sits_on_the_left", () => {
  setup();
  const buttons = Array.from(document.querySelectorAll(".dialog-footer button")).map((b) => b.textContent);
  expect(buttons[0]).toBe("Discard");
  expect(buttons[1]).toMatch(/^Cancel/);
  expect(buttons[1]).toContain("Esc");
  expect(buttons[2]).toMatch(/^Save/);
});

test("ctrl_s_saves_and_discard_discards", async () => {
  const fns = setup();
  await userEvent.keyboard("{Control>}s{/Control}");
  expect(fns.onSave).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(fns.onDiscard).toHaveBeenCalled();
});
