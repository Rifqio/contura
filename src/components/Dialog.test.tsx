import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import appCss from "../styles/app.css?raw";
import Dialog from "./Dialog";

test("Escape closes it, even when focus has left the dialog", async () => {
  const onClose = vi.fn();
  render(
    <Dialog title="Edit KFC" onClose={onClose}>
      <input aria-label="Name" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);

  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("closing_returns_focus_to_the_opener_even_when_a_child_has_autofocus", () => {
  function Host({ open }: { open: boolean }) {
    return (
      <>
        <button type="button">Opener</button>
        {open && (
          <Dialog title="Save query" onClose={() => {}}>
            <input aria-label="Name" autoFocus />
          </Dialog>
        )}
      </>
    );
  }
  const { rerender } = render(<Host open={false} />);
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  rerender(<Host open />);
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  rerender(<Host open={false} />);
  expect(document.activeElement).toBe(opener);
});

test("Tab and Shift+Tab wrap inside it", async () => {
  // A control outside the dialog: natural tab order would reach it, a wrap never does.
  render(
    <>
      <button type="button">Outside</button>
      <Dialog title="Edit KFC" onClose={() => {}}>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Dialog>
    </>,
  );
  const close = screen.getByRole("button", { name: "Close" });
  const name = screen.getByLabelText("Name");
  const save = screen.getByRole("button", { name: "Save" });
  expect(document.activeElement).toBe(name);
  await userEvent.tab();
  expect(document.activeElement).toBe(save);
  await userEvent.tab();
  expect(document.activeElement).toBe(close);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(save);
});

test("Shift+Tab from the panel itself wraps to the last control", async () => {
  render(
    <Dialog title="note: full value" onClose={() => {}}>
      <p>No inputs here</p>
      <button type="button">Copy</button>
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy" }));
});

test("sizes_map_to_classes", () => {
  render(
    <>
      <Dialog title="A" size="confirm" onClose={() => {}}>
        <p>x</p>
      </Dialog>
      <Dialog title="B" onClose={() => {}}>
        <p>x</p>
      </Dialog>
      <Dialog title="C" size="model" onClose={() => {}}>
        <p>x</p>
      </Dialog>
      <Dialog title="D" size="wide" onClose={() => {}}>
        <p>x</p>
      </Dialog>
      <Dialog title="E" wide onClose={() => {}}>
        <p>x</p>
      </Dialog>
      <Dialog title="F" size="large" onClose={() => {}}>
        <p>x</p>
      </Dialog>
    </>,
  );
  const names = screen.getAllByRole("dialog").map((d) => d.className);
  expect(names).toEqual([
    "dialog dialog-size-confirm",
    "dialog dialog-size-form",
    "dialog dialog-size-model",
    "dialog dialog-size-wide",
    "dialog dialog-size-wide",
    "dialog dialog-size-large",
  ]);
  // The large size is 860 px wide (the export and Mermaid dialogs).
  expect(appCss).toMatch(/\.dialog-size-large\s*\{\s*width:\s*min\(860px,\s*100%\);/);
});

test("subtitle_and_icon_render_in_the_header", () => {
  render(
    <Dialog title="Run on Production" subtitle="kestrel-reporting" icon="alert" onClose={() => {}}>
      <p>x</p>
    </Dialog>,
  );
  const header = screen.getByRole("dialog").querySelector(".dialog-header")!;
  expect(header.querySelector(".dialog-subtitle")?.textContent).toBe("kestrel-reporting");
  expect(header.querySelector("svg")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Run on Production" })).toBeTruthy();
});

test("the_subtitle_sits_right_after_the_title_and_close_keeps_right", () => {
  render(
    <Dialog title="Edit Group" subtitle="Orbit Freight" onClose={() => {}}>
      <p>x</p>
    </Dialog>,
  );
  const h2 = screen.getByRole("heading", { name: "Edit Group" });
  expect(h2.nextElementSibling?.className).toBe("dialog-subtitle");
  expect(screen.getByRole("button", { name: "Close" }).classList.contains("dialog-close")).toBe(true);
  const rule = (sel: string) => new RegExp(`(?:^|\\}|\\*/)\\s*${sel}\\s*\\{([^}]*)\\}`, "m").exec(appCss)?.[1] ?? "";
  // The title does not grow, so nothing pushes the subtitle to the right edge.
  expect(rule("\\.dialog-header h2")).toMatch(/flex:\s*0 1 auto/);
  expect(rule("\\.dialog-close")).toMatch(/margin-left:\s*auto/);
});

test("J2: a dirty dialog ignores a click outside and asks before Escape or the close button discard it", async () => {
  const onClose = vi.fn();
  render(
    <Dialog title="New Connection" onClose={onClose} dirty>
      <input aria-label="Name" />
    </Dialog>,
  );
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText("Discard your changes?")).toBeNull();

  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText("Discard your changes?")).toBeTruthy();
  // Escape again answers the question: keep editing.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("Discard your changes?")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByText("Discard your changes?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.queryByText("Discard your changes?")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("J2: Keep editing puts focus back on the field and Tab stays inside the dialog", async () => {
  render(
    <>
      <button type="button">Outside</button>
      <Dialog title="New Connection" onClose={() => {}} dirty>
        <input aria-label="Name" />
        <input aria-label="Host" />
      </Dialog>
    </>,
  );
  const host = screen.getByLabelText("Host");
  host.focus();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
  await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(document.activeElement).toBe(host);
  await userEvent.tab();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  // Escape then Escape again also lands back on the field.
  await userEvent.keyboard("{Escape}{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("dialog").querySelector("input, button"));
});

test("J2: a question left open when the form turns clean does not come back by itself", async () => {
  function Host({ dirty }: { dirty: boolean }) {
    return (
      <Dialog title="Save query" onClose={() => {}} dirty={dirty}>
        <input aria-label="Name" />
      </Dialog>
    );
  }
  const { rerender } = render(<Host dirty />);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByText("Discard your changes?")).toBeTruthy();
  rerender(<Host dirty={false} />);
  rerender(<Host dirty />);
  expect(screen.queryByText("Discard your changes?")).toBeNull();
});

test("J2: an untouched dialog still closes on a click outside and on Escape", async () => {
  const onClose = vi.fn();
  render(
    <Dialog title="New Connection" onClose={onClose} dirty={false}>
      <input aria-label="Name" />
    </Dialog>,
  );
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});
