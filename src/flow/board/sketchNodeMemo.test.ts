// A sketch draws from its data and selection alone: a new place on the board (a glide, a Section dragged
// with its sketches) draws nothing again, only the node moves. A switch no longer moves the sketch
// layer, which stays at the board's (0, 0); the place a node is handed is in board units.
import type { NodeProps } from "@xyflow/react";
import { expect, test } from "vitest";
import FramePicture from "./FramePicture";
import { SketchNode } from "./SketchNode";

const props = { id: "s", type: "sketch", data: { sketch: { id: "s" } }, selected: false, dragging: false, positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 3000 } as unknown as NodeProps;
type Memo = { compare: (a: NodeProps, b: NodeProps) => boolean };

test("a_sketch_moved_on_the_board_draws_nothing_again", () => {
  const same = (SketchNode as unknown as Memo).compare;
  expect(same(props, { ...props, positionAbsoluteX: 5200, positionAbsoluteY: -40 })).toBe(true);
  expect(same(props, { ...props, selected: true })).toBe(false);
  expect(same(props, { ...props, data: { sketch: { id: "s" } } })).toBe(false);
});

test("an_icon_sketch_does_not_redraw_when_another_sketch_changes", () => {
  const same = (SketchNode as unknown as Memo).compare;
  const icon = { id: "i", kind: "icon", icon: "database" };
  const a = { ...props, data: { sketch: icon } };
  expect(same(a, { ...a, positionAbsoluteX: 5200 })).toBe(true);
  expect(same(a, { ...a })).toBe(true);
  expect(same(a, { ...a, data: { sketch: { ...icon } } })).toBe(false);
});

test("a_picture_moved_on_the_board_draws_nothing_again", () => {
  // A frame's picture draws from its data alone; a move or a switch hands it the same data.
  const same = (FramePicture as unknown as Memo).compare;
  expect(same(props, { ...props, positionAbsoluteX: 5200 })).toBe(true);
  expect(same(props, { ...props, data: {} })).toBe(false);
});
