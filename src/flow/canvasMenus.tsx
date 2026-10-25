// Diagram step 4 (erd-ux-research 5.6; diagram-ux-research F31, F8, F11, F12, C2, CL2): the canvas's
// right-click menus, one per target, what is under the pointer first, each item's key on the right. FlowTab picks
// the target and runs the actions; these only say what each menu holds and in which order.
import Icon from "../components/Icon";
import type { MenuItem } from "../components/Menu";
import type { DiagramKind, FlowArrow } from "../lang/flow/model";
import { ARROWS } from "../lang/flow/model";
import type { AddTool } from "./FlowToolbar";
import { COLOUR_INFO, colourVars, PALETTE, type PaletteName } from "./palette";

/**
 * Step 11 (board DiagramColourLabels; draw.io Fill, Miro, eraser.io `color`): Colour in a shape's, a selection's, a
 * line's or a group's menu. Six swatches, each with its name, what it means and the word the file gets, then Clear
 * colour. Where a colour cannot be written the row is off and its tooltip says why.
 */
export interface ColourMenu {
  /** The colour now: a palette name, "" for none, null when the shapes picked differ. */
  current: PaletteName | "" | null;
  /** Why no colour can be written here; null when one can. */
  why: string | null;
  pick(colour: PaletteName | null): void;
}

export function colourMenuItem(c: ColourMenu): MenuItem {
  const hint = c.why ? "not here" : c.current === null ? "mixed" : c.current ? COLOUR_INFO[c.current].label : "none";
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

/** What each arrow is called in a line's menu, by kind: draw.io's line styles and the UML names. */
const ARROW_NAMES: Record<DiagramKind, Partial<Record<FlowArrow, string>>> = {
  dfd: { ">": "One way", "<>": "Both ways", "-->": "Dashed", "-": "No arrow" },
  flow: { ">": "One way", "<>": "Both ways", "-->": "Dashed", "-": "No arrow" },
  cloud: { ">": "One way", "<>": "Both ways", "-": "No arrow", "-->": "Dashed", "..>": "Dotted (assumes)" },
  sequence: { "->": "Request", "-->": "Reply" },
  state: { ">": "One way", "-->": "Dashed" },
  class: { "<|--": "Inheritance", "*--": "Composition", "..>": "Dependency", "-->": "Association", "--": "Link", "-": "No arrow" },
  mindmap: { ">": "One way", "-": "No arrow" },
  timeline: {},
};

/** The order a kind's arrows are offered in: the language's own (ARROWS). */
function arrowsOf(kind: DiagramKind): FlowArrow[] {
  return ARROWS[kind].filter((a) => ARROW_NAMES[kind][a] !== undefined);
}

/** The arrow submenu's name: a class line is a UML relationship, others an arrow (F8). */
function arrowMenuName(kind: DiagramKind): string {
  if (kind === "class") return "Relationship";
  return "Arrow";
}

/** A tool's name without its verb, as a submenu lists it ("Add step" is "Step"). */
const shapeName = (tool: AddTool) => tool.label.replace(/^Add (a |an )?/, "").replace(/^./, (c) => c.toUpperCase());

export interface ShapeMenu {
  /** Resized by hand: Fit to content gives it its own size back. */
  sized: boolean;
  /** The kind's add tools, for Add connected (none where lines are not drawn). */
  connect: AddTool[];
  /** A cloud service: Choose icon and Group (C2). */
  service: boolean;
  rename(): void;
  details(): void;
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

/** One shape's menu (F31). */
export function shapeMenuItems(s: ShapeMenu): MenuItem[] {
  const clip: MenuItem[] = [
    { key: "cut", label: "Cut", shortcut: "Ctrl+X", onSelect: s.cut },
    { key: "copy", label: "Copy", icon: <Icon name="copy" />, shortcut: "Ctrl+C", onSelect: s.copy },
  ];
  const tail: MenuItem[] = [
    { key: "fit", label: "Fit to content", icon: <Icon name="fit" />, disabled: !s.sized, onSelect: s.fit },
    { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, onSelect: s.showInText },
  ];
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
          { key: "group", label: "Group", shortcut: "G", onSelect: s.group },
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

/** One line (F8, CL2): label, arrow, colour, reverse, show, delete. */
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
    { key: "reverse", label: "Reverse", onSelect: l.reverse },
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

/** Several selected (F11, F12): Align and Distribute (draw.io's Arrange), the clipboard, Tidy and Delete n items. */
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
    { key: "tidy", label: "Tidy", icon: <Icon name="tidy" />, disabled: !s.movable, onSelect: s.tidy },
    ...(s.service ? [{ key: "group", label: "Group", shortcut: "G", onSelect: s.group }] : []),
    { key: "delete", label: `Delete ${s.count.toLocaleString("en-US")} ${s.count === 1 ? "item" : "items"}`, icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: s.remove },
  ];
}

export interface PaneMenu {
  tools: AddTool[];
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
            submenu: shapes.map((t) => ({ key: `add:${t.label}`, label: shapeName(t), icon: <Icon name={t.icon} />, shortcut: t.key, onSelect: () => p.add(t) })),
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
