import { expect, test } from "vitest";
import { parseBoard } from "./board";
import { setNumbering } from "./edits";
import { messageNumbers, numberingOn } from "./numbering";
import { parseFlow } from "./parse";

const seq = (...l: string[]) => parseFlow(['diagram sequence "N"', ...l].join("\n")).doc!;
test("restart_off_and_resume", () => {
  const d = seq("A -> B: 1", "autonumber", "A -> B", "B --> A", "autonumber 10", "A -> A: self", "loop again {", "A -> B", "autonumber off", "B --> A", "}", "A -> B", "autonumber", "A -> B");
  expect(messageNumbers(d)).toEqual([null, 1, 2, 10, 11, null, null, 12]);
});
test("nested_blocks_do_not_scope_directives", () => {
  const d = seq("autonumber", "A -> B", "alt ok {", "A -> B", "loop retry {", "autonumber 5", "B --> A", "}", "A -> B", "autonumber off", "B --> A", "}", "A -> B", "autonumber", "B --> A");
  expect(messageNumbers(d)).toEqual([1, 2, 5, 6, null, null, 7]);
});
test("numbering_is_per_board_frame", () => {
  const b = parseBoard(['diagram sequence "One"', "autonumber", "A -> B", "B --> A", "", 'diagram sequence "Two"', "A -> B", "autonumber 5", "B --> A"].join("\n"));
  expect(messageNumbers(b.frames[0].parse.doc!)).toEqual([1, 2]);
  expect(messageNumbers(b.frames[1].parse.doc!)).toEqual([null, 5]);
});
test("pressed_state", () => {
  expect(numberingOn(seq("A -> B"))).toBe(false);
  expect(numberingOn(seq("autonumber", "autonumber off", "A -> B"))).toBe(false);
  expect(numberingOn(seq("autonumber"))).toBe(true);
  expect(numberingOn(seq("autonumber off"))).toBe(false);
  expect(numberingOn(seq("A -> B", "autonumber 3", "B --> A"))).toBe(true);
});

// Decision 3: pressed when any message is numbered; with no messages, when the last directive is not `off`.
test("pressed_state_follows_the_numbered_messages", () => {
  const press = (...l: string[]) => {
    const text = ['diagram sequence "N"', ...l].join("\n") + "\n";
    const parse = parseFlow(text);
    const on = numberingOn(parse.doc!);
    const edits = [...setNumbering(text, parse, !on)].sort((a, b) => b.from - a.from);
    const after = edits.reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
    return { on, numbers: messageNumbers(parseFlow(after).doc!) };
  };
  // A numbered message before `autonumber off`: pressed, and one press removes every number.
  for (const lines of [
    ["autonumber", "A -> B: pay", "autonumber off", "B --> A: ok"],
    ["autonumber", "A -> B: pay", "B --> A: ok", "autonumber off"],
  ]) {
    const r = press(...lines);
    expect(r.on, lines.join(" / ")).toBe(true);
    expect(r.numbers.every((n) => n === null), lines.join(" / ")).toBe(true);
  }
  // `autonumber` after the last message numbers nothing: not pressed, and one press numbers every message.
  const late = press("A -> B: pay", "autonumber");
  expect(late.on).toBe(false);
  expect(late.numbers).toEqual([1]);
  // No messages: today's rule, the last directive.
  expect(numberingOn(seq("autonumber"))).toBe(true);
  expect(numberingOn(seq("autonumber", "autonumber off"))).toBe(false);
  expect(numberingOn(seq("participant A", "autonumber off", "autonumber 4"))).toBe(true);
});
