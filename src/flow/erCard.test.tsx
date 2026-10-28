// The ER table card on its own: what it draws from the text, that it edits nothing while the assistant holds the
// diagram (read-only), in an old-form frame or in a preview with no editing context, and that it draws only the rows
// in view (decision 7) and only the card whose slice changed (decision 6). jsdom measures nothing and fires no scroll
// event on a `scrollTop` write, so the window is driven by `fireEvent.scroll` and checked by counts (R28).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ER_NOTES } from "../lang/flow/edits";
import { type ErCanvasApi, ErCanvasContext, createErStore, type ErStore } from "./erCanvas";
import { createErScrollStore, createErSoleStore, ErScrollContext, ErSoleContext } from "./erScroll";
import { ER_CARD_CHROME, erRowWindow, erViewH, KIND_ROW, kindSize } from "./kindLayout";
import canvasCss from "../styles/flow-canvas.css?raw";
import { parseFlow } from "../lang/flow/parse";
import { buildFlowGraph, nodeLimitsFor } from "./flowNodes";
import { KindNode, type KindNodeData } from "./kindNodes";

afterEach(cleanup);

const DATA: KindNodeData = {
  name: "customers",
  kind: "erTable",
  look: "modern",
  rows: ["id int", "email text", "note"],
  rowFlags: [["pk"], ["not null", "unique"], []],
};

function api(readOnly: boolean, blocked: string | null = null): ErCanvasApi {
  return {
    readOnly,
    editTable: vi.fn(),
    editColumn: vi.fn(),
    addColumn: vi.fn(),
    firstColumn: vi.fn(),
    selectColumn: vi.fn(),
    pickTable: vi.fn(),
    blocked: vi.fn(() => blocked),
    pointColumn: vi.fn(),
    toggleFlag: vi.fn(),
    duplicateColumn: vi.fn(),
    deleteColumn: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".fkind-er-row")];
const spacers = () => [...document.querySelectorAll<HTMLElement>(".fkind-er-spacer")];
const many = (n: number) => Array.from({ length: n }, (_, i) => `c${i} int`);

test("the card draws each column's key, name, type and not-null mark from the text", () => {
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store: createErStore() }}>
      <KindNode d={DATA} selected={false} />
    </ErCanvasContext.Provider>,
  );
  expect(rows().map((r) => [r.querySelector(".fkind-col")!.textContent, r.querySelector(".fkind-type")!.textContent])).toEqual([
    ["id", "int"],
    ["email", "text"],
    ["note", ""],
  ]);
  expect(rows().map((r) => !!r.querySelector(".fkind-key"))).toEqual([true, false, false]);
  expect(rows().map((r) => r.querySelector<HTMLElement>(".fkind-nn")!.title)).toEqual(["Not null", "Not null", "Nullable"]);
  expect(rows()[1].title).toBe("email text (unique, not null)");
});

test("read-only while the assistant works: double-clicks, the gutter and + column do nothing", () => {
  const er = api(true);
  render(
    <ErCanvasContext.Provider value={{ api: er, store: createErStore() }}>
      <KindNode d={DATA} selected />
    </ErCanvasContext.Provider>,
  );
  fireEvent.doubleClick(document.querySelector(".fkind-head")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-col")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-type")!);
  fireEvent.doubleClick(document.querySelector(".fkind-er-body")!);
  const gut = within(rows()[2]).getByRole("button", { name: "Primary key" }) as HTMLButtonElement;
  expect(gut.disabled).toBe(true);
  fireEvent.click(gut);
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  for (const f of [er.editTable, er.editColumn, er.addColumn, er.toggleFlag]) expect(f).not.toHaveBeenCalled();
});

test("with no editing context (a preview) the card only draws", () => {
  render(<KindNode d={DATA} selected={false} />);
  expect(rows()).toHaveLength(3);
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  fireEvent.doubleClick(document.querySelector(".fkind-head")!);
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("an_old_frame_card_offers_no_edits_and_says_why", () => {
  const er = api(false, ER_NOTES.oldForm);
  render(
    <ErCanvasContext.Provider value={{ api: er, store: createErStore() }}>
      <KindNode d={DATA} selected />
    </ErCanvasContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  const gut = within(rows()[0]).getByRole("button", { name: "Primary key" }) as HTMLButtonElement;
  expect(gut.disabled).toBe(true);
  expect(gut.title).toBe(ER_NOTES.oldForm);
  fireEvent.click(gut);
  fireEvent.doubleClick(document.querySelector(".fkind-er-body")!);
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-col")!);
  // The gutter does nothing; a double-click still reaches the canvas, whose gate refuses it with the rewrite note in the
  // strip and writes nothing (B3 Task 3, Review Focus 4: every card gesture says why).
  expect(er.toggleFlag).not.toHaveBeenCalled();
  expect(er.addColumn).toHaveBeenCalledWith("customers");
  expect(er.editColumn).toHaveBeenCalledWith("customers", 1, "name");
});

test("the gutter and + column act on a live card, and a column field opens from the store", () => {
  const er = api(false);
  const store = createErStore();
  render(
    <ErCanvasContext.Provider value={{ api: er, store, types: "er-types" }}>
      <KindNode d={DATA} selected />
    </ErCanvasContext.Provider>,
  );
  const gut = within(rows()[0]).getByRole("button", { name: "Primary key" }) as HTMLButtonElement;
  expect(gut.getAttribute("aria-pressed")).toBe("true");
  expect(gut.title).toBe("Primary key. Click to remove");
  expect(within(rows()[1]).getByRole("button", { name: "Primary key" }).title).toBe("Click to make it the primary key");
  fireEvent.click(gut);
  expect(er.toggleFlag).toHaveBeenCalledWith("customers", 0, "pk");
  fireEvent.click(screen.getByRole("button", { name: "Add column" }));
  expect(er.addColumn).toHaveBeenCalledWith("customers");
  fireEvent.doubleClick(rows()[1].querySelector(".fkind-type")!);
  expect(er.editColumn).toHaveBeenCalledWith("customers", 1, "type");
  act(() => store.set({ edit: { kind: "col", table: "customers", index: 1, field: "type" } }));
  // An input with a list is a combobox to the accessibility tree.
  const field = screen.getByRole("combobox", { name: "Column type" }) as HTMLInputElement;
  expect(field.value).toBe("text");
  expect(field.placeholder).toBe("type");
  expect(field.getAttribute("list")).toBe("er-types");
  act(() => store.set({ edit: { kind: "table", table: "customers" } }));
  expect(screen.getByRole("textbox", { name: "Table name" })).not.toBeNull();
});

test("a_300_column_card_draws_at_most_22_rows", () => {
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store: createErStore() }}>
      <KindNode d={{ ...DATA, name: "wide", rows: many(300), rowFlags: undefined }} selected={false} />
    </ErCanvasContext.Provider>,
  );
  const drawn = rows().length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(22);
  expect(spacers().every((s) => s.getAttribute("aria-hidden") === "true")).toBe(true);
  expect(spacers().reduce((n, s) => n + parseFloat(s.style.height || "0"), 0)).toBe((300 - drawn) * 22);
});

test("a_card_resized_taller_stops_at_20_rows", () => {
  const natural = kindSize("erTable", { name: "wide", rows: many(300) })!;
  expect(nodeLimitsFor("erTable", { w: 200, h: 100 }, natural).maxH).toBe(ER_CARD_CHROME + 20 * KIND_ROW);
  expect(nodeLimitsFor("erWeak", { w: 200, h: 100 }, natural).maxH).toBe(ER_CARD_CHROME + 20 * KIND_ROW);
  render(<KindNode d={{ ...DATA, name: "wide", rows: many(300), rowFlags: undefined, sized: { w: 200, h: 1000 } }} selected={false} />);
  expect(rows().length).toBeLessThanOrEqual(22);
});

test("the_window_follows_the_body_scroll", () => {
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store: createErStore() }}>
      <KindNode d={{ ...DATA, name: "wide", rows: many(300), rowFlags: undefined }} selected={false} />
    </ErCanvasContext.Provider>,
  );
  const drawnRows = () => rows().map((r) => Number(r.dataset.erRow));
  expect(drawnRows()).toContain(0);
  const body = document.querySelector<HTMLElement>(".fkind-er-body")!;
  body.scrollTop = 2200;
  fireEvent.scroll(body);
  expect(drawnRows()).toContain(100);
  expect(drawnRows()).not.toContain(0);
  expect(rows().length).toBeLessThanOrEqual(22);
});

test("a_draft_row_is_one_of_the_drawn_rows", () => {
  const store = createErStore();
  store.set({ edit: { kind: "draft", table: "wide", at: 0, field: "name", name: "", type: "" } });
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store }}>
      <KindNode d={{ ...DATA, name: "wide", rows: many(300), rowFlags: undefined }} selected={false} />
    </ErCanvasContext.Provider>,
  );
  const drawn = rows();
  expect(drawn.length).toBeLessThanOrEqual(22);
  expect(drawn[0].classList.contains("is-new")).toBe(true);
  expect(within(drawn[0]).getByRole("textbox", { name: "Column name" })).not.toBeNull();
  // The draft counts as a row: the spacers stand for the other 301 less the drawn.
  expect(spacers().reduce((n, s) => n + parseFloat(s.style.height || "0"), 0)).toBe((301 - drawn.length) * 22);
});

test("opening_a_field_renders_one_card", () => {
  const store: ErStore = createErStore();
  const renders = new Map<string, number>();
  const names = Array.from({ length: 200 }, (_, i) => `t${i}`);
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store }}>
      {names.map((n) => (
        <Profiler key={n} id={n} onRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}>
          <KindNode d={{ ...DATA, name: n }} selected={false} />
        </Profiler>
      ))}
    </ErCanvasContext.Provider>,
  );
  renders.clear();
  act(() => store.set({ edit: { kind: "col", table: "t42", index: 1, field: "name" } }));
  expect([...renders.keys()]).toEqual(["t42"]);
  expect(screen.getByRole("textbox", { name: "Column name" })).not.toBeNull();
});

test("unmounted_cards_leave_no_listener", () => {
  const store = createErStore();
  const names = Array.from({ length: 2000 }, (_, i) => `t${i}`);
  const { unmount } = render(
    <ErCanvasContext.Provider value={{ api: api(false), store }}>
      {names.map((n) => (
        <KindNode key={n} d={{ ...DATA, name: n }} selected={false} />
      ))}
    </ErCanvasContext.Provider>,
  );
  expect(store.listeners()).toBe(2000);
  unmount();
  expect(store.listeners()).toBe(0);
  expect(store.size()).toBe(0);
});

test("the_card_marks_its_fields_for_a_double_click", () => {
  for (const ctx of [{ api: api(false), store: createErStore() }, null]) {
    render(
      <ErCanvasContext.Provider value={ctx}>
        <KindNode d={DATA} selected={false} />
      </ErCanvasContext.Provider>,
    );
    expect(document.querySelector('.fkind-head [data-er-field="head"]')!.textContent).toBe("customers");
    expect(rows().map((r) => r.dataset.erRow)).toEqual(["0", "1", "2"]);
    expect(rows().map((r) => r.querySelector('[data-er-field="name"]')!.textContent)).toEqual(["id", "email", "note"]);
    expect(rows().map((r) => r.querySelector('[data-er-field="type"]')!.textContent)).toEqual(["int", "text", ""]);
    cleanup();
  }
});

test("no_gap_at_the_bottom_of_a_scrolled_card", () => {
  // The body shows `erViewH(h)` px below the header; its rows start 3 px down. The drawn rows, with the spacers for
  // the rest, must meet every pixel of that range: a row even partly in view is drawn (review Important 1).
  for (const [h, scroll] of [
    [300, 10],
    [undefined, 21],
    [undefined, 0],
    [131, 5],
  ] as const) {
    const view = erViewH(h);
    const { from, to } = erRowWindow(300, view, scroll);
    expect(to - from).toBeLessThanOrEqual(22);
    if (from > 0) expect(from * KIND_ROW + 3, `top for ${h} at ${scroll}`).toBeLessThanOrEqual(scroll);
    expect(to * KIND_ROW + 3, `bottom for ${h} at ${scroll}`).toBeGreaterThanOrEqual(scroll + view);
  }
  // h = 300 at scroll 10: the body shows 10..276, so row 12 (267..289) is drawn.
  expect(erRowWindow(300, erViewH(300), 10).to).toBeGreaterThanOrEqual(13);
});

test("the_add_column_button_can_take_focus", () => {
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store: createErStore() }}>
      <KindNode d={DATA} selected />
    </ErCanvasContext.Provider>,
  );
  const add = screen.getByRole("button", { name: "Add column" });
  add.focus();
  expect(document.activeElement).toBe(add);
  // jsdom applies no stylesheet: the rule is read as text. Hidden off-hover by opacity, never display: none (which
  // takes an element out of the tab order), and shown on a selected card or one holding focus.
  const rule = /\.fkind-addcol \{([^}]*)\}/.exec(canvasCss)![1];
  expect(rule).not.toMatch(/display:\s*none/);
  expect(rule).toMatch(/opacity:\s*0/);
  expect(canvasCss).toMatch(/\.react-flow__node\.selected \.fkind-addcol/);
  expect(canvasCss).toMatch(/\.react-flow__node:focus-within \.fkind-addcol/);
});

test("a_layout_taller_than_20_rows_draws_at_20", () => {
  const doc = parseFlow(['diagram er "x"', "wide {", ...Array.from({ length: 30 }, (_, i) => `  c${i} int`), "}", ""].join("\n")).doc!;
  const node = buildFlowGraph(doc, { wide: { x: 0, y: 0 } }, "modern", { sizes: { wide: { w: 200, h: 1000 } } }).nodes[0];
  expect((node.data as KindNodeData).sized).toEqual({ w: 200, h: ER_CARD_CHROME + 20 * KIND_ROW });
  expect(node.initialHeight).toBe(ER_CARD_CHROME + 20 * KIND_ROW);
});

// ---- B3 Task 11: the row window's trim when a field is pinned, and the listeners of cards at the limit

/** A 300-column card with a column field open on `index`, its body then scrolled to `top` (the field's row out of view). */
function pinned(index: number, top: number) {
  const store = createErStore();
  store.set({ edit: { kind: "col", table: "wide", index, field: "name" } });
  render(
    <ErCanvasContext.Provider value={{ api: api(false), store }}>
      <KindNode d={{ ...DATA, name: "wide", rows: many(300), rowFlags: undefined }} selected={false} />
    </ErCanvasContext.Provider>,
  );
  const body = document.querySelector<HTMLElement>(".fkind-er-body")!;
  body.scrollTop = top;
  fireEvent.scroll(body);
  return rows().map((r) => Number(r.dataset.erRow));
}

test("a_pinned_field_trims_a_full_window_to_22_rows", () => {
  // jsdom fires no scroll event on a `scrollTop` write, so the scroll is sent by hand (R28). At 2,214 px the view
  // meets rows 100 to 120 and the window is the full 22 (99 to 120 with its overscan row above).
  expect(erRowWindow(300, erViewH(undefined), 2214)).toEqual({ from: 99, to: 121 });
  const above = pinned(0, 2214);
  // Row 0's open field is drawn wherever the body is; the overscan row above gives way for it, never a row in view.
  expect(above.length).toBe(22);
  expect(above[0]).toBe(0);
  expect(above).not.toContain(99);
  expect(above).toContain(100);
  expect(above).toContain(120);
  expect(screen.getByRole("textbox", { name: "Column name" }).closest(".fkind-er-row")!.getAttribute("data-er-row")).toBe("0");
  expect(spacers().reduce((n, sp) => n + parseFloat(sp.style.height || "0"), 0)).toBe((300 - 22) * 22);
  cleanup();
  // At the top the window has no overscan row above (rows 0 to 21): the far end gives way for a field below it.
  expect(erRowWindow(300, erViewH(undefined), 14)).toEqual({ from: 0, to: 22 });
  const below = pinned(200, 14);
  expect(below.length).toBe(22);
  expect(below.slice(0, 21)).toEqual(Array.from({ length: 21 }, (_, i) => i));
  expect(below[21]).toBe(200);
  expect(spacers().reduce((n, sp) => n + parseFloat(sp.style.height || "0"), 0)).toBe((300 - 22) * 22);
});

test("cards_at_the_limit_leave_no_listener_in_any_store", () => {
  // Minor 3 of Task 5's review: the live cards' own listeners at the limit, in the ER store, the scroll store and the
  // sole-table store, and on the window and document. 2,000 cards mounted, then unmounted: every count back to 0.
  const store = createErStore();
  const scroll = createErScrollStore();
  const sole = createErSoleStore();
  let soles = 0;
  const subscribe = sole.subscribe.bind(sole);
  sole.subscribe = (t, fn) => {
    soles++;
    const off = subscribe(t, fn);
    return () => {
      soles--;
      off();
    };
  };
  const names = Array.from({ length: 2000 }, (_, i) => `t${i}`);
  const added = { n: 0 };
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
      added.n++;
      add(type, fn, o);
    });
    vi.spyOn(target, "removeEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
      added.n--;
      remove(type, fn, o);
    });
  }
  const before = added.n;
  const { unmount } = render(
    <ErCanvasContext.Provider value={{ api: api(false), store }}>
      <ErScrollContext.Provider value={scroll}>
        <ErSoleContext.Provider value={sole}>
          {names.map((n) => (
            <KindNode key={n} d={{ ...DATA, name: n }} selected={false} />
          ))}
        </ErSoleContext.Provider>
      </ErScrollContext.Provider>
    </ErCanvasContext.Provider>,
  );
  // One listener per card in each store, none on the window or the document.
  expect(store.listeners()).toBe(2000);
  expect(names.reduce((n, t) => n + scroll.listeners(t), 0)).toBe(2000);
  expect(soles).toBe(2000);
  expect(added.n - before).toBe(0);
  unmount();
  expect(store.listeners()).toBe(0);
  expect(names.reduce((n, t) => n + scroll.listeners(t), 0)).toBe(0);
  expect(soles).toBe(0);
  expect(added.n - before).toBe(0);
  vi.restoreAllMocks();
});

test("an_er_card_scales_its_rows_header_and_padding_with_the_text_size", () => {
  const { container } = render(<KindNode d={{ ...DATA, textScale: 0.88 }} selected={false} />);
  expect(rows().map((r) => parseFloat(r.style.height))).toEqual([22 * 0.88, 22 * 0.88, 22 * 0.88]);
  expect(parseFloat(container.querySelector<HTMLElement>(".fkind-head")!.style.height)).toBeCloseTo(32 * 0.88, 9);
  expect(container.querySelector<HTMLElement>(".fkind-er-rows")!.style.padding).toBe(`${3 * 0.88}px 0px`);
  cleanup();
  // At Medium the stylesheet's own sizes hold: no inline header or padding.
  const plain = render(<KindNode d={DATA} selected={false} />);
  expect(rows().map((r) => parseFloat(r.style.height))).toEqual([22, 22, 22]);
  expect(plain.container.querySelector<HTMLElement>(".fkind-head")!.style.height).toBe("");
});
