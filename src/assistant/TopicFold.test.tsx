import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import appCss from "../styles/app.css?raw";
import type { Topic } from "../api/types";
import TopicFold from "./TopicFold";

/** The body of the app.css rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const text = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  const open = text.indexOf("{", at);
  return text.slice(open + 1, text.indexOf("}", open));
}

test("a_long_preview_never_hides_the_message_count", () => {
  const topic = { title: "count shipments", summary: "s", messages: 4, firstAt: 0, lastAt: 0 } as unknown as Topic;
  render(<TopicFold topic={topic} preview={"A very long answer ".repeat(40)} open={false} onToggle={() => {}} now={0} />);
  const fold = screen.getByRole("button", { name: /count shipments/ });
  // The count sits in its own span that never shrinks; only the preview is cut with an ellipsis.
  const count = fold.querySelector(".topic-sum > .topic-count")!;
  expect(count.textContent).toBe("4 messages.");
  expect(fold.querySelector(".topic-sum > .topic-preview")!.textContent).toMatch(/^A very long answer/);
  expect(ruleBody(".topic-sum")).toMatch(/display:\s*flex/);
  expect(ruleBody(".topic-count")).toMatch(/flex:\s*none/);
  const preview = ruleBody(".topic-preview");
  expect(preview).toMatch(/min-width:\s*0/);
  expect(preview).toMatch(/text-overflow:\s*ellipsis/);
  expect(preview).toMatch(/overflow:\s*hidden/);
});
