import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installTooltipGuard, placeTip } from "./tooltipGuard";

let remove: () => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  remove();
  document.body.innerHTML = "";
});

function setup() {
  document.body.innerHTML = `
    <div class="tabs"><button id="home" title="Home">H</button><button id="query" title="Query 1">Q</button></div>
    <div class="bar"><button id="fn" class="feature-button" data-tip="Function (Ctrl+F)"><span id="fn-icon">f</span></button></div>
    <div id="list" style="overflow:auto"><input id="search" /><button id="row" title="Row 1">R</button></div>`;
  remove = installTooltipGuard(document, window);
  return (id: string) => document.getElementById(id) as HTMLElement;
}

const over = (el: Element) => el.dispatchEvent(new Event("pointerover", { bubbles: true }));
const tipText = () => document.querySelector(".app-tip")?.textContent ?? null;

test("parity_P11_37_a_click_hides_the_tooltip_until_the_pointer_leaves", () => {
  const $ = setup();
  over($("home"));
  vi.advanceTimersByTime(500);
  expect(tipText()).toBe("Home");
  $("home").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(tipText()).toBeNull();
  expect($("home").hasAttribute("title")).toBe(false);
  // Moving onto another control brings the first one's hover text back for next time.
  over($("query"));
  expect($("home").getAttribute("title")).toBe("Home");
  // The one under the pointer is the app's to draw.
  expect($("query").hasAttribute("title")).toBe(false);
});

test("parity_P11_37_a_css_tooltip_is_held_off_after_a_click", () => {
  const $ = setup();
  over($("fn-icon"));
  $("fn-icon").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect($("fn").hasAttribute("data-tip-off")).toBe(true);
  over($("search"));
  expect($("fn").hasAttribute("data-tip-off")).toBe(false);
});

test("parity_P11_37_scroll_and_window_blur_hide_the_tooltip_under_the_pointer", () => {
  const $ = setup();
  over($("row"));
  $("list").dispatchEvent(new Event("scroll"));
  expect($("row").hasAttribute("title")).toBe(false);
  over($("home"));
  expect($("row").getAttribute("title")).toBe("Row 1");
  window.dispatchEvent(new Event("blur"));
  expect($("home").hasAttribute("title")).toBe(false);
  // The pointer leaving the window gives it back.
  $("home").dispatchEvent(Object.assign(new Event("pointerout", { bubbles: true }), { relatedTarget: null }));
  expect($("home").getAttribute("title")).toBe("Home");
});

test("parity_P11_37_uninstall_puts_every_title_back", () => {
  const $ = setup();
  over($("home"));
  $("home").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  remove();
  remove = () => {};
  expect($("home").getAttribute("title")).toBe("Home");
});

test("a_box_scrolling_beside_the_hovered_control_leaves_its_tooltip", () => {
  const $ = setup();
  // The pointer rests on a tab while the list scrolls on its own (an answer streaming in under it).
  over($("query"));
  vi.advanceTimersByTime(500);
  $("list").dispatchEvent(new Event("scroll"));
  expect(tipText()).toBe("Query 1");
  // A page scroll does move it.
  document.dispatchEvent(new Event("scroll"));
  expect(tipText()).toBeNull();
});

test("a_stream_of_scroll_events_writes_the_attributes_once", () => {
  const $ = setup();
  over($("row"));
  vi.advanceTimersByTime(500);
  const row = $("row");
  let writes = 0;
  const set = row.setAttribute.bind(row);
  const del = row.removeAttribute.bind(row);
  row.setAttribute = (n: string, v: string) => {
    writes++;
    set(n, v);
  };
  row.removeAttribute = (n: string) => {
    writes++;
    del(n);
  };
  for (let i = 0; i < 50; i++) $("list").dispatchEvent(new Event("scroll"));
  expect(row.hasAttribute("title")).toBe(false);
  // Put away once (the description leaves with the tooltip), then nothing more for the other 49 events.
  expect(writes).toBe(1);
  expect(tipText()).toBeNull();
});

test("a_title_is_drawn_by_the_app_after_the_delay_and_not_by_the_system", () => {
  const $ = setup();
  over($("home"));
  // The system tooltip has nothing to draw from the first moment.
  expect($("home").hasAttribute("title")).toBe(false);
  vi.advanceTimersByTime(499);
  expect(tipText()).toBeNull();
  vi.advanceTimersByTime(1);
  expect(tipText()).toBe("Home");
  expect(document.querySelector(".app-tip")?.getAttribute("role")).toBe("tooltip");
  // Leaving removes it and gives the title back.
  over($("search"));
  expect(tipText()).toBeNull();
  expect($("home").getAttribute("title")).toBe("Home");
});

test("polish_A3_a_context_menu_or_any_button_press_hides_the_tooltip_until_the_pointer_leaves", () => {
  const $ = setup();
  for (const hideIt of [
    () => $("query").dispatchEvent(new Event("contextmenu", { bubbles: true })),
    () => $("query").dispatchEvent(new Event("mousedown", { bubbles: true })),
    () => $("query").dispatchEvent(new Event("pointerdown", { bubbles: true })),
    () => document.dispatchEvent(new Event("keydown")),
  ]) {
    over($("home"));
    over($("query"));
    vi.advanceTimersByTime(500);
    expect(tipText()).toBe("Query 1");
    hideIt();
    expect(tipText()).toBeNull();
    // It does not come back while the pointer rests on the control.
    vi.advanceTimersByTime(2000);
    expect(tipText()).toBeNull();
    over($("search"));
    expect($("query").getAttribute("title")).toBe("Query 1");
  }
});

test("a_neighbour_right_after_a_tooltip_shows_at_once", () => {
  const $ = setup();
  over($("home"));
  vi.advanceTimersByTime(500);
  over($("query"));
  vi.advanceTimersByTime(0);
  expect(tipText()).toBe("Query 1");
});

test("polish_A5_the_tooltip_stays_inside_the_window_on_every_edge", () => {
  const tip = { width: 120, height: 24 };
  const vw = 1000;
  const vh = 600;
  // Under a button at the right edge: pushed left until it fits.
  const right = placeTip({ left: 968, top: 10, width: 28, height: 28 }, tip, vw, vh);
  expect(right.left + tip.width).toBeLessThanOrEqual(vw - 4);
  expect(right.top).toBe(44);
  // At the left edge.
  expect(placeTip({ left: 0, top: 10, width: 20, height: 20 }, tip, vw, vh).left).toBe(4);
  // At the bottom edge it flips above the control.
  const bottom = placeTip({ left: 500, top: 570, width: 28, height: 28 }, tip, vw, vh);
  expect(bottom.top + tip.height).toBeLessThanOrEqual(570);
  // Nothing fits above or below: it still stays inside.
  const tall = placeTip({ left: 500, top: 0, width: 28, height: 600 }, tip, vw, vh);
  expect(tall.top).toBeGreaterThanOrEqual(4);
  expect(tall.top + tip.height).toBeLessThanOrEqual(vh - 4);
  // Roomy: centred under the control.
  expect(placeTip({ left: 400, top: 10, width: 100, height: 20 }, tip, vw, vh)).toEqual({ left: 390, top: 36 });
});

test("polish_A5_the_drawn_tooltip_is_placed_inside_the_window", () => {
  const $ = setup();
  const btn = $("query");
  btn.getBoundingClientRect = () => ({ left: 1000, top: 10, width: 24, height: 24, right: 1024, bottom: 34, x: 1000, y: 10, toJSON: () => ({}) });
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList.contains("app-tip") ? ({ left: 0, top: 0, width: 140, height: 24, right: 140, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : real.call(this);
  };
  try {
    over(btn);
    vi.advanceTimersByTime(500);
    const node = document.querySelector(".app-tip") as HTMLElement;
    expect(parseInt(node.style.left, 10) + 140).toBeLessThanOrEqual(window.innerWidth - 4);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = real;
  }
});

// Fix round 1 (review I3): the control keeps its description while the app draws the tooltip.
test("I3_the_drawn_tooltip_is_the_controls_description_while_it_shows", () => {
  const $ = setup();
  over($("query"));
  vi.advanceTimersByTime(500);
  const tip = document.querySelector(".app-tip") as HTMLElement;
  expect(tip.id).toBeTruthy();
  expect($("query").getAttribute("aria-describedby")).toBe(tip.id);
  // Gone with the tip, and an earlier description comes back as it was.
  over($("search"));
  expect($("query").hasAttribute("aria-describedby")).toBe(false);
});

test("I3_an_existing_description_is_kept_beside_the_tooltip", () => {
  const $ = setup();
  $("home").setAttribute("aria-describedby", "other");
  over($("home"));
  vi.advanceTimersByTime(500);
  const id = (document.querySelector(".app-tip") as HTMLElement).id;
  expect($("home").getAttribute("aria-describedby")).toBe(`other ${id}`);
  over($("search"));
  expect($("home").getAttribute("aria-describedby")).toBe("other");
});

test("I3_an_icon_only_control_keeps_its_name_while_its_title_is_held", () => {
  document.body.innerHTML = '<button id="icon" title="Fit to view (Shift+1)"><svg></svg></button><input id="x">';
  remove = installTooltipGuard(document, window);
  over(document.getElementById("icon") as HTMLElement);
  expect((document.getElementById("icon") as HTMLElement).getAttribute("aria-label")).toBe("Fit to view (Shift+1)");
  over(document.getElementById("x") as HTMLElement);
  expect((document.getElementById("icon") as HTMLElement).hasAttribute("aria-label")).toBe(false);
  expect((document.getElementById("icon") as HTMLElement).getAttribute("title")).toBe("Fit to view (Shift+1)");
});

// M1: the next tooltip is quick after the last one was visible, however long ago it showed.
test("M1_a_neighbour_is_quick_after_a_tooltip_that_was_up_a_while", () => {
  const $ = setup();
  over($("home"));
  vi.advanceTimersByTime(500);
  vi.advanceTimersByTime(5000);
  over($("query"));
  vi.advanceTimersByTime(0);
  expect(tipText()).toBe("Query 1");
  // After a pause the full delay is back.
  over($("search"));
  vi.advanceTimersByTime(2000);
  over($("home"));
  vi.advanceTimersByTime(100);
  expect(tipText()).toBeNull();
});

// M2: a title React writes while the control is held is taken too, so the system tooltip never draws.
test("M2_a_title_written_while_hovered_is_taken_as_well", async () => {
  const $ = setup();
  over($("home"));
  $("home").setAttribute("title", "Home, new");
  await Promise.resolve();
  expect($("home").hasAttribute("title")).toBe(false);
  vi.advanceTimersByTime(500);
  expect(tipText()).toBe("Home, new");
});

// M3: a control that goes away takes its tooltip with it.
test("M3_the_tooltip_leaves_with_its_control", () => {
  const $ = setup();
  over($("home"));
  vi.advanceTimersByTime(500);
  expect(tipText()).toBe("Home");
  $("home").remove();
  document.dispatchEvent(new Event("pointermove"));
  expect(tipText()).toBeNull();
});

test("a_drag_shows_no_tooltip_over_what_it_passes_until_the_pointer_moves_after_the_drop", () => {
  const $ = setup();
  const mouse = (el: Element | Window, type: string, x = 10, y = 10) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
  over($("home"));
  // A press on one header, then the drag passes over another: no tooltip, however long it stays there.
  mouse($("home"), "mousedown");
  over($("query"));
  vi.advanceTimersByTime(2000);
  expect(tipText()).toBeNull();
  expect($("query").hasAttribute("title")).toBe(false);
  // Dropped there: still none, until the pointer moves.
  mouse(window, "mouseup", 50, 10);
  vi.advanceTimersByTime(2000);
  expect(tipText()).toBeNull();
  document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 10 }));
  vi.advanceTimersByTime(2000);
  expect(tipText()).toBeNull();
  document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 52, clientY: 11 }));
  vi.advanceTimersByTime(500);
  expect(tipText()).toBe("Query 1");
});
