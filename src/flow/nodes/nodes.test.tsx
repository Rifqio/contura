import { act, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import flowCanvasCss from "../../styles/flow-canvas.css?raw";
import tokensCss from "../../styles/tokens.css?raw";
import { DetailContext, detailFor } from "../../diagram/detail";
import { MOTION, setReducedMotionPref } from "../../diagram/motion";
import { NODE_TOKENS, type NodeKind } from "../../diagram/types";
import DfdNode, { type DfdNodeKind } from "./DfdNode";
import FlowchartNode, { type FlowchartNodeKind } from "./FlowchartNode";
import ServiceNode from "./ServiceNode";
import { KindNode, type KindNodeData } from "../kindNodes";
import type { NodeLook } from "./parts";

const DFD: DfdNodeKind[] = ["process", "store", "external"];
const FLOWCHART: FlowchartNodeKind[] = ["start", "end", "step", "decision", "io", "subprocess"];
const LOOKS: NodeLook[] = ["modern", "classic"];

/** One node of every kind, with an id, in the given look. */
function every(look: NodeLook, selected = false): { kind: NodeKind; el: ReactElement }[] {
  return [
    ...DFD.map((kind) => ({ kind, el: <DfdNode kind={kind} name="Checkout" id="X1" style={look} selected={selected} /> })),
    ...FLOWCHART.map((kind) => ({ kind, el: <FlowchartNode kind={kind} name="Ship order" id="X1" style={look} selected={selected} /> })),
    { kind: "service" as const, el: <ServiceNode name="Orders" id="X1" style={look} selected={selected} /> },
  ];
}

const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i;

let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = tokensCss + flowCanvasCss;
  document.head.appendChild(sheet);
});
afterEach(() => sheet.remove());

/** A token's value in one theme block of tokens.css, read from the text. */
function tokenIn(theme: "light" | "dark", name: string): string {
  const open = theme === "light" ? ":root, .theme-light {" : ':root[data-theme="dark"], .theme-dark {';
  const at = tokensCss.indexOf(open);
  const body = tokensCss.slice(at, tokensCss.indexOf("}", at));
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`no ${name} in ${theme}`);
  return m[1].trim();
}

describe("every kind in both looks", () => {
  for (const look of LOOKS) {
    test(`classes_and_id_cell_${look}`, () => {
      for (const { kind, el } of every(look)) {
        const { container, unmount } = render(el);
        const root = container.firstElementChild as HTMLElement;
        expect(root.classList.contains("fnode"), kind).toBe(true);
        expect(root.classList.contains(`fnode-${kind}`), kind).toBe(true);
        expect(root.classList.contains(`fnode-${look}`), kind).toBe(true);
        expect(root.querySelector(".fnode-id")?.textContent, kind).toBe("X1");
        expect(root.querySelector(".fnode-name")?.textContent, kind).toBeTruthy();
        unmount();
      }
    });
  }

  test("kind_colours_are_tokens_in_light_and_dark", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const look of LOOKS) {
        for (const { kind, el } of every(look)) {
          const { container, unmount } = render(<div className={`theme-${theme}`}>{el}</div>);
          const root = container.querySelector(".fnode") as HTMLElement;
          const css = getComputedStyle(root);
          const { fill, stroke } = NODE_TOKENS[kind];
          expect(css.getPropertyValue("--fnode-fill").trim(), kind).toBe(`var(${fill})`);
          expect(css.getPropertyValue("--fnode-stroke").trim(), kind).toBe(`var(${stroke})`);
          // The token resolves on the node to the theme's own value.
          expect(css.getPropertyValue(fill).trim(), `${kind} ${theme}`).toBe(tokenIn(theme, fill));
          expect(css.getPropertyValue(stroke).trim(), `${kind} ${theme}`).toBe(tokenIn(theme, stroke));
          expect(LITERAL_COLOUR.test(container.innerHTML), `${kind} ${look}`).toBe(false);
          unmount();
        }
      }
    }
  });

  test("every_kind_has_a_token_pair_that_exists_in_both_themes", () => {
    for (const k of [...DFD, ...FLOWCHART, "service"] as NodeKind[]) {
      const t = NODE_TOKENS[k];
      expect(t, k).toBeDefined();
      for (const theme of ["light", "dark"] as const) {
        expect(tokenIn(theme, t.fill)).toMatch(/^#[0-9a-f]{6}$/);
        expect(tokenIn(theme, t.stroke)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // The artifact's families: steps share one pair, the decision is the one amber diamond, start and end are neutral.
    expect(NODE_TOKENS.step).toEqual(NODE_TOKENS.subprocess);
    expect(NODE_TOKENS.step).toEqual(NODE_TOKENS.io);
    expect(NODE_TOKENS.decision.stroke).toBe("--c-node-enum-stroke");
    expect(NODE_TOKENS.start).toEqual(NODE_TOKENS.end);
    expect(NODE_TOKENS.start.stroke).toBe("--c-node-external-stroke");
    expect(NODE_TOKENS.process.stroke).toBe("--c-node-service-stroke");
    expect(NODE_TOKENS.store.stroke).toBe("--c-node-datastore-stroke");
  });

  test("the_stylesheet_has_no_literal_colours_or_durations", () => {
    const text = flowCanvasCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(text).not.toMatch(LITERAL_COLOUR);
    // Durations come from the motion tokens, which reduced motion zeroes.
    expect(text).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
    expect(text).toMatch(/var\(--motion-fast\)/);
    expect(text).toMatch(/var\(--motion-base\)/);
  });
});

describe("looks", () => {
  test("modern_shows_a_tile_the_name_and_the_kind_in_words", () => {
    const { container } = render(<DfdNode kind="process" name="Checkout" id="1.0" style="modern" selected={false} />);
    expect(container.querySelector(".fnode-tile svg")).not.toBeNull();
    expect(container.querySelector(".fnode-name")?.textContent).toBe("Checkout");
    expect(container.querySelector(".fnode-sub")?.textContent).toBe("Process");
    expect(container.querySelector(".fnode")?.getAttribute("aria-label")).toBe("Process Checkout");
  });

  test("the_assistant_marks_name_themselves_and_a_suggested_shape_has_its_badge", () => {
    const { container } = render(
      <>
        <DfdNode kind="process" name="Fraud check" id="1.1" style="modern" selected={false} state="suggested" />
        <DfdNode kind="process" name="Checkout" id="1.0" style="modern" selected={false} state="removed" />
        <FlowchartNode kind="step" name="Pack" style="classic" selected={false} state="airing" />
      </>,
    );
    const nodes = [...container.querySelectorAll(".fnode")];
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual(["Process Fraud check, suggested by AI", "Process Checkout, suggested by AI", "Step Pack, added by AI"]);
    expect(nodes.map((n) => n.querySelector(".fnode-gtag")?.textContent ?? null)).toEqual(["New", null, null]);
    expect(nodes[0].classList.contains("fnode-suggested")).toBe(true);
    expect(nodes[1].classList.contains("fnode-removed")).toBe(true);
    expect(nodes[2].classList.contains("fnode-airing")).toBe(true);
  });

  test("modern_store_names_its_table_and_outside_party_reads_in_words", () => {
    const { container } = render(
      <>
        <DfdNode kind="store" name="Orders" id="D1" table="shop.orders" style="modern" selected={false} />
        <DfdNode kind="external" name="Customer" style="modern" selected={false} />
      </>,
    );
    const [store, ext] = container.querySelectorAll(".fnode");
    expect(store.querySelector(".fnode-sub")?.textContent).toBe("shop.orders");
    expect(store.querySelector(".fnode-sub svg")).not.toBeNull();
    expect(ext.querySelector(".fnode-sub")?.textContent).toBe("Outside party");
    // An outside party with no id has no id cell in the modern look.
    expect(ext.querySelector(".fnode-id")).toBeNull();
  });

  test("classic_draws_the_gane_sarson_parts", () => {
    const { container } = render(
      <>
        <DfdNode kind="process" name="Checkout" id="1.0" style="classic" selected={false} />
        <DfdNode kind="store" name="Orders" style="classic" selected={false} />
        <DfdNode kind="external" name="Customer" style="classic" selected={false} />
      </>,
    );
    const [proc, store, ext] = container.querySelectorAll(".fnode");
    expect(proc.querySelector(".fnode-band .fnode-id")?.textContent).toBe("1.0");
    // A store keeps its id cell even before it has an id, so the open box keeps its shape.
    expect(store.querySelector(".fnode-id")).not.toBeNull();
    expect(store.querySelector(".fnode-tile")).toBeNull();
    expect(ext.classList.contains("fnode-classic")).toBe(true);
  });

  test("io_with_a_table_shows_a_link_icon", () => {
    const { container } = render(
      <>
        <FlowchartNode kind="io" name="Read order" table="shop.orders" style="modern" selected={false} />
        <FlowchartNode kind="io" name="Print" style="modern" selected={false} />
      </>,
    );
    const [linked, plain] = container.querySelectorAll(".fnode");
    expect(linked.querySelector(".fnode-link")).not.toBeNull();
    expect(plain.querySelector(".fnode-link")).toBeNull();
  });

  test("service_tile_is_48px_with_the_icon_unchanged_and_the_name_under", () => {
    const src = "data:image/svg+xml;base64,PHN2Zy8+";
    const { container } = render(<ServiceNode name="Orders" icon={src} style="modern" selected={false} />);
    const tile = container.querySelector(".fnode-tile") as HTMLElement;
    const img = tile.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(src);
    expect(img.getAttribute("alt")).toBe("");
    expect(tile.nextElementSibling?.classList.contains("fnode-name")).toBe(true);
    // The Core inks the icon for the theme, so nothing sits behind it.
    expect(tile.classList.contains("fnode-tile-bare")).toBe(true);
    expect(flowCanvasCss).toMatch(/\.fnode-service \.fnode-tile\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/);
  });

  test("unknown_icon_shows_the_dashed_cube_tile", () => {
    const { container } = render(<ServiceNode name="Orders" unknownIcon style="modern" selected={false} />);
    expect(container.querySelector(".fnode-tile.fnode-tile-unknown svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("an_icon_draws_without_a_plate", () => {
    const src = "data:image/svg+xml;base64,PHN2Zy8+";
    const { container } = render(<ServiceNode name="Orders" icon={src} style="modern" selected={false} />);
    const tile = container.querySelector(".fnode-tile") as HTMLElement;
    expect(tile.classList.contains("fnode-tile-bare")).toBe(true);
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(src);
    // The provider's own square fills the 48 px tile: no plate, no border, no padding around it.
    expect(flowCanvasCss).toMatch(/\.fnode-service \.fnode-tile-bare\s*\{[^}]*border-color:\s*transparent;[^}]*background-color:\s*transparent;/);
    expect(flowCanvasCss).toMatch(/\.fnode-service \.fnode-tile-bare img\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/);
  });

  test("a_pale_logo_draws_with_a_hairline", () => {
    const src = "data:image/svg+xml;base64,PHN2Zy8+";
    const { container, rerender } = render(<ServiceNode name="Orders" icon={src} iconOutline style="modern" selected={false} />);
    expect(container.querySelector("img")?.classList.contains("icon-hairline")).toBe(true);
    rerender(<ServiceNode name="Orders" icon={src} style="modern" selected={false} />);
    expect(container.querySelector("img")?.classList.contains("icon-hairline")).toBe(false);
    // A hairline in the theme's text colour: three tight shadows around the logo's own shape.
    expect(flowCanvasCss).toMatch(/\.icon-hairline\s*\{[^}]*filter:\s*drop-shadow\(0 0 0\.3px var\(--c-text\)\) drop-shadow\(0 0 0\.3px var\(--c-text\)\) drop-shadow\(0 0 0\.3px var\(--c-text\)\);/);
  });

  test("a_service_s_ports_sit_on_its_48px_tile", () => {
    const { container } = render(<ServiceNode name="Orders" style="modern" selected />);
    const tile = container.querySelector(".fnode-tile") as HTMLElement;
    // The four round ports are on the tile, not on the 104 px box with the name.
    expect([...tile.querySelectorAll<HTMLElement>(".fnode-port")].map((p) => p.dataset.side)).toEqual(["r", "l", "t", "b"]);
  });
});

describe("ports", () => {
  afterEach(() => {
    vi.useRealTimers();
    setReducedMotionPref(false);
  });

  test("ports_show_only_on_hover_or_selection", () => {
    vi.useFakeTimers();
    for (const look of LOOKS) {
      for (const { kind, el } of every(look)) {
        const { container, unmount } = render(el);
        const root = container.querySelector(".fnode") as HTMLElement;
        expect(root.querySelectorAll(".fnode-port").length, kind).toBe(0);
        fireEvent.pointerEnter(root);
        const ports = [...root.querySelectorAll<HTMLElement>(".fnode-port")].map((p) => p.dataset.side);
        expect(ports, kind).toEqual(["r", "l", "t", "b"]);
        expect(root.querySelector(".fnode-port-out"), kind).toBeNull();
        // Leaving fades them out over the ports duration, then they are gone.
        fireEvent.pointerLeave(root);
        expect(root.querySelectorAll(".fnode-port.fnode-port-out").length, kind).toBe(4);
        act(() => {
          vi.advanceTimersByTime(MOTION.ports - 1);
        });
        expect(root.querySelectorAll(".fnode-port").length, kind).toBe(4);
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(root.querySelectorAll(".fnode-port").length, kind).toBe(0);
        unmount();
      }
      for (const { kind, el } of every(look, true)) {
        const { container, unmount } = render(el);
        expect(container.querySelectorAll(".fnode-port").length, kind).toBe(4);
        expect(container.querySelector(".fnode")?.classList.contains("fnode-selected"), kind).toBe(true);
        unmount();
      }
    }
  });

  test("hovering_back_in_keeps_the_ports", () => {
    vi.useFakeTimers();
    const { container } = render(<DfdNode kind="process" name="Checkout" style="modern" selected={false} />);
    const root = container.querySelector(".fnode") as HTMLElement;
    fireEvent.pointerEnter(root);
    fireEvent.pointerLeave(root);
    fireEvent.pointerEnter(root);
    act(() => {
      vi.advanceTimersByTime(MOTION.ports * 2);
    });
    expect(root.querySelectorAll(".fnode-port").length).toBe(4);
    expect(root.querySelector(".fnode-port-out")).toBeNull();
  });

  test("ports_go_at_once_under_reduced_motion", () => {
    setReducedMotionPref(true);
    const { container } = render(<DfdNode kind="process" name="Checkout" style="modern" selected={false} />);
    const root = container.querySelector(".fnode") as HTMLElement;
    fireEvent.pointerEnter(root);
    fireEvent.pointerLeave(root);
    expect(root.querySelectorAll(".fnode-port").length).toBe(0);
  });

  test("fast_mode_draws_name_boxes_without_ports", () => {
    // detailFor's real output for a 2,000-node diagram: name boxes at every zoom, no ports, no hover.
    const fast = detailFor(1, 2000);
    expect(fast).toEqual({ detail: "box", fast: true });
    for (const look of LOOKS) {
      for (const { kind, el } of every(look, true)) {
        const { container, unmount } = render(<DetailContext.Provider value={fast}>{el}</DetailContext.Provider>);
        const root = container.querySelector(".fnode") as HTMLElement;
        expect(root.classList.contains("fnode-box"), kind).toBe(true);
        expect(root.classList.contains("fnode-selected"), kind).toBe(true);
        expect(root.getAttribute("aria-label"), kind).toMatch(/ (Checkout|Ship order|Orders)$/);
        // Only the name: no tile, icon, kind words or id cell.
        expect(root.children.length, kind).toBe(1);
        expect(root.firstElementChild?.className, kind).toBe("fnode-name");
        expect(root.querySelector("svg, img"), kind).toBeNull();
        fireEvent.pointerEnter(root);
        expect(root.querySelectorAll(".fnode-port").length, kind).toBe(0);
        unmount();
      }
    }
  });

  test("zoomed_out_a_node_is_a_name_box_and_further_out_a_block", () => {
    const box = detailFor(0.3, 10);
    expect(box).toEqual({ detail: "box", fast: false });
    const { container, rerender } = render(
      <DetailContext.Provider value={box}>
        <DfdNode kind="process" name="Checkout" id="1.0" style="modern" selected={false} />
      </DetailContext.Provider>,
    );
    let root = container.querySelector(".fnode") as HTMLElement;
    expect(root.classList.contains("fnode-box")).toBe(true);
    expect(root.textContent).toBe("Checkout");
    // Not fast: the box still shows ports on hover.
    fireEvent.pointerEnter(root);
    expect(root.querySelectorAll(".fnode-port").length).toBe(4);

    rerender(
      <DetailContext.Provider value={detailFor(0.1, 10)}>
        <DfdNode kind="process" name="Checkout" id="1.0" style="modern" selected={false} />
      </DetailContext.Provider>,
    );
    root = container.querySelector(".fnode") as HTMLElement;
    expect(root.classList.contains("fnode-block")).toBe(true);
    expect(root.getAttribute("aria-label")).toBe("Process Checkout");
    expect(root.textContent).toBe("");
  });

  test("a_state_marker_stays_a_marker_zoomed_out_and_never_shows_its_inner_name", () => {
    // Live check, 25 Oct: the Mermaid preview at 27% drew "[*] start" and "[*] end in Review" as name boxes.
    for (const zoom of [0.3, 0.1]) {
      for (const kind of ["stateStart", "stateEnd", "fork"] as const) {
        const { container, unmount } = render(
          <DetailContext.Provider value={detailFor(zoom, 10)}>
            <KindNode d={{ kind, name: kind === "fork" ? "Split" : "[*] start in Review", look: "modern" } as KindNodeData} selected={false} />
          </DetailContext.Provider>,
        );
        const root = container.querySelector(".fnode") as HTMLElement;
        expect(root.classList.contains(`fnode-${kind}`), `${kind} at ${zoom}`).toBe(true);
        expect(root.classList.contains("fnode-box") || root.classList.contains("fnode-block")).toBe(false);
        expect(root.textContent).not.toContain("[*]");
        unmount();
      }
    }
  });
});

/** The innermost rules of the stylesheet, at-rule wrappers unwrapped (keyframes left out). */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const selector = text.slice(i, open).trim();
      let depth = 0;
      let close = open;
      for (; close < text.length; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}" && --depth === 0) break;
      }
      const body = text.slice(open + 1, close);
      if (selector.startsWith("@media") || selector.startsWith("@supports")) walk(body);
      else if (!selector.startsWith("@")) out.push({ selector, body });
      i = close + 1;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return out;
}

/** The properties a rule's transition list names. */
function transitioned(body: string): string[] {
  const m = /(?:^|;)\s*transition\s*:([^;]+)/.exec(body);
  if (!m) return [];
  return m[1].split(",").map((part) => part.trim().split(/\s+/)[0]);
}

describe("selection", () => {
  test("rings_use_no_property_any_transition_names", () => {
    const all = rules(flowCanvasCss);
    const animated = new Set(all.flatMap((r) => transitioned(r.body)));
    expect(animated.has("border-color")).toBe(true);
    // A ring drawn on ::after is never animated, as long as no ::after rule has a transition.
    for (const r of all.filter((x) => x.selector.includes("::after"))) expect(r.body, r.selector).not.toMatch(/transition/);
    const onAfter = (selector: string) => selector.split(",").every((s) => s.trim().endsWith("::after"));
    const rings = all.filter((r) => r.selector.includes("fnode-selected"));
    expect(rings.length).toBeGreaterThan(0);
    for (const r of rings) {
      if (!onAfter(r.selector)) for (const m of r.body.matchAll(/([a-z-]+)\s*:/g)) {
        const prop = m[1];
        const hit = [...animated].some((a) => prop === a || prop.startsWith(`${a}-`) || a.startsWith(`${prop}-`));
        expect(hit, `${r.selector} sets ${prop}, which a transition animates`).toBe(false);
      }
      // A selected node keeps the full transition rule, so a delete fades on the exit timing.
      expect(r.body, r.selector).not.toMatch(/transition/);
    }
    // The node's own list: opacity and transform on the base duration with the exit curve.
    const base = all.find((r) => r.selector === ".fnode")!.body;
    expect(base).toMatch(/opacity var\(--motion-base\) var\(--ease-exit\)/);
    expect(base).toMatch(/transform var\(--motion-base\) var\(--ease-exit\)/);
  });

  test("modern_and_flowchart_draw_a_ring_and_classic_an_outline_like_the_schema_card", () => {
    const all = rules(flowCanvasCss);
    const ring = all.find((r) => r.selector.split(",").map((x) => x.trim()).includes(".fnode-selected::after"));
    expect(ring?.body).toMatch(/border:\s*2px solid var\(--c-accent\)/);
    const classic = all.find((r) => r.selector === ".fnode-dfd.fnode-classic.fnode-selected");
    expect(classic?.body).toMatch(/outline:\s*2px solid var\(--c-accent\)/);
    expect(classic?.body).toMatch(/outline-offset:\s*5px/);
  });
});
