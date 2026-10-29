import { describe, expect, test } from "vitest";
import { KINDS } from "./model";
import { flowOutline } from "./outline";
import { parseFlow } from "./parse";

const FIXTURES = import.meta.glob("./fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`];

describe("flowOutline", () => {
  test("outline_of_each_kind", () => {
    const checkout = flowOutline(parseFlow(fixture("checkout.flow")), null);
    expect(checkout.kind).toBe("dfd");
    expect(checkout.kinds).toEqual([...KINDS.dfd]);
    expect(checkout.nodes.map((n) => [n.name, n.id, n.kind, n.group, n.line, n.table])).toEqual([
      ["Customer", null, "entity", null, 4, false],
      ["Checkout", "1", "process", null, 5, false],
      ["Orders", "D1", "store", null, 6, true],
      ["Card network", null, "entity", null, 7, false],
      ["Charge card", "2", "process", "Payments", 10, false],
    ]);
    expect(checkout.groups).toEqual([{ name: "Payments", group: null, line: 9 }]);
    expect(checkout.links.map((l) => [l.from, l.to, l.label, l.line])).toEqual([
      ["Customer", "Checkout", "order details", 13],
      ["Checkout", "Orders", "new order", 14],
      ["Checkout", "Charge card", "amount", 15],
      ["Orders", "Checkout", "stock level", 16],
      ["Charge card", "Card network", "authorise", 17],
    ]);

    // A flowchart: nested groups, a chain (one line, three links) and an unlabelled link.
    const order = flowOutline(parseFlow(fixture("order-flow.flow")), null);
    expect(order.kind).toBe("flow");
    expect(order.kinds).toEqual([...KINDS.flow]);
    expect(order.nodes.find((n) => n.name === "Pack order")).toEqual({ name: "Pack order", id: null, kind: "subprocess", group: "Packing", line: 11, table: false });
    expect(order.nodes.find((n) => n.name === "Ask for payment")?.table).toBe(true);
    expect(order.groups).toEqual([
      { name: "Kitchen", group: null, line: 8 },
      { name: "Packing", group: "Kitchen", line: 10 },
    ]);
    const chain = order.links.filter((l) => l.line === 21);
    expect(chain.map((l) => [l.from, l.to, l.label])).toEqual([
      ["Cook", "Pack order", null],
      ["Pack order", "Label bag", null],
    ]);

    const cloud = flowOutline(parseFlow(fixture("cloud.flow")), null);
    expect(cloud.kind).toBe("cloud");
    expect(cloud.kinds).toEqual(["service"]);
    expect(cloud.nodes.find((n) => n.name === "Orders table")).toMatchObject({ kind: "service", group: "Data", table: true });
    expect(cloud.groups.map((g) => [g.name, g.group])).toEqual([
      ["AWS", null],
      ["VPC", "AWS"],
      ["Data", "VPC"],
    ]);

    // Quoted names come back as the names, not the written text.
    const quoting = flowOutline(parseFlow(fixture("quoting.flow")), null);
    expect(quoting.nodes.map((n) => n.name)).toContain("a > b");
    expect(quoting.nodes.find((n) => n.name === "a: b")?.table).toBe(true);
    expect(quoting.groups[0].name).toBe("{group}");
  });

  test("outline_while_text_has_errors", () => {
    const good = fixture("checkout.flow");
    const last = parseFlow(good).doc;
    // One more line the diagram does not take: the doc is null, the outline still comes from the parse and the last good doc.
    const broken = `${good}Checkout ~~ Orders\nNew shape [process, id: 9]\n`;
    const parse = parseFlow(broken);
    expect(parse.doc).toBeNull();
    const o = flowOutline(parse, last);
    expect(o.kind).toBe("dfd");
    expect(o.nodes.find((n) => n.name === "Checkout")).toMatchObject({ id: "1", kind: "process", line: 5 });
    expect(o.nodes.find((n) => n.name === "Orders")?.table).toBe(true);
    // A shape the last good doc never saw has a line and no id or kind.
    expect(o.nodes.find((n) => n.name === "New shape")).toMatchObject({ id: null, kind: null, line: 19 });
    // Without a last good doc the names and lines still show.
    const bare = flowOutline(parse, null);
    expect(bare.nodes.map((n) => n.name)).toContain("Customer");
    expect(bare.nodes.every((n) => n.kind === null && n.id === null)).toBe(true);
    // A text with no first line has no kind and no shapes' kinds.
    const noHeader = flowOutline(parseFlow("A\n"), null);
    expect(noHeader.kind).toBeNull();
    expect(noHeader.kinds).toEqual([]);
  });

  test("outline_lists_er_columns", () => {
    const text = [
      'diagram er "Shop"',
      "orders {",
      "  id int pk",
      "  customer_id int not null",
      '  placed_at "timestamp with time zone"',
      "}",
      "customers {",
      "  id int PK",
      "  email text unique",
      "}",
      "audit_log [weak]",
      "",
      "orders.customer_id > customers.id: placed by",
      "",
    ].join("\n");
    const o = flowOutline(parseFlow(text), null, text);
    expect(o.nodes.map((n) => [n.name, n.columns])).toEqual([
      ["orders", ["id", "customer_id", "placed_at"]],
      ["customers", ["id", "email"]],
      ["audit_log", []],
    ]);
    // A line between columns keeps them; the ends are the tables.
    expect(o.links).toEqual([{ from: "orders", to: "customers", label: "placed by", line: 13, fromColumn: "customer_id", toColumn: "id" }]);
    // Other kinds have no columns at all.
    const dfd = fixture("checkout.flow");
    expect(flowOutline(parseFlow(dfd), null, dfd).nodes.every((n) => !("columns" in n))).toBe(true);
  });
});

test("a_node_carries_its_table_value", () => {
  // Task 4b: the diagram Ask lists each `table:` link with its value as written.
  const o = flowOutline(parseFlow('diagram flow "Checkout"\nOrders [table: shop.orders]\nShip\nOrders > Ship\n'), null);
  expect(o.nodes.find((n) => n.name === "Orders")).toMatchObject({ table: true, tableValue: "shop.orders" });
  expect(o.nodes.find((n) => n.name === "Ship")?.tableValue).toBeUndefined();
});
