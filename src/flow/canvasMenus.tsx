// ER step 2.4 and diagram step 4 (erd-ux-research 5.6; diagram-ux-research F31, F8, F11, F12, C2, CL2): the canvas's
// right-click menus, one per target, what is under the pointer first, each item's key on the right. FlowTab picks
// the target and runs the actions; these only say what each menu holds and in which order.
import Icon from "../components/Icon";
import type { MenuItem } from "../components/Menu";
import type { ColumnFlag, DiagramKind, FlowArrow } from "../lang/flow/model";
import { ARROWS } from "../lang/flow/model";
import type { AddTool } from "./FlowToolbar";
import { COLOUR_INFO, colourVars, type DrawnColour, PALETTE, type PaletteName, presetOf } from "./palette";

/**
 * Step 11 (board DiagramColourLabels; draw.io Fill, Miro, eraser.io `color`): Colour in a shape's, a selection's, a
 * line's or a group's menu. Six swatches, each with its name, what it means and the word the file gets, then Clear
 * colour. Where a colour cannot be written the row is off and its tooltip says why.
 */
export interface ColourMenu {
  /** The colour now: a palette name or a custom hex, "" for none, null when the shapes picked differ. */
  current: DrawnColour | "" | null;
  /** Why no colour can be written here; null when one can. */
  why: string | null;
  pick(colour: PaletteName | null): void;
}

export function colourMenuItem(c: ColourMenu): MenuItem {
  const hint = c.why ? "not here" : c.current === null ? "mixed" : c.current ? (presetOf(c.current) ? COLOUR_INFO[presetOf(c.current)!].label : "custom") : "none";
  return {
    key: "colour",
    label: "Colour",
    hint,
    disabled: c.why !== null,
    ...(c.why !== null ? { title: c.why } : {}),
    submenu: [
      ...PALETTE.map((p) => ({
        key: `colour:${p}`,
        label: COLOUR_INFO[p].label,
        icon: <i className={`flow-swatch is-col-${p}`} style={colourVars(p)} aria-hidden="true" />,
        description: COLOUR_INFO[p].means,
        hint: `color: ${p}`,
        checked: c.current === p,
        onSelect: () => c.pick(p),
      })),
      {
        key: "colour:none",
        label: "Clear colour",
        icon: <i className="flow-swatch is-none" aria-hidden="true" />,
        description: "Back to the kind's own colours",
        checked: c.current === "",
        separatorBefore: true,
        onSelect: () => c.pick(null),
      },
    ],
  };
}

/**
 * What each arrow is called in a line's menu, by kind: draw.io's line styles, the UML names and an ERD's cardinality.
 * The one list (B3 R19): the line bar's Cardinality and the Shapes tab's ER lines read it too.
 */
export const ARROW_NAMES: Record<DiagramKind, Partial<Record<FlowArrow, string>>> = {
  dfd: { ">": "One way", "<>": "Both ways", "-->": "Dashed", "-": "No arrow", "--": "Dotted" },
  flow: { ">": "One way", "<>": "Both ways", "-->": "Dashed", "-": "No arrow", "--": "Dotted" },
  cloud: { ">": "One way", "<>": "Both ways", "-": "No arrow", "--": "Dotted", "-->": "Dashed", "..>": "Dotted (assumes)" },
  er: { ">": "Many to one", "<": "One to many", "-": "One to one", "<>": "Many to many" },
  sequence: { "->": "Request", "-->": "Reply" },
  state: { ">": "One way", "-->": "Dashed", "--": "Dotted" },
  class: { "<|--": "Inheritance", "*--": "Composition", "..>": "Dependency", "-->": "Association", "--": "Link", "-": "No arrow" },
  mindmap: { ">": "One way", "-": "No arrow", "--": "Dotted" },
  timeline: {},
};

/** The order a kind's arrows are offered in: the language's own (ARROWS). */
function arrowsOf(kind: DiagramKind): FlowArrow[] {
  return ARROWS[kind].filter((a) => ARROW_NAMES[kind][a] !== undefined);
}

/** The arrow submenu's name: an ERD's is its cardinality (the line bar's word), a class line's a UML relationship, others an arrow (F8). */
function arrowMenuName(kind: DiagramKind): string {
  if (kind === "er") return "Cardinality";
  if (kind === "class") return "Relationship";
  return "Arrow";
}

/** A tool's name without its verb, as a submenu lists it ("Add step" is "Step"). */
const shapeName = (tool: AddTool) => tool.label.replace(/^Add (a |an )?/, "").replace(/^./, (c) => c.toUpperCase());

export interface ColumnMenu {
  flags: readonly ColumnFlag[];
  /** Why the table's columns cannot be edited on the card, or null. */
  blocked: string | null;
  rename(): void;
  editType(): void;
  toggle(flag: ColumnFlag): void;
  insert(where: "above" | "below"): void;
  duplicate(): void;
  /** The board's "Make a relationship from here": pick the column it refers to (B3 Task 9). */
  relate?(): void;
  showInText(): void;
  remove(): void;
}

/** An ER column (erd-ux-research 5.6, board ER interactions; B3 decision 12). */
export function columnMenuItems(c: ColumnMenu): MenuItem[] {
  const pk = c.flags.includes("pk");
  const off = c.blocked !== null;
  const why = c.blocked !== null ? { title: c.blocked } : {};
  return [
    { key: "rename", label: "Rename", icon: <Icon name="edit" />, shortcut: "F2", disabled: off, ...why, onSelect: c.rename },
    { key: "type", label: "Edit type", disabled: off, ...why, onSelect: c.editType },
    { key: "pk", label: "Primary key", shortcut: "K", checked: pk, separatorBefore: true, disabled: off, ...why, onSelect: () => c.toggle("pk") },
    { key: "unique", label: "Unique", checked: c.flags.includes("unique"), disabled: off, ...why, onSelect: () => c.toggle("unique") },
    { key: "nn", label: "Not null", shortcut: "N", checked: pk || c.flags.includes("not null"), disabled: off, ...why, onSelect: () => c.toggle("not null") },
    { key: "above", label: "Insert column above", separatorBefore: true, disabled: off, ...why, onSelect: () => c.insert("above") },
    { key: "below", label: "Insert column below", disabled: off, ...why, onSelect: () => c.insert("below") },
    { key: "dup", label: "Duplicate", icon: <Icon name="duplicate" />, shortcut: "Ctrl+Enter", disabled: off, ...why, onSelect: c.duplicate },
    ...(c.relate ? [{ key: "relate", label: "Make a relationship from here", disabled: off, ...why, onSelect: c.relate }] : []),
    { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, separatorBefore: true, onSelect: c.showInText },
    { key: "delete", label: "Delete column", icon: <Icon name="trash" />, shortcut: "Delete", danger: true, disabled: off, ...why, onSelect: c.remove },
  ];
}

export interface ShapeMenu {
  /** An ER table: its own menu (decision 12). */
  table?: boolean;
  /** Resized by hand: Fit to content gives it its own size back. */
  sized: boolean;
  /** The kind's add tools, for Add connected (none where lines are not drawn). */
  connect: AddTool[];
  /** A cloud service: Choose icon and Group (C2). */
  service: boolean;
  rename(): void;
  details(): void;
  /** An ER table's Add column: a new column row at its end. */
  addColumn?(): void;
  /** An ER table's "Add relationship to..." (B3 Task 9). */
  addRelationship?(): void;
  cut(): void;
  copy(): void;
  duplicate(): void;
  addConnected(tool: AddTool): void;
  chooseIcon(): void;
  group(): void;
  fit(): void;
  showInText(): void;
  remove(): void;
  /** Step 11: its Colour row. */
  colour?: ColourMenu;
}

/** One shape: an ER table's menu (erd-ux-research 5.6, decision 12), or any other shape's (F31). */
export function shapeMenuItems(s: ShapeMenu): MenuItem[] {
  const clip: MenuItem[] = [
    { key: "cut", label: "Cut", shortcut: "Ctrl+X", onSelect: s.cut },
    { key: "copy", label: "Copy", icon: <Icon name="copy" />, shortcut: "Ctrl+C", onSelect: s.copy },
  ];
  const tail: MenuItem[] = [
    { key: "fit", label: "Fit to content", icon: <Icon name="fit" />, disabled: !s.sized, onSelect: s.fit },
    { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, onSelect: s.showInText },
  ];
  if (s.table) {
    return [
      { key: "rename", label: "Rename", icon: <Icon name="edit" />, shortcut: "F2", onSelect: s.rename },
      ...(s.addColumn ? [{ key: "addcol", label: "Add column", icon: <Icon name="plus" />, onSelect: s.addColumn }] : []),
      ...(s.addRelationship ? [{ key: "rel", label: "Add relationship to...", onSelect: s.addRelationship }] : []),
      { key: "duplicate", label: "Duplicate table", icon: <Icon name="duplicate" />, shortcut: "Ctrl+D", onSelect: s.duplicate },
      { ...clip[0], separatorBefore: true },
      clip[1],
      { key: "details", label: "Details...", separatorBefore: true, onSelect: s.details },
      ...(s.colour ? [colourMenuItem(s.colour)] : []),
      ...tail,
      { key: "delete", label: "Delete table", icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: s.remove },
    ];
  }
  // F31's order: Duplicate, then the clipboard.
  return [
    { key: "rename", label: "Edit text", icon: <Icon name="edit" />, shortcut: "F2", onSelect: s.rename },
    { key: "details", label: "Details...", onSelect: s.details },
    ...(s.colour ? [colourMenuItem(s.colour)] : []),
    { key: "duplicate", label: "Duplicate", icon: <Icon name="duplicate" />, shortcut: "Ctrl+D", separatorBefore: true, onSelect: s.duplicate },
    clip[0],
    clip[1],
    ...(s.connect.length > 0
      ? [
          {
            key: "connected",
            label: "Add connected",
            icon: <Icon name="plus" />,
            separatorBefore: true,
            submenu: s.connect.map((t) => ({ key: `connect:${t.label}`, label: shapeName(t), icon: <Icon name={t.icon} />, onSelect: () => s.addConnected(t) })),
          },
        ]
      : []),
    ...(s.service
      ? [
          { key: "icon", label: "Choose icon...", onSelect: s.chooseIcon },
          { key: "group", label: "Group", shortcut: "Ctrl+G", onSelect: s.group },
        ]
      : []),
    { ...tail[0], separatorBefore: true },
    tail[1],
    { key: "delete", label: "Delete", icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: s.remove },
  ];
}

export interface LineMenu {
  kind: DiagramKind;
  arrow: FlowArrow;
  /** A mind map branch: it comes from an indent, so only a disabled Delete with the reason. */
  branch: string | null;
  editLabel(): void;
  setArrow(arrow: FlowArrow): void;
  reverse(): void;
  showInText(): void;
  remove(): void;
  /** Step 11: its Colour row. */
  colour?: ColourMenu;
}

/** One line (F8, CL2; an ER relationship by erd-ux-research 5.6 and R18): label, arrow, colour, reverse, show, delete. */
export function lineMenuItems(l: LineMenu): MenuItem[] {
  const remove: MenuItem = {
    key: "delete",
    label: "Delete",
    icon: <Icon name="trash" />,
    shortcut: "Delete",
    danger: true,
    separatorBefore: l.branch === null,
    disabled: l.branch !== null,
    ...(l.branch !== null ? { title: l.branch } : {}),
    onSelect: l.remove,
  };
  if (l.branch !== null) return [remove];
  const arrows = arrowsOf(l.kind);
  return [
    { key: "label", label: "Edit label", icon: <Icon name="edit" />, shortcut: "F2", onSelect: l.editLabel },
    ...(arrows.length > 1
      ? [
          {
            key: "arrow",
            label: arrowMenuName(l.kind),
            // The arrow it already has does nothing (I2).
            submenu: arrows.map((a) => ({ key: `arrow:${a}`, label: ARROW_NAMES[l.kind][a]!, hint: a, checked: a === l.arrow, onSelect: a === l.arrow ? undefined : () => l.setArrow(a) })),
          },
        ]
      : []),
    ...(l.colour ? [colourMenuItem(l.colour)] : []),
    { key: "reverse", label: l.kind === "er" ? "Swap direction" : "Reverse", onSelect: l.reverse },
    { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, onSelect: l.showInText },
    remove,
  ];
}

export interface MessageMenu {
  /** How many messages the menu acts on (the selected ones, or the one right-clicked). */
  count: number;
  /** Every one of them is a request (solid), or a reply (dashed). */
  request: boolean;
  reply: boolean;
  editLabel(): void;
  setArrow(arrow: FlowArrow): void;
  addReply(): void;
  reverse(): void;
  loop(): void;
  showInText(): void;
  remove(): void;
}

/**
 * Step 8, S4 (board DiagramSequence): a sequence message's menu. Request and Reply as Visio's Message and Return
 * Message, a reply on the next row, Reverse, a loop around the selection, Delete.
 */
export function messageMenuItems(m: MessageMenu): MenuItem[] {
  const many = m.count > 1;
  return [
    { key: "label", label: "Edit label", icon: <Icon name="edit" />, shortcut: "F2", onSelect: m.editLabel },
    { key: "request", label: "Request (solid)", checked: m.request, separatorBefore: true, onSelect: m.request ? undefined : () => m.setArrow("->") },
    { key: "reply", label: "Reply (dashed)", checked: m.reply, onSelect: m.reply ? undefined : () => m.setArrow("-->") },
    { key: "addReply", label: "Add reply below", onSelect: m.addReply },
    { key: "reverse", label: "Reverse", onSelect: m.reverse },
    { key: "loop", label: many ? `Loop around ${m.count.toLocaleString("en-US")} messages` : "Loop around this message", separatorBefore: true, onSelect: m.loop },
    { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, onSelect: m.showInText },
    { key: "delete", label: many ? `Delete ${m.count.toLocaleString("en-US")} messages` : "Delete", icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: m.remove },
  ];
}

export type AlignHow = "left" | "centre" | "right" | "top" | "middle" | "bottom";

export interface SelectionMenu {
  count: number;
  /** Shapes that can be moved (not a sequence, mind map or timeline), at least two of them. */
  shapes: number;
  movable: boolean;
  service: boolean;
  align(how: AlignHow): void;
  distribute(axis: "x" | "y"): void;
  cut(): void;
  copy(): void;
  duplicate(): void;
  tidy(): void;
  group(): void;
  remove(): void;
  /** Step 11: one Colour for every selected shape. */
  colour?: ColourMenu;
}

/** Several selected (F11, F12): Align and Distribute (draw.io's Arrange), the clipboard, Tidy selection and Delete n items. */
export function selectionMenuItems(s: SelectionMenu): MenuItem[] {
  const off = !s.movable || s.shapes < 2;
  const ALIGN: [AlignHow, string][] = [
    ["left", "Left"],
    ["centre", "Centre"],
    ["right", "Right"],
    ["top", "Top"],
    ["middle", "Middle"],
    ["bottom", "Bottom"],
  ];
  return [
    { key: "align", label: "Align", disabled: off, submenu: ALIGN.map(([how, label]) => ({ key: `align:${how}`, label, onSelect: () => s.align(how) })) },
    {
      key: "distribute",
      label: "Distribute",
      disabled: !s.movable || s.shapes < 3,
      submenu: [
        { key: "dist:x", label: "Horizontally", onSelect: () => s.distribute("x") },
        { key: "dist:y", label: "Vertically", onSelect: () => s.distribute("y") },
      ],
    },
    ...(s.colour ? [colourMenuItem(s.colour)] : []),
    { key: "cut", label: "Cut", shortcut: "Ctrl+X", separatorBefore: true, onSelect: s.cut },
    { key: "copy", label: "Copy", icon: <Icon name="copy" />, shortcut: "Ctrl+C", onSelect: s.copy },
    { key: "duplicate", label: "Duplicate", icon: <Icon name="duplicate" />, shortcut: "Ctrl+D", onSelect: s.duplicate },
    { key: "tidy", label: "Tidy selection", icon: <Icon name="tidy" />, disabled: !s.movable, onSelect: s.tidy },
    ...(s.service ? [{ key: "group", label: "Group", shortcut: "Ctrl+G", onSelect: s.group }] : []),
    { key: "delete", label: `Delete ${s.count.toLocaleString("en-US")} ${s.count === 1 ? "item" : "items"}`, icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: s.remove },
  ];
}

export interface PaneMenu {
  tools: AddTool[];
  /** An add tool's key: its kind tool's (`keyOfAddTool`). */
  keyOf?(tool: AddTool): string | undefined;
  empty: boolean;
  drawn: boolean;
  add(tool: AddTool): void;
  paste(): void;
  selectAll(): void;
  tidy(): void;
  fit(): void;
  publish(): void;
}

/** The empty canvas (F31; erd-ux-research 5.6): add at the pointer first, then the canvas's own actions. */
export function paneMenuItems(p: PaneMenu): MenuItem[] {
  const shapes = p.tools.filter((t) => t.kind !== "group");
  const adds: MenuItem[] =
    shapes.length > 0
      ? [
          {
            key: "addhere",
            label: "Add here",
            icon: <Icon name="plus" />,
            submenu: shapes.map((t) => ({ key: `add:${t.label}`, label: shapeName(t), icon: <Icon name={t.icon} />, shortcut: p.keyOf?.(t), onSelect: () => p.add(t) })),
          },
        ]
      : [];
  return [
    ...adds,
    { key: "paste", label: "Paste", shortcut: "Ctrl+V", separatorBefore: adds.length > 0, onSelect: p.paste },
    { key: "all", label: "Select all", icon: <Icon name="select" />, shortcut: "Ctrl+A", disabled: p.empty, onSelect: p.selectAll },
    { key: "tidy", label: "Tidy", icon: <Icon name="tidy" />, disabled: p.empty, onSelect: p.tidy },
    { key: "fit", label: "Zoom to fit", icon: <Icon name="fit" />, shortcut: "Shift+1", onSelect: p.fit },
    { key: "publish", label: "Publish image...", icon: <Icon name="image" />, shortcut: "Ctrl+Shift+E", separatorBefore: true, disabled: !p.drawn, onSelect: p.publish },
  ];
}

export interface GroupMenu {
  /** "3 shapes": what Delete with contents takes. */
  count: string;
  rename(): void;
  selectShapes(): void;
  ungroup(): void;
  remove(): void;
  /** Step 11: its Colour row (its border and title). */
  colour?: ColourMenu;
}

/** Step 9 (F9): a group's own menu, from a right-click on its title (target-first: draw.io, Figma). */
export function groupMenuItems(g: GroupMenu): MenuItem[] {
  return [
    { key: "rename", label: "Rename", icon: <Icon name="edit" />, shortcut: "F2", onSelect: g.rename },
    ...(g.colour ? [colourMenuItem(g.colour)] : []),
    { key: "select", label: "Select its shapes", onSelect: g.selectShapes },
    { key: "ungroup", label: "Ungroup", shortcut: "Ctrl+Shift+G", onSelect: g.ungroup },
    { key: "delete", label: "Delete with contents", icon: <Icon name="trash" />, hint: g.count, danger: true, separatorBefore: true, onSelect: g.remove },
  ];
}

export interface FrameMoreMenu {
  /** Publish can draw this frame (it has a drawing). */
  drawn: boolean;
  /** Tidy and Tidy selection apply: a kind laid out by hand, not a sequence, mind map or timeline. */
  movable: boolean;
  /** Shapes selected in this frame. */
  selected: number;
  /** The board has another frame, so this one can be deleted (Decision 22). */
  deletable: boolean;
  publish(): void;
  /** Today's Mermaid into this frame; absent where the app has no Mermaid dialog. */
  mermaid?(): void;
  tidySelection(): void;
  duplicate(): void;
  /** An ERD: its tables in the Schema Builder as an unsaved DBML model; absent elsewhere. */
  openAsDbml?(): void;
  remove(): void;
}

/** The frame bar's More menu (Decision 22): Publish, Mermaid, Tidy selection, Duplicate, Open as DBML, then Delete. */
export function frameMoreItems(m: FrameMoreMenu): MenuItem[] {
  return [
    { key: "publish", label: "Publish frame...", icon: <Icon name="image" />, shortcut: "Ctrl+Shift+E", disabled: !m.drawn, onSelect: m.publish },
    ...(m.mermaid ? [{ key: "mermaid", label: "Insert Mermaid...", icon: <Icon name="flow" />, onSelect: m.mermaid }] : []),
    {
      key: "tidy",
      label: "Tidy selection",
      icon: <Icon name="tidy" />,
      disabled: !m.movable || m.selected < 2,
      ...(m.movable && m.selected < 2 ? { title: "Select two or more shapes to tidy them" } : {}),
      separatorBefore: true,
      onSelect: m.tidySelection,
    },
    { key: "duplicate", label: "Duplicate frame", icon: <Icon name="duplicate" />, onSelect: m.duplicate },
    ...(m.openAsDbml ? [{ key: "dbml", label: "Open as DBML", icon: <Icon name="database" />, onSelect: m.openAsDbml }] : []),
    {
      key: "delete",
      label: "Delete frame",
      icon: <Icon name="trash" />,
      danger: true,
      disabled: !m.deletable,
      ...(m.deletable ? {} : { title: "A board keeps at least one diagram." }),
      separatorBefore: true,
      onSelect: m.remove,
    },
  ];
}
