import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { executeSql, planEdits } from "../api/client";
import type { ConnectionId, EditSet } from "../api/types";
import PreviewSql from "./PreviewSql";

/** Ligature characters: != >= -> ->> must reach the clipboard exactly as the Core wrote them. */
const SQL = "a != b AND c >= 1 AND j->>'k' = 'x'";

vi.mock("../api/client", () => ({
  errorText: (e: unknown) => String(e),
  planEdits: vi.fn(async () => ({ statements: [SQL] })),
  executeSql: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const TWO = ["DELETE FROM orders\n WHERE id = 141205", "UPDATE orders\n   SET status = 'refunded'\n WHERE id = 141211"];

function show(over: Partial<Parameters<typeof PreviewSql>[0]> = {}) {
  return render(
    <PreviewSql
      connectionId={"c1" as ConnectionId}
      edits={{} as EditSet}
      onClose={() => {}}
      connectionName="freight-prod"
      database="shop"
      dialect="postgres"
      {...over}
    />,
  );
}

/** The SQL as the block draws it, line by line, without gutters or tags. */
const shownSql = () => Array.from(document.querySelectorAll(".sql-block-text"), (c) => c.textContent).join("\n");

test("ligatures_never_change_the_text_preview_copy", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show();
  await waitFor(() => expect(shownSql()).toBe(`${SQL};`));
  await userEvent.click(screen.getByRole("button", { name: "Copy SQL" }));
  expect(writeText).toHaveBeenCalledWith(`${SQL};`);
  // F3: under 760 px the word goes; the tooltip keeps the name.
  expect(screen.getByRole("button", { name: "Copy SQL" }).title).toBe("Copy SQL");
});

test("header_names_connection_database_and_prod", async () => {
  vi.mocked(planEdits).mockResolvedValueOnce({ statements: TWO } as never);
  show({ production: true });
  const pane = screen.getByRole("region", { name: "Preview SQL" });
  const head = pane.querySelector(".preview-sql-head") as HTMLElement;
  expect(head.textContent).toContain("Save will run on freight-prod · shop");
  expect(head.querySelector(".db-mark")).not.toBeNull();
  expect(head.querySelector(".safety-tag-production")!.textContent).toContain("Production");
  await waitFor(() => expect(head.textContent).toContain("2 statements, all write, in one transaction"));
  expect(pane.textContent).toContain("Read-only preview. Save on PROD shows this SQL again and asks before it runs.");
  expect(screen.getByRole("button", { name: "Close SQL preview" })).toBeTruthy();
});

test("uses_the_sql_block_with_writes_tags", async () => {
  vi.mocked(planEdits).mockResolvedValueOnce({ statements: TWO } as never);
  const { unmount } = show({ production: true });
  await waitFor(() => expect(document.querySelectorAll(".sql-block-tag")).toHaveLength(2));
  expect(Array.from(document.querySelectorAll(".sql-block-tag"), (t) => t.textContent)).toEqual(["writes", "writes"]);
  // Every line of a write carries the Production band; the blank line between statements does not.
  expect(document.querySelectorAll(".sql-block-line-prod")).toHaveLength(5);
  expect(shownSql()).toBe(`${TWO[0]};\n\n${TWO[1]};`);
  unmount();

  vi.mocked(planEdits).mockResolvedValueOnce({ statements: TWO } as never);
  show({ connectionName: "shop-staging" });
  await waitFor(() => expect(document.querySelectorAll(".sql-block-tag")).toHaveLength(2));
  expect(document.querySelectorAll(".sql-block-line-prod")).toHaveLength(0);
  expect(document.querySelector(".safety-tag-production")).toBeNull();
  expect(screen.getByRole("region", { name: "Preview SQL" }).textContent).toContain("Read-only preview. Save runs exactly this.");
});

test("open_in_a_query_tab_copies_without_running", async () => {
  vi.mocked(planEdits).mockResolvedValueOnce({ statements: TWO } as never);
  const onOpenQuery = vi.fn();
  show({ onOpenQuery });
  await waitFor(() => expect(document.querySelectorAll(".sql-block-tag")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Open in a query tab" }));
  expect(onOpenQuery).toHaveBeenCalledWith(`${TWO[0]};\n\n${TWO[1]};`);
  expect(executeSql).not.toHaveBeenCalled();
});
