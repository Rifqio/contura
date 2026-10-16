import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { nextQueryName, parseDrafts, placeKey, serializeDrafts } from "../query/drafts";
import type { QueryTabDoc } from "../query/QueryTab";
import TabStrip, { type WorkTab } from "./TabStrip";

const q = (id: string, name: string, over: Partial<QueryTabDoc> = {}): WorkTab => ({
  kind: "query",
  doc: { id, name, text: "", connectionId: "c1", database: null, savedId: null, savedText: null, ...over },
});
const table: WorkTab = {
  kind: "object",
  key: "c1:table:shop..stores",
  selection: { connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "stores" } },
};

test("tabs_hold_tables_and_queries_and_close_with_their_x", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onNew = vi.fn();
  render(
    <TabStrip
      tabs={[table, q("a", "Query 1"), q("b", "Weekly sales", { savedId: "s", savedText: "SELECT 1", text: "SELECT 2" })]}
      active={1}
      onSelect={onSelect}
      onClose={onClose}
      onNew={onNew}
    />,
  );
  expect(screen.getByRole("tab", { name: "stores" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Weekly sales, unsaved changes/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "stores" }));
  expect(onSelect).toHaveBeenCalledWith(0);
  await userEvent.click(screen.getByRole("button", { name: "Close Query 1" }));
  expect(onClose).toHaveBeenCalledWith(1);
  await userEvent.click(screen.getByRole("button", { name: "New query" }));
  expect(onNew).toHaveBeenCalled();
});

test("new_query_names_count_up", () => {
  expect(nextQueryName([])).toBe("Query 1");
  expect(nextQueryName(["Query 1", "Weekly sales", "Query 3"])).toBe("Query 4");
});

test("parse_drafts_never_throws", () => {
  const docs = [
    { id: "a", name: "Query 1", text: "SELECT 1", connectionId: "c1", database: "shop", savedId: null, savedText: null },
  ];
  expect(parseDrafts(serializeDrafts(docs))).toEqual(docs);
  expect(parseDrafts("not json")).toEqual([]);
  expect(parseDrafts('{"version":9}')).toEqual([]);
  expect(parseDrafts('[{"id":1}]')).toEqual([]);
  expect(placeKey({ kind: "group", groupId: "g1" })).toBe("group:g1");
  expect(placeKey({ kind: "ungrouped" })).toBe("ungrouped");
});
