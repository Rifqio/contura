// The frame bar (Decision 22; Miro's frame bar, Figma's bottom bar): the selected frame's settings at the bottom centre
// of the canvas. Reset layout, the frame's name, its kind's settings (Direction, Look, Notation), Text size, Colour for
// the selected shapes, and More (Publish frame, Insert Mermaid, Tidy selection, Duplicate, Open as DBML, Delete).
// Every control is a Tab stop; the arrows, Home and End move along the bar (WAI-ARIA toolbar), except in the name
// field, which keeps them for its text. Keys pressed on the bar never reach the canvas.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon";
import Menu, { type MenuItem } from "../../components/Menu";
import Select from "../../components/Select";
import { type DiagramKind, FIXED_KINDS } from "../../lang/flow/model";
import { type ColourMenu, colourMenuItem } from "../canvasMenus";
import type { FlowDirection } from "../layout";
import type { NodeLook } from "../nodes/parts";
import type { ErNotation, TextSize } from "./boardLayout";

/** What the bar sets on a frame: the settings `setFrameSetting` keeps. */
export type FrameSettingPatch = Partial<{ direction: FlowDirection; style: NodeLook; notation: ErNotation; textSize: TextSize }>;

/** The frame's settings as drawn: its entry's, else its kind's defaults. */
export interface FrameSettings {
  direction: FlowDirection;
  style: NodeLook;
  notation: ErNotation;
  textSize: TextSize;
}

interface Props {
  /** The selected frame: its title and kind. */
  frame: { title: string; kind: DiagramKind | null; index: number };
  layout: FrameSettings;
  /** How many shapes are selected in this frame: Colour needs one. */
  selectedShapes: number;
  /** How many frames the board has. */
  frames: number;
  /** Today's Tidy on the whole frame. */
  onReset(): void;
  /** Renames the frame; resolves to why it could not, or null once renamed. */
  onRename(title: string): Promise<string | null>;
  onSetting(patch: FrameSettingPatch): void;
  /** The selected shapes' Colour row, as their menu has it. */
  onColour(): ColourMenu;
  /** The More menu's rows (`frameMoreItems`). */
  onMore(): MenuItem[];
  /** Esc on the bar: the keys go back to the canvas. */
  onLeave?(): void;
}

const DIRECTIONS = [
  { value: "TB" as const, label: "Top to bottom" },
  { value: "LR" as const, label: "Left to right" },
];
const LOOKS = [
  { value: "modern" as const, label: "Modern" },
  { value: "classic" as const, label: "Classic", hint: "Gane-Sarson" },
];
const NOTATIONS = [
  { value: "crow" as const, label: "Crow's foot" },
  { value: "arrow" as const, label: "Arrows" },
];
const TEXT_SIZES = [
  { value: "s" as const, label: "Small" },
  { value: "m" as const, label: "Medium" },
  { value: "l" as const, label: "Large" },
];

/** Why Colour is off with no shape selected (Decision 22). */
export const COLOUR_NONE = "Select shapes to colour them";

export default function FrameBar({ frame, layout, selectedShapes, frames, onReset, onRename, onSetting, onColour, onMore, onLeave }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(frame.title);
  const committing = useRef(false);
  // The field follows the frame: another frame selected, a rename typed in the text, an undo.
  useEffect(() => setName(frame.title), [frame.title, frame.index]);

  async function commit() {
    if (committing.current) return;
    const want = name;
    if (want === frame.title) return;
    committing.current = true;
    try {
      // A taken or empty name is put back; the tab says why.
      const why = await onRename(want);
      if (why !== null) setName(frame.title);
    } finally {
      committing.current = false;
    }
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && !e.defaultPrevented && t.tagName !== "INPUT" && !t.closest("[role=menu], [role=listbox]")) {
      e.stopPropagation();
      onLeave?.();
      return;
    }
    // Ctrl and Cmd keys go on (undo, Publish): the tab's own handlers take them.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (t.tagName === "INPUT" || t.closest("[role=menu], [role=listbox]") || t.getAttribute("aria-expanded") === "true") return;
    const all = [...(bar.current?.querySelectorAll<HTMLElement>("[data-frame-bar-stop]") ?? [])].filter((el) => !(el as HTMLButtonElement).disabled);
    const i = all.indexOf(t.closest<HTMLElement>("[data-frame-bar-stop]") ?? t);
    if (i < 0) return;
    const to = e.key === "ArrowRight" ? (i + 1) % all.length : e.key === "ArrowLeft" ? (i - 1 + all.length) % all.length : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    all[to].focus();
  }

  // Select and Menu render their own buttons: the bar marks them as its stops once they are drawn.
  useEffect(() => {
    bar.current?.querySelectorAll<HTMLElement>(".select-button, .menu-root > button").forEach((el) => el.setAttribute("data-frame-bar-stop", ""));
  });

  const kind = frame.kind;
  const laidOut = !!kind && !FIXED_KINDS.has(kind);
  const colour = selectedShapes > 0 ? onColour() : null;
  const colourItems = colour ? (colourMenuItem(colour).submenu ?? []) : [];
  const colourWhy = selectedShapes === 0 ? COLOUR_NONE : colour?.why ?? null;

  return (
    <div ref={bar} className="frame-bar nodrag nopan" role="toolbar" aria-label={`${frame.title || "Untitled"} settings`} onKeyDown={onKey}>
      {laidOut && (
        <button type="button" className="flow-tool" aria-label="Reset layout" data-frame-bar-stop="" onClick={onReset}>
          <Icon name="tidy" />
          <span className="flow-hint" aria-hidden="true">
            Reset layout
          </span>
        </button>
      )}
      <input
        className="frame-bar-name"
        aria-label="Frame name"
        data-frame-bar-stop=""
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setName(frame.title);
          }
        }}
        onBlur={() => void commit()}
      />
      <span className="frame-bar-divider" aria-hidden="true" />
      {laidOut && <Select label="Direction" value={layout.direction} options={DIRECTIONS} onChange={(direction) => onSetting({ direction })} />}
      {kind === "dfd" && <Select label="Look" value={layout.style} options={LOOKS} onChange={(style) => onSetting({ style })} />}
      {kind === "er" && <Select label="Notation" value={layout.notation} options={NOTATIONS} onChange={(notation) => onSetting({ notation })} />}
      <Select label="Text size" value={layout.textSize} options={TEXT_SIZES} onChange={(textSize) => onSetting({ textSize })} />
      <span className="frame-bar-divider" aria-hidden="true" />
      {colourItems.length > 0 && colourWhy === null ? (
        <Menu
          label="Colour"
          compact
          items={colourItems}
          trigger={(t) => (
            <button type="button" className="flow-tool" aria-label="Colour" {...t}>
              <Icon name="paint" />
              <span className="flow-hint" aria-hidden="true">
                Colour
              </span>
            </button>
          )}
        />
      ) : (
        <button type="button" className="flow-tool" aria-label="Colour" disabled title={colourWhy ?? COLOUR_NONE}>
          <Icon name="paint" />
        </button>
      )}
      <Menu
        label={`${frame.title || "Untitled"} actions`}
        align="end"
        // The last frame is never deleted (Decision 22).
        items={onMore().map((it) => (it.key === "delete" && frames <= 1 ? { ...it, disabled: true } : it))}
        trigger={(t) => (
          <button type="button" className="flow-tool" aria-label="More" {...t}>
            <Icon name="moreHorizontal" />
            <span className="flow-hint" aria-hidden="true">
              More
            </span>
          </button>
        )}
      />
    </div>
  );
}
