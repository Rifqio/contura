import { afterEach, expect, test } from "vitest";
import { installContextMenuGuard } from "./contextMenuGuard";

let remove: (() => void) | null = null;
afterEach(() => {
  remove?.();
  remove = null;
  document.body.innerHTML = "";
});

/** Right-clicks `el` and says whether the WebView would still show its own menu. */
function nativeMenuShows(el: Element): boolean {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return !e.defaultPrevented;
}

test("a right-click where Contura has no menu never shows the WebView's menu (Back, Reload)", () => {
  remove = installContextMenuGuard();
  document.body.innerHTML = `<div class="diagram-canvas"><svg><path class="edge"></path></svg></div>`;
  expect(nativeMenuShows(document.querySelector(".edge")!)).toBe(false);
  expect(nativeMenuShows(document.body)).toBe(false);
});

test("text fields keep the WebView's Cut, Copy and Paste menu", () => {
  remove = installContextMenuGuard();
  document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><div contenteditable="true" id="c"></div><div class="cm-editor"><div class="cm-content" id="cm"><span id="line">select</span></div></div>`;
  for (const id of ["i", "t", "c", "line"]) expect(nativeMenuShows(document.getElementById(id)!)).toBe(true);
});

test("a read-only or disabled field gets no WebView menu", () => {
  remove = installContextMenuGuard();
  document.body.innerHTML = `<input id="r" readonly><input id="d" disabled><input id="b" type="button">`;
  for (const id of ["r", "d", "b"]) expect(nativeMenuShows(document.getElementById(id)!)).toBe(false);
});

test("removing the guard gives the WebView its menu back", () => {
  remove = installContextMenuGuard();
  remove();
  remove = null;
  document.body.innerHTML = `<div id="x"></div>`;
  expect(nativeMenuShows(document.getElementById("x")!)).toBe(true);
});
