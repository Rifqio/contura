// What every drawn diagram node shares: the look switch, the kind's colour tokens, hover, the selection
// mark and the four round ports, which show only on hover or selection (motion design, "Hover a node").
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useDetail } from "../../diagram/detail";
import { motionMs } from "../../diagram/motion";
import { type DrawnKind, NODE_TOKENS } from "../../diagram/types";
import { colourStyle, type DrawnColour, presetOf } from "../palette";

/** A colour a shape takes: a preset (`color: danger`) or a custom one (`color: teal`). */
export type ShapeColour = DrawnColour;

/** Modern is the pastel card (frame 6+.2); Classic draws the textbook Gane-Sarson shapes. Kept per diagram. */
export type NodeLook = "modern" | "classic";

export interface NodeBaseProps {
  name: string;
  /** The `id` attribute (`1.0`, `D1`), drawn in the id cell. */
  id?: string;
  style: NodeLook;
  selected: boolean;
  /** Fading in after an add, or out before a delete (motion design, 120 ms). */
  state?: NodeState;
  /** Item 21: the size it was resized to on the canvas. */
  sized?: { w: number; h: number };
  /** Step 11: its `color:`, in place of its kind's colours. */
  color?: ShapeColour;
}

/**
 * A node fading in from 96 percent after an add, or fading out before a delete. The diagram assistant's marks
 * (board 11.5): `suggested` is new in its review (green, dashed, a "New" badge), `removed` is what it would remove
 * (red), `changed` is renamed, moved, retyped or relabelled by it (a soft tint, no motion; Plan D Decision 11),
 * `airing` was just added by it (an accent ring that fades); `ringed` is the same ring on a part an answer only named,
 * which changed nothing, so its name gets no note.
 */
export type NodeState = "entering" | "leaving" | "suggested" | "removed" | "changed" | "airing" | "ringed";

/** The class a state draws with: a named part's ring is the landing's ring. */
export const stateClass = (state: NodeState): string => (state === "ringed" ? "airing" : state);

/** What the assistant's marks add to a node's (or an ER row's) accessible name. */
export const STATE_NOTE: Partial<Record<NodeState, string>> = {
  suggested: ", suggested by AI",
  removed: ", removal suggested by AI",
  changed: ", changed by AI",
  airing: ", added by AI",
};

/** The kind's token pair as the custom properties the stylesheet reads (ADR 0008: tokens only). */
export function kindStyle(kind: DrawnKind, color?: ShapeColour): CSSProperties {
  // A colour draws its fill, border and words in place of the kind's pair (ADR 0019).
  if (color) return colourStyle(color);
  const t = NODE_TOKENS[kind];
  return { "--fnode-fill": `var(${t.fill})`, "--fnode-stroke": `var(${t.stroke})` } as CSSProperties;
}

const SIDES = ["r", "l", "t", "b"] as const;

/** Right, left, top and bottom ports; a flow is drawn from one of them. `out` fades them away. */
function Ports({ out }: { out: boolean }) {
  return (
    <>
      {SIDES.map((s) => (
        <i key={s} className={out ? "fnode-port fnode-port-out" : "fnode-port"} data-side={s} aria-hidden="true" />
      ))}
    </>
  );
}

/** Ports on while hovered; on leave they fade for the ports duration, then unmount (at once under reduced motion). */
function useHoverPorts() {
  const [state, setState] = useState<"off" | "on" | "out">("off");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = () => {
    clearTimeout(timer.current);
    setState("on");
  };
  const leave = () => {
    clearTimeout(timer.current);
    const ms = motionMs("ports");
    if (ms === 0) {
      setState("off");
      return;
    }
    setState("out");
    timer.current = setTimeout(() => setState("off"), ms);
  };
  return { state, enter, leave };
}

interface ShellProps {
  kind: DrawnKind;
  /** `dfd`, `flowchart`, `service` or `kind` (the step 12 shapes): which family's rules in flow-canvas.css apply. */
  family: "dfd" | "flowchart" | "service" | "kind";
  look: NodeLook;
  selected: boolean;
  /** The accessible name, at every level of detail ("Process Checkout"). */
  label: string;
  /** The plain name the zoomed-out box shows. */
  name: string;
  state?: NodeState;
  /** Resized on the canvas: drawn at this size (item 21). */
  sized?: { w: number; h: number };
  /** Step 11: its palette colour. */
  color?: ShapeColour;
  /** The full node; a function places the ports itself (a service puts them on its 48 px tile). */
  children: ReactNode | ((ports: ReactNode) => ReactNode);
}

/**
 * The node's outer box, at the engine's levels of detail: the full node, a name box zoomed out and in fast
 * mode (over 300 nodes), and a plain block in the stroke colour further out. Fast mode has no ports or hover.
 */
/** Shapes with no text (a state's start, end and fork): drawn as they are at every zoom, never as a name box. */
const GLYPHS: ReadonlySet<string> = new Set(["stateStart", "stateEnd", "fork"]);

export function NodeShell({ kind, family, look, selected, label: plain, name, state, sized, color, children }: ShellProps) {
  const level = useDetail();
  const fast = level.fast;
  const detail = GLYPHS.has(kind) ? "full" : level.detail;
  const label = plain + ((state && STATE_NOTE[state]) ?? "");
  const badge = state === "suggested" ? (
    <span className="fnode-gtag" aria-hidden="true">
      New
    </span>
  ) : null;
  const hover = useHoverPorts();
  const sel = (selected ? " fnode-selected" : "") + (state ? ` fnode-${stateClass(state)}` : "") + (sized ? " fnode-sized" : "") + (color ? ` fnode-col${presetOf(color) ? ` fnode-col-${color}` : ""}` : "");
  // The node itself takes the size, not React Flow's wrapper, which stays measured from it.
  const box: CSSProperties = sized ? { ...kindStyle(kind, color), width: sized.w, height: sized.h } : kindStyle(kind, color);
  // Zoomed out the node drops its family and look classes, so no shape rule (diamond, slant, pill) applies.
  const cls = detail === "full" ? `fnode fnode-${family} fnode-${kind} fnode-${look}${sel}` : `fnode fnode-${detail}${sel}`;
  if (detail === "block") {
    return <div className={cls} role="group" aria-label={label} data-kind={kind} style={box} />;
  }
  const showPorts = !fast && (selected || hover.state !== "off");
  const ports = showPorts ? <Ports out={!selected && hover.state === "out"} /> : null;
  const placed = typeof children === "function";
  return (
    <div
      className={cls}
      role="group"
      aria-label={label}
      data-kind={kind}
      style={box}
      onPointerEnter={fast ? undefined : hover.enter}
      onPointerLeave={fast ? undefined : hover.leave}
    >
      {detail === "box" ? <span className="fnode-name">{name}</span> : placed ? children(ports) : children}
      {(detail === "box" || !placed) && ports}
      {badge}
    </div>
  );
}
