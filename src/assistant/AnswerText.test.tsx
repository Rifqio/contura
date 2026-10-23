import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { parseCost } from "./answerMarkdown";
import AnswerText, { TEXT_NODE_MAX, textPieces } from "./AnswerText";

const textNodes = (root: Node): Text[] => {
  const out: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text);
  return out;
};

test("a_64_kb_answer_streams_with_bounded_parsing_and_text_nodes", () => {
  // The audit's probe: one 64 KB paragraph in 657 deltas was parsed whole each time (21.6 M characters) and drawn as
  // one 65,536 character text node.
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  const answer = words.repeat(Math.ceil(65536 / words.length)).slice(0, 65536);
  const chunk = Math.ceil(65536 / 657);
  const before = parseCost.chars;
  const { container, rerender } = render(<AnswerText text="" streaming dialect="postgres" onCopy={() => {}} />);
  for (let i = chunk; i < answer.length + chunk; i += chunk) rerender(<AnswerText text={answer.slice(0, i)} streaming dialect="postgres" onCopy={() => {}} />);
  expect(parseCost.chars - before).toBeLessThan(3 * 65536);
  const nodes = textNodes(container);
  expect(Math.max(...nodes.map((n) => n.length))).toBeLessThanOrEqual(TEXT_NODE_MAX);
  expect(container.querySelectorAll("p")).toHaveLength(1);
  expect(container.textContent).toBe(answer);
  // The saved answer looks the same as the streamed one.
  const saved = render(<AnswerText text={answer} dialect="postgres" onCopy={() => {}} />);
  expect(saved.container.innerHTML).toBe(container.innerHTML);
});

test("text_pieces_cut_after_a_space_and_keep_every_character", () => {
  expect(textPieces("short")).toEqual(["short"]);
  const long = "abc ".repeat(1500);
  const pieces = textPieces(long);
  expect(pieces.join("")).toBe(long);
  expect(pieces.every((p) => p.length <= TEXT_NODE_MAX && p.endsWith(" "))).toBe(true);
  // No space at all: hard cuts.
  const solid = "x".repeat(5000);
  expect(textPieces(solid).map((p) => p.length)).toEqual([2048, 2048, 904]);
  // Growing text only changes the last piece.
  const grown = textPieces(`${long}more words here`);
  expect(grown.slice(0, pieces.length - 1)).toEqual(pieces.slice(0, -1));
});

test("headings_render_as_bold_lines_not_raw_marks", () => {
  const { container } = render(
    <AnswerText text={"Intro\n### Example – Get `orders`\n# Top\nBody"} dialect="postgres" onCopy={() => {}} />,
  );
  expect(container.textContent).not.toContain("#");
  const h = screen.getByRole("heading", { name: "Example – Get orders" });
  expect(h.tagName).toBe("P");
  expect(h.className).toBe("answer-h answer-h3");
  expect(h.getAttribute("aria-level")).toBe("6");
  expect(h.querySelector("code")?.textContent).toBe("orders");
  expect(screen.getByRole("heading", { name: "Top" }).getAttribute("aria-level")).toBe("4");
  expect(screen.getByText("Body").className).toBe("answer-p");
});

test("a_streaming_heading_renders_once_its_marks_arrive", () => {
  const { rerender } = render(<AnswerText text={"Intro\n##"} streaming dialect="postgres" onCopy={() => {}} />);
  expect(screen.queryByRole("heading")).toBeNull();
  rerender(<AnswerText text={"Intro\n## Why it is slow"} streaming dialect="postgres" onCopy={() => {}} />);
  expect(screen.getByRole("heading", { name: "Why it is slow" })).toBeTruthy();
});
