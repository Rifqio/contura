import { afterEach, expect, test } from "vitest";
import { cyclePane, rememberPaneFocus } from "./panes";

afterEach(() => {
  document.body.innerHTML = "";
});

function layout() {
  document.body.innerHTML = `
    <aside data-pane id="side"><button id="tree">tree</button></aside>
    <main data-pane id="work">
      <div class="work-pane" hidden><section data-pane id="hiddenGrid"><div tabindex="0" id="hg"></div></section></div>
      <div class="work-pane">
        <div data-pane id="editor"><div tabindex="0" id="code"></div></div>
        <section data-pane id="results"><button id="tool">Filter</button><div tabindex="0" data-pane-focus id="rgrid"></div></section>
      </div>
    </main>
    <aside data-pane id="ask"><textarea id="prompt"></textarea></aside>`;
  return (id: string) => document.getElementById(id)!;
}

test("F6 moves focus to the next pane on screen and wraps; Shift+F6 goes back", () => {
  const el = layout();
  el("tree").focus();
  expect(cyclePane(1)).toBe(true);
  expect(document.activeElement).toBe(el("code"));
  cyclePane(1);
  // A pane's own focus target wins over its first control.
  expect(document.activeElement).toBe(el("rgrid"));
  cyclePane(1);
  expect(document.activeElement).toBe(el("prompt"));
  cyclePane(1);
  expect(document.activeElement).toBe(el("tree"));
  cyclePane(-1);
  expect(document.activeElement).toBe(el("prompt"));
});

test("a pane given focus again goes back to where focus last was in it", () => {
  const el = layout();
  rememberPaneFocus(document);
  el("tool").focus();
  el("tree").focus();
  cyclePane(-1);
  expect(document.activeElement).toBe(el("prompt"));
  cyclePane(-1);
  expect(document.activeElement).toBe(el("tool"));
});

test("a pane holding other panes on screen is skipped for them; with none on screen it is a pane itself", () => {
  const el = layout();
  el("editor").remove();
  el("results").remove();
  el("tree").focus();
  cyclePane(1);
  expect(document.activeElement).toBe(el("work"));
});
