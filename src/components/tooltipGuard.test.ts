import { afterEach, expect, test } from "vitest";
import { installTooltipGuard } from "./tooltipGuard";

let remove: () => void = () => {};
afterEach(() => {
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

test("parity_P11_37_a_click_hides_the_tooltip_until_the_pointer_leaves", () => {
  const $ = setup();
  over($("home"));
  $("home").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect($("home").hasAttribute("title")).toBe(false);
  // Moving onto another control brings the first one's hover text back for next time.
  over($("query"));
  expect($("home").getAttribute("title")).toBe("Home");
  expect($("query").getAttribute("title")).toBe("Query 1");
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
  $("list").dispatchEvent(new Event("scroll"));
  expect($("query").getAttribute("title")).toBe("Query 1");
  // A page scroll does move it.
  document.dispatchEvent(new Event("scroll"));
  expect($("query").hasAttribute("title")).toBe(false);
});

test("a_stream_of_scroll_events_writes_the_attributes_once", () => {
  const $ = setup();
  over($("row"));
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
  // Held once: the title moved to data-title-held and data-tip-off was set, then nothing more.
  expect(writes).toBe(3);
});
