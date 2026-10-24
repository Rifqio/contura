import { expect, test } from "vitest";
import type { ObjectPath } from "../api/types";
import { withoutGoneConnection, CLOSED_BUDGET, CLOSED_TEXT_LIMIT, CLOSED_LIMIT, closedLabel, closedTabOf, rememberClosed, reopenFrom, type ClosedTab } from "./closedTabs";
import type { AnyTab, WorkTab } from "./tabs";

const path = (name: string): ObjectPath => ({ database: "shop", schema: null, name });
const table = (name: string): WorkTab => ({
  kind: "object",
  key: `c1:table:shop..${name}`,
  selection: { connectionId: "c1", kind: "table", path: path(name) },
  preview: true,
});
const query = (id: string, text = "select 1"): WorkTab => ({
  kind: "query",
  doc: { id, name: `Query ${id}`, text, connectionId: "c1", database: "shop", savedId: null, savedText: null },
});

test("a table tab is remembered by object and comes back kept, not as a preview", () => {
  expect(closedTabOf(table("orders"))).toEqual({ kind: "object", selection: { connectionId: "c1", kind: "table", path: path("orders") } });
});

test("a query tab is remembered with its document, so its text comes back", () => {
  const c = closedTabOf(query("a", "select * from orders"));
  expect(c).toEqual({ kind: "query", doc: expect.objectContaining({ id: "a", text: "select * from orders" }) });
});

test("a diagram, a design tab, a lineage tab and the Saved Queries list are remembered; Home and Settings are not", () => {
  expect(closedTabOf({ kind: "flow", name: "checkout" })).toEqual({ kind: "flow", name: "checkout" });
  expect(closedTabOf({ kind: "design", key: "d", connectionId: "c1", target: { kind: "alter", path: path("orders") } })).toEqual({
    kind: "design",
    connectionId: "c1",
    path: path("orders"),
  });
  // A New table that was never created has no object to come back to.
  expect(closedTabOf({ kind: "design", key: "n", connectionId: "c1", target: { kind: "create", scope: { database: "shop", schema: null }, id: "x" } })).toBeNull();
  expect(closedTabOf({ kind: "lineage", key: "l", connectionId: "c1", path: path("orders") })).toEqual({ kind: "lineage", connectionId: "c1", path: path("orders") });
  expect(closedTabOf({ kind: "savedQueries" })).toEqual({ kind: "savedQueries" });
  const none: AnyTab[] = [{ kind: "home" }, { kind: "settings", section: "general" }];
  for (const t of none) expect(closedTabOf(t)).toBeNull();
});

test("the stack is bounded to 20 and drops the oldest", () => {
  let stack: ClosedTab[] = [];
  for (let i = 0; i < CLOSED_LIMIT + 5; i++) stack = rememberClosed(stack, closedTabOf(query(String(i)))!);
  expect(stack).toHaveLength(CLOSED_LIMIT);
  expect((stack[0] as { doc: { id: string } }).doc.id).toBe("5");
  expect((stack[stack.length - 1] as { doc: { id: string } }).doc.id).toBe(String(CLOSED_LIMIT + 4));
});

test("closing the same object again keeps one entry, the newest", () => {
  let stack = rememberClosed([], closedTabOf(table("orders"))!);
  stack = rememberClosed(stack, closedTabOf(query("a"))!);
  stack = rememberClosed(stack, closedTabOf(table("orders"))!);
  expect(stack.map((c) => c.kind)).toEqual(["query", "object"]);
});

test("reopening takes the last closed first, repeatedly", async () => {
  let stack: ClosedTab[] = [];
  for (const id of ["a", "b", "c"]) stack = rememberClosed(stack, closedTabOf(query(id))!);
  const first = await reopenFrom(stack, async () => null);
  expect(first.opened).toEqual(expect.objectContaining({ kind: "query", doc: expect.objectContaining({ id: "c" }) }));
  const second = await reopenFrom(first.stack, async () => null);
  expect((second.opened as { doc: { id: string } }).doc.id).toBe("b");
  expect(second.stack).toHaveLength(1);
});

test("a tab whose object is gone is skipped with a note, and the next one reopens", async () => {
  let stack = rememberClosed([], closedTabOf(query("a"))!);
  stack = rememberClosed(stack, closedTabOf(table("orders"))!);
  const r = await reopenFrom(stack, async (c) => (c.kind === "object" ? "the table orders is gone" : null));
  expect(r.opened).toEqual(expect.objectContaining({ kind: "query" }));
  expect(r.skipped).toEqual(["the table orders is gone"]);
  expect(r.stack).toEqual([]);
});

test("with nothing left to reopen it opens nothing", async () => {
  const r = await reopenFrom([], async () => null);
  expect(r).toEqual({ stack: [], opened: null, skipped: [] });
  const gone = await reopenFrom(rememberClosed([], closedTabOf(table("orders"))!), async () => "gone");
  expect(gone.opened).toBeNull();
  expect(gone.skipped).toEqual(["gone"]);
});

test("a label names each closed tab", () => {
  expect(closedLabel(closedTabOf(table("orders"))!)).toBe("orders");
  expect(closedLabel(closedTabOf(query("a"))!)).toBe("Query a");
  expect(closedLabel({ kind: "flow", name: "checkout" })).toBe("checkout.flow");
});

const big = (id: string, chars: number) => query(id, "x".repeat(chars));

test("a query over 256 KB of text is remembered with no text and flagged, never dropped", () => {
  const c = closedTabOf(big("a", CLOSED_TEXT_LIMIT + 1))!;
  expect(c).toEqual({ kind: "query", doc: expect.objectContaining({ id: "a", text: "", savedText: null }), tooLarge: true });
  const small = closedTabOf(big("b", CLOSED_TEXT_LIMIT))!;
  expect(small).toEqual({ kind: "query", doc: expect.objectContaining({ text: "x".repeat(CLOSED_TEXT_LIMIT) }) });
  expect((small as { tooLarge?: boolean }).tooLarge).toBeUndefined();
});

test("the stack holds at most 1 MB of query text, the oldest going first", () => {
  let stack: ClosedTab[] = [];
  const each = CLOSED_TEXT_LIMIT; // 256 KB
  for (let i = 0; i < 6; i++) stack = rememberClosed(stack, closedTabOf(big(String(i), each))!);
  const total = stack.reduce((n, c) => n + (c.kind === "query" ? c.doc.text.length : 0), 0);
  expect(total).toBeLessThanOrEqual(CLOSED_BUDGET);
  expect(stack).toHaveLength(Math.floor(CLOSED_BUDGET / each));
  expect((stack[stack.length - 1] as { doc: { id: string } }).doc.id).toBe("5");
  expect((stack[0] as { doc: { id: string } }).doc.id).toBe("2");
});

test("a reopened query or visual tab whose Connection is gone opens without one, text kept, with a note", () => {
  const c = closedTabOf(query("a", "select 1"))!;
  const kept = withoutGoneConnection(c, new Set(["c1"]));
  expect(kept).toEqual({ closed: c, note: null });
  const r = withoutGoneConnection(c, new Set(["c9"]));
  expect(r.closed).toEqual({ kind: "query", doc: expect.objectContaining({ id: "a", text: "select 1", connectionId: null }) });
  expect(r.note).toBe("Query a was on a Connection that is gone, so it opens without one.");
  // Other kinds are checked elsewhere.
  expect(withoutGoneConnection({ kind: "flow", name: "x" }, new Set())).toEqual({ closed: { kind: "flow", name: "x" }, note: null });
});
