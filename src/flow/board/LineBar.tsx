// The line bar (Task 10): with exactly one line selected it takes the frame bar's place and offers the line's Colour
// and, in an ERD, its Cardinality. It keeps the frame bar's placement, keyboard rules (every control a Tab stop, the
// arrows, Home and End along the bar, Esc back to the canvas) and tokens.
import { type KeyboardEvent, useEffect, useRef } from "react";
import Icon from "../../components/Icon";
import Menu, { type MenuItem } from "../../components/Menu";
import Select from "../../components/Select";
import { ARROWS, type DiagramKind, erCardinality, type FlowArrow, type FlowLink, LINE_COLOUR_DIAGRAMS } from "../../lang/flow/model";
import { ARROW_NAMES, colourMenuItem } from "../canvasMenus";
import { COLOUR_WHY, NO_COLOUR } from "../editWords";
import { drawnColour, type PaletteName } from "../palette";

interface Props {
  kind: DiagramKind;
  link: Pick<FlowLink, "arrow" | "color" | "tree">;
  /** Writes the colour (null clears it) on the selected line only. */
  onColour(color: PaletteName | null): void;
  /** Writes the arrow on the selected line only. */
  onArrow(arrow: FlowArrow): void;
  /** The Assistant holds the text: nothing here writes. */
  disabled?: boolean;
  /** Esc on the bar: the keys go back to the canvas. */
  onLeave?(): void;
}

/**
 * The example colour the hint shows as code text; nothing is drawn in it. Built from its parts so the check for
 * literal colours in components (appCss.test.ts) still catches every colour that is drawn.
 */
const EXAMPLE_HEX = ["#", "2f6f8f"].join("");
/** The hint under the presets: any CSS colour works when typed in the code. */
export const COLOUR_HINT = `Or type any CSS colour in the code: color: "${EXAMPLE_HEX}"`;

/** Why the controls are off while the Assistant holds the text. */
const LOCKED = "The Assistant is editing. Colour and cardinality are off until it finishes.";

type Cardinal = keyof typeof erCardinality;
/** The line menu's Cardinality, in the same order and words, each with its arrow (B3 R19: one list, `ARROW_NAMES`). */
const CARDINALITIES: { value: Cardinal; label: string }[] = (ARROWS.er as readonly Cardinal[]).map((a) => ({ value: a, label: `${ARROW_NAMES.er[a]} ${a}` }));

/** Why this kind (or this line) takes no colour; null when it does. */
function colourWhy(kind: DiagramKind, tree: boolean | undefined): string | null {
  if (kind === "sequence") return NO_COLOUR.sequence ?? COLOUR_WHY.lines;
  if (!LINE_COLOUR_DIAGRAMS.has(kind)) return NO_COLOUR[kind] ?? COLOUR_WHY.lines;
  return tree ? COLOUR_WHY.lines : null;
}

export default function LineBar({ kind, link, onColour, onArrow, disabled, onLeave }: Props) {
  const bar = useRef<HTMLDivElement>(null);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && !e.defaultPrevented && !t.closest("[role=menu], [role=listbox]")) {
      e.stopPropagation();
      onLeave?.();
      return;
    }
    // Ctrl and Cmd keys go on (undo): the tab's own handlers take them.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (t.closest("[role=menu], [role=listbox]") || t.getAttribute("aria-expanded") === "true") return;
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

  const why = colourWhy(kind, link.tree);
  const items: MenuItem[] = why
    ? []
    : [
        ...(colourMenuItem({ current: drawnColour(link.color) ?? "", why: null, pick: onColour }).submenu ?? []),
        { key: "colour:hint", label: COLOUR_HINT, heading: COLOUR_HINT, separatorBefore: true },
      ];

  return (
    <div ref={bar} className="frame-bar nodrag nopan" role="toolbar" aria-label="Line settings" onKeyDown={onKey}>
      {why === null && !disabled ? (
        <Menu
          label="Colour"
          compact
          items={items}
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
        <button type="button" className="flow-tool" aria-label="Colour" disabled title={why ?? LOCKED}>
          <Icon name="paint" />
        </button>
      )}
      {kind === "er" && (
        <Select
          label="Cardinality"
          value={(link.arrow in erCardinality ? link.arrow : ">") as Cardinal}
          options={CARDINALITIES}
          disabled={disabled}
          onChange={(v) => onArrow(v)}
        />
      )}
    </div>
  );
}
