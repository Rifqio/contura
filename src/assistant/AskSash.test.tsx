// The Ask panel resizes from its left edge, as the VS Code and Cursor chat side panels do (owner request).
import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import appCss from "../styles/app.css?raw";
import AskSash from "./AskSash";
import { ASK_WIDTH_KEY, askLayout, askWidthRoom, useAskWidth } from "./askWidth";

/** As App lays it out: the body carries --ask-width, and the sash shows only when the panel can be resized. */
function Harness({ history = false }: { history?: boolean }) {
  const ask = useAskWidth();
  const lay = askLayout(ask.wanted, history ? ask.roomHistory : ask.roomPlain);
  return (
    <div className="body" style={{ "--ask-width": `${lay.width}px` } as React.CSSProperties}>
      {lay.resizable && <AskSash width={lay.width} max={lay.max} onWidth={ask.set} />}
      <output data-testid="width">{lay.width}</output>
    </div>
  );
}

const sash = () => screen.getByRole("separator", { name: "Resize the Ask panel" });
const now = () => sash().getAttribute("aria-valuenow");
const body = () => document.querySelector(".body") as HTMLElement;
const drawn = () => body().style.getPropertyValue("--ask-width");
const setWindowWidth = (w: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: w });

/** Animation frames wait here until `frame()` runs them, so a test sees what one frame writes. */
let frames: FrameRequestCallback[] = [];
const frame = () =>
  act(() => {
    const run = frames;
    frames = [];
    for (const f of run) f(0);
  });
/** A move with the left button held. */
const move = (clientX: number) => fireEvent.pointerMove(window, { clientX, pointerId: 1, buttons: 1 });
const down = (clientX: number) => fireEvent.pointerDown(sash(), { clientX, pointerId: 1, button: 0, buttons: 1 });

beforeEach(() => {
  localStorage.removeItem(ASK_WIDTH_KEY);
  setWindowWidth(1280);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem(ASK_WIDTH_KEY);
});

test("the_ask_panel_resizes_from_its_left_edge", async () => {
  const user = userEvent.setup();
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  const view = render(<Harness />);
  expect(sash().getAttribute("aria-orientation")).toBe("vertical");
  expect(sash().tabIndex).toBe(0);
  expect(now()).toBe("360");
  expect(sash().getAttribute("aria-valuetext")).toBe("360 pixels");
  expect(sash().getAttribute("aria-valuemin")).toBe("300");
  // At 1,280 px: half the window is 640, under the 720 cap and the 672 that leaves the work area 320.
  expect(sash().getAttribute("aria-valuemax")).toBe("640");

  // Dragging left widens the panel, right narrows it, clamped to 300 and the most; drawn once per frame.
  down(1000);
  expect(sash().classList.contains("dragging")).toBe(true);
  move(900);
  frame();
  expect(drawn()).toBe("460px");
  expect(now()).toBe("460");
  move(0);
  frame();
  expect(now()).toBe("640");
  move(1900);
  frame();
  expect(now()).toBe("300");
  move(980);
  fireEvent.pointerUp(window, { clientX: 980, pointerId: 1 });
  expect(sash().classList.contains("dragging")).toBe(false);
  expect(now()).toBe("380");
  expect(screen.getByTestId("width").textContent).toBe("380");
  // The listeners went with the pointer: a later move changes nothing.
  move(500);
  frame();
  expect(now()).toBe("380");
  const count = (spy: typeof added, type: string) => spy.mock.calls.filter((c) => c[0] === type).length;
  for (const type of ["pointermove", "pointerup", "pointercancel", "blur"]) expect(count(removed, type), type).toBe(count(added, type));

  // Left and Right in 16 px steps, Home and End to the least and the most.
  sash().focus();
  await user.keyboard("{ArrowLeft}");
  expect(now()).toBe("396");
  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(now()).toBe("364");
  for (let i = 0; i < 8; i++) await user.keyboard("{ArrowRight}");
  expect(now()).toBe("300");
  await user.keyboard("{End}");
  expect(now()).toBe("640");
  await user.keyboard("{Home}");
  expect(now()).toBe("300");
  await user.keyboard("{End}");

  // A smaller window lowers the most, once per frame, so the work area keeps 320 px: at 1,024 px that is 416.
  setWindowWidth(1024);
  act(() => {
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
  expect(frames).toHaveLength(1);
  frame();
  expect(sash().getAttribute("aria-valuemax")).toBe("416");
  expect(now()).toBe("416");

  // A drag cut short by closing the panel leaves no listener behind.
  down(700);
  view.unmount();
  for (const type of ["pointermove", "pointerup", "pointercancel", "blur", "resize"]) expect(count(removed, type), type).toBe(count(added, type));
});

test("every_way_a_drag_can_end_ends_it_and_saves", () => {
  const ends: [string, () => void][] = [
    ["pointerup", () => fireEvent.pointerUp(window, { pointerId: 1 })],
    ["pointercancel", () => fireEvent.pointerCancel(window, { pointerId: 1 })],
    ["lostpointercapture", () => fireEvent.lostPointerCapture(sash(), { pointerId: 1 })],
    ["a move with no button held", () => fireEvent.pointerMove(window, { clientX: 100, pointerId: 1, buttons: 0 })],
    ["the window losing focus", () => fireEvent.blur(window)],
  ];
  const captured = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: captured });
  render(<Harness />);
  let start = 360;
  for (const [name, end] of ends) {
    localStorage.removeItem(ASK_WIDTH_KEY);
    down(1000);
    move(990);
    end();
    const w = String(start + 10);
    expect(sash().classList.contains("dragging"), name).toBe(false);
    expect(now(), name).toBe(w);
    expect(localStorage.getItem(ASK_WIDTH_KEY), name).toBe(w);
    // After the end the bare mouse moves nothing.
    move(0);
    frame();
    expect(now(), name).toBe(w);
    start += 10;
  }
  // The sash holds the pointer, so a release outside the window still reaches it.
  expect(captured).toHaveBeenCalledWith(1);
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
});

test("a_drag_draws_by_frame_and_commits_once", () => {
  let commits = 0;
  render(
    <Profiler id="ask" onRender={() => commits++}>
      <Harness />
    </Profiler>,
  );
  down(1000);
  const before = commits;
  for (let i = 1; i <= 50; i++) move(1000 - i);
  // One frame for all 50 moves, and no React render: the body's --ask-width is written straight.
  expect(frames).toHaveLength(1);
  frame();
  expect(drawn()).toBe("410px");
  expect(commits).toBe(before);
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBeNull();
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(commits - before).toBeLessThanOrEqual(1);
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBe("410");
  expect(screen.getByTestId("width").textContent).toBe("410");
});

test("the_ask_width_is_remembered_and_double_click_resets_it", async () => {
  const user = userEvent.setup();
  const first = render(<Harness />);
  down(1000);
  move(900);
  frame();
  // Saved once, when the drag ends.
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBeNull();
  fireEvent.pointerUp(window, { clientX: 900, pointerId: 1 });
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBe("460");
  first.unmount();

  // A new panel opens at the remembered width.
  render(<Harness />);
  expect(now()).toBe("460");
  // Keys are remembered too.
  sash().focus();
  await user.keyboard("{ArrowRight}");
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBe("444");
  // Double-click puts back 360.
  await user.dblClick(sash());
  expect(now()).toBe("360");
  expect(localStorage.getItem(ASK_WIDTH_KEY)).toBe("360");
});

test("a_bad_or_unreadable_stored_width_falls_back_to_360", () => {
  localStorage.setItem(ASK_WIDTH_KEY, "wide");
  const view = render(<Harness />);
  expect(now()).toBe("360");
  view.unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<Harness />);
  expect(now()).toBe("360");
});

test("with_history_open_the_ask_column_follows_the_sash", () => {
  // Review: with History open the Ask track shared the free space, so the sash moved nothing at 1,024 and 1,280 px.
  // The Ask track is the sash's width; History gives way first, down to its minimum.
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /(?:^|\})\s*\.body-history\.body-ai\s*\{\s*grid-template-columns:\s*([^;]+);/.exec(css);
  expect(rule?.[1].trim()).toBe("minmax(180px, 264px) minmax(320px, 1fr) minmax(220px, 360px) var(--ask-width, 360px)");
  // Tree, work area and History at their minimums, three gaps and the padding: what is left is the Ask column's most.
  const least = 180 + 320 + 220 + 3 * 6 + 2 * 6;
  for (const win of [1024, 1280, 1920]) {
    const room = askWidthRoom(win, true);
    expect(room, `${win} px`).toBe(Math.min(720, Math.floor(win / 2), win - least));
    for (const wanted of [300, 360, 500, 720]) {
      const lay = askLayout(wanted, room);
      // The column is exactly what the sash says, and the other minimums still fit beside it.
      expect(lay.width + least, `${win} px, ${wanted}`).toBeLessThanOrEqual(win);
      if (lay.resizable) expect(lay.width).toBe(Math.max(300, Math.min(wanted, room)));
    }
  }
  // At 1,024 px only 274 px is left: no sash, and the column keeps what fits.
  expect(askLayout(360, askWidthRoom(1024, true))).toEqual({ width: 274, max: 274, resizable: false });
  // At 1,280 px the sash goes up to 530.
  expect(askLayout(720, askWidthRoom(1280, true))).toEqual({ width: 530, max: 530, resizable: true });

  setWindowWidth(1024);
  const view = render(<Harness history />);
  expect(screen.queryByRole("separator")).toBeNull();
  expect(drawn()).toBe("274px");
  view.unmount();
  setWindowWidth(1280);
  render(<Harness history />);
  expect(sash().getAttribute("aria-valuemax")).toBe("530");
  expect(drawn()).toBe(`${now()}px`);
});
