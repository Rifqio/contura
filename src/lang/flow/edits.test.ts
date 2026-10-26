import { describe, expect, test } from "vitest";
import type { TextEdit } from "../protocol";
import {
  addGroup,
  addLink,
  addNode,
  applyFlowEdit,
  deleteLink,
  deleteNode,
  moveToGroup,
  renameNode,
  setAttr,
  setLinkLabel,
  uniqueName,
} from "./edits";
import { parseFlow } from "./parse";
import { applyFlowBatch, applyFlowSteps } from "./service";

const FIXTURES = import.meta.glob("./fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`];

/** Applies edits as CodeMirror does: offsets into the original text, never overlapping. */
function apply(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBeGreaterThanOrEqual(sorted[i - 1].to);
  return [...sorted].reverse().reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

/** The doc of text that must parse clean. */
function doc(text: string) {
  const r = parseFlow(text);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  if (!r.doc) throw new Error("no doc");
  return r.doc;
}

function lastLink(text: string) {
  const links = doc(text).links;
  return links[links.length - 1];
}

/** Runs one edit function on `text` and returns the new text. */
function run(text: string, edit: (text: string, parse: ReturnType<typeof parseFlow>) => TextEdit[]): string {
  return apply(text, edit(text, parseFlow(text)));
}

/** Every line of `before` that is not in `changed` is still in `after`, byte for byte and in order. */
function untouched(before: string, after: string, changed: string[]) {
  const kept = before.split("\n").filter((l) => !changed.includes(l));
  const out = after.split("\n");
  let j = 0;
  for (const l of kept) {
    while (j < out.length && out[j] !== l) j++;
    expect(j, `line ${JSON.stringify(l)} kept`).toBeLessThan(out.length);
    j++;
  }
}

const CHECKOUT = fixture("checkout.flow");

describe("addNode", () => {
  test("adds a line after the last loose node, with the kind and attributes", () => {
    const after = run(CHECKOUT, (t, p) => addNode(t, p, "Refunds", "store", { id: "D2" }));
    expect(after).toContain("Card network [entity] // the bank side\nRefunds [store, id: D2]\n");
    expect(doc(after).nodes.find((n) => n.name === "Refunds")).toEqual({ name: "Refunds", kind: "store", attrs: { id: "D2" } });
    untouched(CHECKOUT, after, []);
  });

  test("adds into a group before its closing brace, indented one level in", () => {
    const after = run(CHECKOUT, (t, p) => addNode(t, p, "Refund card", "process", { id: "3" }, "Payments"));
    expect(after).toContain("  Charge card [process, id: 2]\n  Refund card [process, id: 3]\n}\n");
    expect(doc(after).groups[0].nodes).toEqual(["Charge card", "Refund card"]);
  });

  test("adds into a nested group with its depth", () => {
    const text = fixture("cloud.flow");
    const after = run(text, (t, p) => addNode(t, p, "Cache", null, { icon: "aws-elasticache" }, "Data"));
    expect(after).toContain("      Orders table [icon: aws-dynamodb, table: shop.orders]\n      Cache [icon: aws-elasticache]\n    }\n");
    expect(doc(after).groups[0].groups[0].groups[0].nodes).toEqual(["Orders table", "Cache"]);
  });

  test("a cloud service and a flowchart step leave the kind unsaid", () => {
    const cloud = run('diagram cloud "A"\n', (t, p) => addNode(t, p, "Queue", "service", {}));
    expect(cloud).toBe('diagram cloud "A"\nQueue\n');
    const flow = run('diagram flow "A"', (t, p) => addNode(t, p, "Step 1", null, {}));
    expect(flow).toBe('diagram flow "A"\nStep 1');
  });

  test("quotes a name and a value that need it", () => {
    const after = run('diagram flow "A"\n', (t, p) => addNode(t, p, "a: b", "io", { table: "x, y" }));
    expect(after).toBe('diagram flow "A"\n"a: b" [io, table: "x, y"]\n');
    expect(doc(after).nodes[0]).toEqual({ name: "a: b", kind: "io", attrs: { table: "x, y" } });
  });

  test("refuses a name that is taken", () => {
    const p = parseFlow(CHECKOUT);
    expect(addNode(CHECKOUT, p, "Orders", "store", {})).toEqual([]);
    expect(addNode(CHECKOUT, p, "Payments", "store", {})).toEqual([]);
  });

  test("keeps CRLF line ends", () => {
    const text = 'diagram dfd "A"\r\nCustomer [entity]\r\n';
    expect(run(text, (t, p) => addNode(t, p, "Shop", "process", {}))).toBe('diagram dfd "A"\r\nCustomer [entity]\r\nShop [process]\r\n');
  });

  test("works while the text has an error", () => {
    const text = lines('diagram dfd "A"', "Customer [entity]", "Customer > Nowhere", "Broken [proces]");
    expect(parseFlow(text).doc).toBeNull();
    const after = run(text, (t, p) => addNode(t, p, "Shop", "process", { id: "1" }));
    expect(after).toBe(lines('diagram dfd "A"', "Customer [entity]", "Customer > Nowhere", "Broken [proces]", "Shop [process, id: 1]"));
  });
});

describe("addLink", () => {
  test("adds a line after the last link", () => {
    const after = run(CHECKOUT, (t, p) => addLink(t, p, "Orders", "Customer", ">", "receipt"));
    expect(after.endsWith("Charge card <> Card network: authorise\nOrders > Customer: receipt\n")).toBe(true);
    expect(lastLink(after)).toEqual({ from: "Orders", to: "Customer", arrow: ">", label: "receipt" });
    untouched(CHECKOUT, after, []);
  });

  test("the first link goes after a blank line at the end, names and labels quoted", () => {
    const text2 = lines('diagram flow "A"', '"a: b"', "C");
    const after = run(text2, (t, p) => addLink(t, p, "a: b", "C", "-->", "says // this"));
    expect(after).toBe(lines('diagram flow "A"', '"a: b"', "C", "", '"a: b" --> C: "says // this"'));
    expect(doc(after).links).toEqual([{ from: "a: b", to: "C", arrow: "-->", label: "says // this" }]);
  });

  test("no label, and every arrow", () => {
    for (const arrow of [">", "<>", "-", "-->"] as const) {
      const after = run(CHECKOUT, (t, p) => addLink(t, p, "Customer", "Orders", arrow));
      expect(lastLink(after)).toEqual({ from: "Customer", to: "Orders", arrow });
    }
  });

  test("works while the text has an error", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "B [process]", "A > B", "C [nope]");
    const after = run(text, (t, p) => addLink(t, p, "B", "A", ">", "back"));
    expect(after).toBe(lines('diagram dfd "A"', "A [entity]", "B [process]", "A > B", "B > A: back", "C [nope]"));
  });
});

describe("renameNode", () => {
  test("renames the definition and every use, chains included", () => {
    const text = fixture("cloud.flow");
    const after = run(text, (t, p) => renameNode(t, p, "Orders API", "Orders service"));
    const d = doc(after);
    expect(d.nodes.map((n) => n.name)).toContain("Orders service");
    expect(d.nodes.map((n) => n.name)).not.toContain("Orders API");
    expect(d.links.filter((l) => l.from === "Orders service" || l.to === "Orders service")).toHaveLength(4);
    expect(after).toContain("Users > Gateway > Orders service: HTTPS");
    untouched(text, after, text.split("\n").filter((l) => l.includes("Orders API")));
  });

  test("a note's new text with a comma is written as the note's text, unquoted", () => {
    const text = lines('diagram flow "x"', "A", "note: ask legal", "B [step]");
    const after = run(text, (t, p) => renameNode(t, p, "Note 1", "ask legal, then sign"));
    expect(after).toBe(lines('diagram flow "x"', "A", "note: ask legal, then sign", "B [step]"));
  });

  test("a node whose name starts with note is no note: a comma in its new name is quoted", () => {
    const text = lines('diagram flow "x"', "notebook [step]");
    expect(run(text, (t, p) => renameNode(t, p, "notebook", "notes, kept"))).toBe(lines('diagram flow "x"', '"notes, kept" [step]'));
  });

  test("renaming to a name with a colon quotes it", () => {
    const after = run(CHECKOUT, (t, p) => renameNode(t, p, "Orders", "Orders: live"));
    expect(after).toContain('"Orders: live" [store, id: D1, table: shop.orders]');
    expect(after).toContain('Checkout > "Orders: live": new order');
    const d = doc(after);
    expect(d.links.filter((l) => l.from === "Orders: live" || l.to === "Orders: live")).toHaveLength(2);
  });

  test("renames a group and the links to it", () => {
    const text = lines('diagram flow "A"', "Kitchen {", "  Cook", "}", "Order > Kitchen", "Order");
    const after = run(text, (t, p) => renameNode(t, p, "Kitchen", "Back room"));
    expect(after).toBe(lines('diagram flow "A"', "Back room {", "  Cook", "}", "Order > Back room", "Order"));
  });

  test("a quoted name loses its quotes when the new one needs none", () => {
    const text = lines('diagram flow "A"', '"a > b"', 'X > "a > b"');
    expect(run(text, (t, p) => renameNode(t, p, "a > b", "Plain"))).toBe(lines('diagram flow "A"', "Plain", "X > Plain"));
  });

  test("refuses a name that is taken, and does nothing for the same name", () => {
    const p = parseFlow(CHECKOUT);
    expect(renameNode(CHECKOUT, p, "Orders", "Customer")).toEqual([]);
    expect(renameNode(CHECKOUT, p, "Orders", "Orders")).toEqual([]);
  });

  test("works while the text has an error", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "B [process]", "A > B: x", "B > Missing");
    expect(parseFlow(text).doc).toBeNull();
    expect(run(text, (t, p) => renameNode(t, p, "B", "Shop"))).toBe(lines('diagram dfd "A"', "A [entity]", "Shop [process]", "A > Shop: x", "Shop > Missing"));
  });
});

describe("deleteNode", () => {
  test("deletes the node and its links and keeps the comments", () => {
    const after = run(CHECKOUT, (t, p) => deleteNode(t, p, "Card network"));
    // The comment on the deleted line stays, on a line of its own.
    expect(after).toContain("Orders [store, id: D1, table: shop.orders]\n// the bank side\n\nPayments");
    expect(after).toContain("// Gane-Sarson, as the direction spec draws it");
    const d = doc(after);
    expect(d.nodes.map((n) => n.name)).not.toContain("Card network");
    expect(d.links).toHaveLength(4);
    untouched(CHECKOUT, after, ["Card network [entity] // the bank side", "Charge card <> Card network: authorise"]);
  });

  test("a node in a group keeps the group while others remain", () => {
    const text = lines('diagram dfd "A"', "Pay {", "  Charge [process]", "  Refund [process]", "}", "Charge > Refund");
    const after = run(text, (t, p) => deleteNode(t, p, "Charge"));
    expect(after).toBe(lines('diagram dfd "A"', "Pay {", "  Refund [process]", "}"));
  });

  // diag-910 fix round 2 (N7, board DiagramGroups): a group whose last shape goes keeps its braces and stays drawn.
  test("the last node in a group leaves the group's braces", () => {
    const after = run(CHECKOUT, (t, p) => deleteNode(t, p, "Charge card"));
    expect(after).toContain("Payments");
    const d = doc(after);
    expect(d.groups.map((g) => [g.name, g.nodes])).toEqual([["Payments", []]]);
    expect(d.links.map((l) => `${l.from}>${l.to}`)).toEqual(["Customer>Checkout", "Checkout>Orders", "Orders>Checkout"]);
  });

  test("nested braces, a comment and a line to the group all stay", () => {
    const text = lines('diagram flow "A"', "Outer {", "  Inner {", "    Only", "  }", "}", "Other");
    expect(run(text, (t, p) => deleteNode(t, p, "Only"))).toBe(lines('diagram flow "A"', "Outer {", "  Inner {", "  }", "}", "Other"));
    const commented = lines('diagram flow "A"', "G {", "  // keep me", "  Only", "}");
    expect(run(commented, (t, p) => deleteNode(t, p, "Only"))).toBe(lines('diagram flow "A"', "G {", "  // keep me", "}"));
    const linked = lines('diagram flow "A"', "G {", "  Only", "}", "Other > G");
    expect(run(linked, (t, p) => deleteNode(t, p, "Only"))).toBe(lines('diagram flow "A"', "G {", "}", "Other > G"));
  });

  test("a chain keeps the links that do not touch the node", () => {
    const text = lines('diagram flow "A"', "A", "B", "X", "C", "D", "A > B > X > C > D: last", "X > A", "B > X: mid");
    const after = run(text, (t, p) => deleteNode(t, p, "X"));
    expect(after).toBe(lines('diagram flow "A"', "A", "B", "C", "D", "A > B", "C > D: last"));
    const front = lines('diagram flow "A"', "A", "B", "X", "X > A > B: end");
    expect(run(front, (t, p) => deleteNode(t, p, "X"))).toBe(lines('diagram flow "A"', "A", "B", "A > B: end"));
  });

  test("a link line with a comment keeps the comment", () => {
    const fine = lines('diagram flow "A"', "A", "B", "  A > B // why");
    expect(run(fine, (t, p) => deleteNode(t, p, "B"))).toBe(lines('diagram flow "A"', "A", "  // why"));
  });

  test("the last line with no line break", () => {
    expect(run('diagram flow "A"\nA\nB', (t, p) => deleteNode(t, p, "B"))).toBe('diagram flow "A"\nA');
  });

  test("works while the text has an error", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "B [process]", "A > B", "B > Missing", "C [nope]");
    expect(run(text, (t, p) => deleteNode(t, p, "B"))).toBe(lines('diagram dfd "A"', "A [entity]", "C [nope]"));
  });

  test("an unknown name changes nothing", () => {
    expect(deleteNode(CHECKOUT, parseFlow(CHECKOUT), "Nobody")).toEqual([]);
  });
});

describe("moveToGroup", () => {
  test("moves a loose node into a group", () => {
    const after = run(CHECKOUT, (t, p) => moveToGroup(t, p, "Orders", "Payments"));
    expect(after).toContain("  Charge card [process, id: 2]\n  Orders [store, id: D1, table: shop.orders]\n}");
    const d = doc(after);
    expect(d.groups[0].nodes).toEqual(["Charge card", "Orders"]);
    expect(d.links).toEqual(parseFlow(CHECKOUT).doc?.links);
    untouched(CHECKOUT, after, ["Orders [store, id: D1, table: shop.orders]"]);
  });

  // diag-910 fix round 1 (I5, board DiagramGroups): the group a node leaves keeps its braces and stays drawn.
  test("moving the last node out keeps the group's braces; its comment goes with it", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "", "Pay {", "  Charge [process] // note", "}", "", "A > Charge");
    const after = run(text, (t, p) => moveToGroup(t, p, "Charge", null));
    expect(after).toBe(lines('diagram dfd "A"', "A [entity]", "Charge [process] // note", "", "Pay {", "}", "", "A > Charge"));
    expect(doc(after).groups).toEqual([{ name: "Pay", nodes: [], groups: [] }]);
  });

  test("moves between nested groups", () => {
    const text = fixture("cloud.flow");
    const after = run(text, (t, p) => moveToGroup(t, p, "Receipts", "Data"));
    const d = doc(after);
    expect(d.groups[0].nodes).toEqual(["Gateway"]);
    expect(d.groups[0].groups[0].groups[0].nodes).toEqual(["Orders table", "Receipts"]);
  });

  test("the same group or an unknown one changes nothing", () => {
    const p = parseFlow(CHECKOUT);
    expect(moveToGroup(CHECKOUT, p, "Charge card", "Payments")).toEqual([]);
    expect(moveToGroup(CHECKOUT, p, "Orders", null)).toEqual([]);
    expect(moveToGroup(CHECKOUT, p, "Orders", "Nowhere")).toEqual([]);
  });

  test("a node with no loose node to follow goes after the first line", () => {
    const text = lines('diagram flow "A"', "G {", "  N", "  M", "}");
    expect(run(text, (t, p) => moveToGroup(t, p, "M", null))).toBe(lines('diagram flow "A"', "M", "G {", "  N", "}"));
  });
});

describe("setAttr", () => {
  test("changes, adds and removes attributes, keeping the rest of the line", () => {
    let t = CHECKOUT;
    t = run(t, (x, p) => setAttr(x, p, "Orders", "id", "D9"));
    expect(t).toContain("Orders [store, id: D9, table: shop.orders]");
    // A new key goes in its place in the order id, icon, label, color, table (step 11).
    t = run(t, (x, p) => setAttr(x, p, "Orders", "color", "warning"));
    expect(t).toContain("Orders [store, id: D9, color: warning, table: shop.orders]");
    t = run(t, (x, p) => setAttr(x, p, "Orders", "id", null));
    expect(t).toContain("Orders [store, color: warning, table: shop.orders]");
    t = run(t, (x, p) => setAttr(x, p, "Orders", "color", null));
    expect(t).toContain("Orders [store, table: shop.orders]\n");
    t = run(t, (x, p) => setAttr(x, p, "Card network", "id", "E1"));
    expect(t).toContain("Card network [entity, id: E1] // the bank side");
    expect(doc(t).nodes.find((n) => n.name === "Orders")?.attrs).toEqual({ table: "shop.orders" });
    untouched(CHECKOUT, t, ["Orders [store, id: D1, table: shop.orders]", "Card network [entity] // the bank side"]);
  });

  test("a node with no brackets gets them, and loses them with its last attribute", () => {
    const text = lines('diagram flow "A"', "Cook", "Cook > Cook");
    const added = run(text, (t, p) => setAttr(t, p, "Cook", "table", "shop.x, y"));
    expect(added).toBe(lines('diagram flow "A"', 'Cook [table: "shop.x, y"]', "Cook > Cook"));
    expect(doc(added).nodes[0].attrs).toEqual({ table: "shop.x, y" });
    expect(run(added, (t, p) => setAttr(t, p, "Cook", "table", null))).toBe(text);
  });

  test("the kind is set, changed and removed", () => {
    const text = lines('diagram flow "A"', "Cook", "Pay [io]", "Ask [decision, id: 3]");
    let t = run(text, (x, p) => setAttr(x, p, "Cook", "kind", "subprocess"));
    t = run(t, (x, p) => setAttr(x, p, "Pay", "kind", "end"));
    t = run(t, (x, p) => setAttr(x, p, "Ask", "kind", null));
    expect(t).toBe(lines('diagram flow "A"', "Cook [subprocess]", "Pay [end]", "Ask [id: 3]"));
    expect(run(lines('diagram flow "A"', "Ask [id: 3]"), (x, p) => setAttr(x, p, "Ask", "kind", "io"))).toBe(lines('diagram flow "A"', "Ask [io, id: 3]"));
  });

  test("a group's icon", () => {
    const after = run(CHECKOUT, (t, p) => setAttr(t, p, "Payments", "icon", "credit-card"));
    expect(after).toContain("Payments [icon: credit-card] {");
    const bare = lines('diagram cloud "A"', "VPC {", "  S", "}");
    expect(run(bare, (t, p) => setAttr(t, p, "VPC", "icon", "aws-vpc"))).toBe(lines('diagram cloud "A"', "VPC [icon: aws-vpc] {", "  S", "}"));
  });

  test("works while the text has an error", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "A > Missing");
    expect(run(text, (t, p) => setAttr(t, p, "A", "id", "E1"))).toBe(lines('diagram dfd "A"', "A [entity, id: E1]", "A > Missing"));
  });
});

describe("setLinkLabel", () => {
  test("changes, adds and removes a label", () => {
    let t = CHECKOUT;
    t = run(t, (x, p) => setLinkLabel(x, p, 0, "basket"));
    expect(t).toContain("Customer > Checkout: basket\n");
    t = run(t, (x, p) => setLinkLabel(x, p, 1, null));
    expect(t).toContain("Checkout > Orders\n");
    t = run(t, (x, p) => setLinkLabel(x, p, 1, "a // b"));
    expect(t).toContain('Checkout > Orders: "a // b"\n');
    expect(doc(t).links[1]).toEqual({ from: "Checkout", to: "Orders", arrow: ">", label: "a // b" });
  });

  test("a label on a chained link splits the chain", () => {
    const text = lines('diagram flow "A"', "A", "B", "C", "  A > B > C: end");
    const after = run(text, (t, p) => setLinkLabel(t, p, 0, "first"));
    expect(after).toBe(lines('diagram flow "A"', "A", "B", "C", "  A > B: first", "  B > C: end"));
    expect(doc(after).links).toEqual([
      { from: "A", to: "B", arrow: ">", label: "first" },
      { from: "B", to: "C", arrow: ">", label: "end" },
    ]);
  });

  test("an unknown link changes nothing", () => {
    expect(setLinkLabel(CHECKOUT, parseFlow(CHECKOUT), 99, "x")).toEqual([]);
  });
});

describe("uniqueName", () => {
  test("gives Process 3 style names", () => {
    const text = lines('diagram dfd "A"', "Process [process]", "Process 2 [process]", "Store [store]");
    const p = parseFlow(text);
    expect(uniqueName(p, "Process")).toBe("Process 3");
    expect(uniqueName(p, "Store")).toBe("Store 2");
    expect(uniqueName(p, "Entity")).toBe("Entity");
  });
});

describe("applyFlowEdit", () => {
  test("runs each operation by name, and an add can make the name unique", () => {
    const text = lines('diagram dfd "A"', "Process [process]");
    const r = applyFlowEdit(text, parseFlow(text), { op: "addNode", name: "Process", kind: "process", unique: true });
    expect(r.name).toBe("Process 2");
    expect(apply(text, r.edits)).toBe(lines('diagram dfd "A"', "Process [process]", "Process 2 [process]"));
    const link = applyFlowEdit(text, parseFlow(text), { op: "addLink", from: "Process", to: "Process", arrow: ">" });
    expect(apply(text, link.edits)).toBe(lines('diagram dfd "A"', "Process [process]", "", "Process > Process"));
  });

  test("names like __proto__ are plain names", () => {
    const text = lines('diagram flow "A"', "__proto__", "constructor", "__proto__ > constructor");
    const p = parseFlow(text);
    expect(uniqueName(p, "__proto__")).toBe("__proto__ 2");
    expect(apply(text, renameNode(text, p, "__proto__", "toString"))).toBe(lines('diagram flow "A"', "toString", "constructor", "toString > constructor"));
    expect(apply(text, deleteNode(text, p, "constructor"))).toBe(lines('diagram flow "A"', "__proto__"));
  });
});

describe("every edit on every fixture reparses", () => {
  for (const name of ["checkout.flow", "cloud.flow", "order-flow.flow", "quoting.flow"]) {
    test(name, () => {
      const text = fixture(name);
      const d = doc(text);
      for (const n of d.nodes) {
        const renamed = run(text, (t, p) => renameNode(t, p, n.name, `${n.name} x: y`));
        expect(doc(renamed).nodes.map((m) => m.name)).toContain(`${n.name} x: y`);
        expect(doc(renamed).links.length).toBe(d.links.length);
        const deleted = run(text, (t, p) => deleteNode(t, p, n.name));
        const dd = doc(deleted);
        expect(dd.nodes.map((m) => m.name)).not.toContain(n.name);
        expect(dd.links.some((l) => l.from === n.name || l.to === n.name)).toBe(false);
        const moved = run(text, (t, p) => moveToGroup(t, p, n.name, null));
        expect(doc(moved).nodes.length).toBe(d.nodes.length);
      }
      d.links.forEach((_, i) => {
        const labelled = run(text, (t, p) => setLinkLabel(t, p, i, "new: label"));
        expect(doc(labelled).links.find((l, j) => j >= i && l.label === "new: label")).toBeTruthy();
      });
    });
  }
});

describe("fix round 1", () => {
  test("moving a node into an ancestor group keeps the ancestor (I1)", () => {
    const text = lines('diagram cloud "A"', "G {", "  H {", "    b", "  }", "}");
    const after = run(text, (t, p) => moveToGroup(t, p, "b", "G"));
    // The group it leaves stays (diag-910 fix round 1, I5).
    expect(after).toBe(lines('diagram cloud "A"', "G {", "  H {", "  }", "  b", "}"));
    expect(doc(after).groups).toEqual([{ name: "G", nodes: ["b"], groups: [{ name: "H", nodes: [], groups: [] }] }]);
    const deep = lines('diagram cloud "A"', "G {", "  H {", "    K {", "      b", "    }", "  }", "}");
    const top = run(deep, (t, p) => moveToGroup(t, p, "b", "G"));
    expect(top).toBe(lines('diagram cloud "A"', "G {", "  H {", "    K {", "    }", "  }", "  b", "}"));
    const mid = run(deep, (t, p) => moveToGroup(t, p, "b", "H"));
    expect(mid).toBe(lines('diagram cloud "A"', "G {", "  H {", "    K {", "    }", "    b", "  }", "}"));
  });

  test("setAttr takes only the grammar's keys", () => {
    const p = parseFlow(CHECKOUT);
    expect(setAttr(CHECKOUT, p, "Orders", "bogus" as never, "x")).toEqual([]);
    expect(setAttr(CHECKOUT, p, "Orders", "__proto__" as never, "x")).toEqual([]);
    expect(setAttr(CHECKOUT, p, "Orders", "table", null)).not.toEqual([]);
  });

  test("delete and rename do not apply to a name defined twice", () => {
    const text = lines('diagram dfd "A"', "A [entity]", "B [process]", "A [store]", "A > B");
    const p = parseFlow(text);
    expect(deleteNode(text, p, "A")).toEqual([]);
    expect(renameNode(text, p, "A", "Z")).toEqual([]);
    expect(deleteNode(text, p, "B")).not.toEqual([]);
  });

  test("a new link never lands inside a group unless both ends are in it", () => {
    const text = lines('diagram flow "A"', "X", "Y", "G {", "  P", "  Q", "  P > Q", "}");
    expect(run(text, (t, p) => addLink(t, p, "X", "Y", ">"))).toBe(`${text}\nX > Y\n`);
    expect(run(text, (t, p) => addLink(t, p, "Q", "P", ">"))).toBe(lines('diagram flow "A"', "X", "Y", "G {", "  P", "  Q", "  P > Q", "  Q > P", "}"));
    const both = lines('diagram flow "A"', "X", "Y", "G {", "  P", "  P > X", "}", "X > Y");
    expect(run(both, (t, p) => addLink(t, p, "Y", "P", ">"))).toBe(`${both}Y > P\n`);
    expect(run(both, (t, p) => addLink(t, p, "Y", "X", "-"))).toBe(`${both}Y - X\n`);
  });
});

describe("addGroup", () => {
  const CLOUD = lines('diagram cloud "Order API"', "Users [icon: users]", "Gateway [icon: aws-api-gateway]", "Lambda [icon: aws-lambda]", "", "Users > Gateway", "Gateway > Lambda");

  test("an empty group goes after the loose nodes, and a taken name is refused", () => {
    expect(run(CLOUD, (t, p) => addGroup(t, p, "Production"))).toBe(
      lines('diagram cloud "Order API"', "Users [icon: users]", "Gateway [icon: aws-api-gateway]", "Lambda [icon: aws-lambda]", "Production {", "}", "", "Users > Gateway", "Gateway > Lambda"),
    );
    expect(addGroup(CLOUD, parseFlow(CLOUD), "Users")).toEqual([]);
    expect(applyFlowEdit(CLOUD, parseFlow(CLOUD), { op: "addGroup", name: "Users", unique: true }).name).toBe("Users 2");
  });

  test("a group inside a group is indented one level in", () => {
    const text = lines('diagram cloud "A"', "VPC {", "  Gateway", "}");
    expect(run(text, (t, p) => addGroup(t, p, "Functions", "VPC"))).toBe(lines('diagram cloud "A"', "VPC {", "  Gateway", "  Functions {", "  }", "}"));
  });

  test("grouping the selection is one batch: the new group, then each node moved in", () => {
    const p = parseFlow(CLOUD);
    const r = applyFlowBatch(CLOUD, p, [
      { op: "addGroup", name: "Production", group: null },
      { op: "moveToGroup", name: "Gateway", group: "Production" },
      { op: "moveToGroup", name: "Lambda", group: "Production" },
    ]);
    const out = apply(CLOUD, r.edits);
    expect(out).toBe(
      lines('diagram cloud "Order API"', "Users [icon: users]", "Production {", "  Gateway [icon: aws-api-gateway]", "  Lambda [icon: aws-lambda]", "}", "", "Users > Gateway", "Gateway > Lambda"),
    );
    expect(doc(out).groups).toEqual([{ name: "Production", nodes: ["Gateway", "Lambda"], groups: [] }]);
  });

  test("the batch answer carries the edits and no text", () => {
    const r = applyFlowBatch(CLOUD, parseFlow(CLOUD), [{ op: "addGroup", name: "Production", group: null }]);
    expect(r.edits.length).toBe(1);
    expect(Object.keys(r)).toEqual(["edits"]);
  });

  test("a refused batch says why, with the refusing op's note", () => {
    const text = lines('diagram flow "x"', "A", "B", "A > B");
    const ref = { from: "A", to: "B", label: null, nth: 0 };
    const r = applyFlowBatch(text, parseFlow(text), [
      { op: "addNode", name: "C", kind: null, attrs: {}, group: null },
      { op: "setLinkEnd", link: ref, end: "to", node: "Nowhere" },
    ]);
    expect(r).toEqual({ edits: [], note: "Nowhere is not in the text." });
    // The step runner says why too.
    expect(applyFlowSteps(text, parseFlow(text), 1, () => ({ op: "setLinkEnd", link: ref, end: "to", node: "Nowhere" }))).toEqual({ edits: [], note: "Nowhere is not in the text." });
  });

  test("CRLF stays CRLF", () => {
    const crlf = CLOUD.replace(/\n/g, "\r\n");
    expect(run(crlf, (t, p) => addGroup(t, p, "Production"))).toContain("Lambda [icon: aws-lambda]\r\nProduction {\r\n}\r\n");
  });
});
describe("deleteLink", () => {
  test("delete_link_line_and_chain", () => {
    // A line of its own goes whole, the rest stay byte for byte.
    const i = parseFlow(CHECKOUT).links.findIndex((l) => l.from === "Orders" && l.to === "Checkout");
    const after = run(CHECKOUT, (t, p) => deleteLink(t, p, i));
    expect(after).not.toContain("Orders --> Checkout");
    untouched(CHECKOUT, after, ["Orders --> Checkout: stock level"]);
    expect(doc(after).links).toHaveLength(parseFlow(CHECKOUT).links.length - 1);

    // In a chain the other links stay: the middle one splits it in two runs.
    const chain = lines('diagram flow "x"', "A", "B", "C", "D", "A > B > C > D: end", "D > A");
    const mid = run(chain, (t, p) => deleteLink(t, p, 1));
    expect(mid).toBe(lines('diagram flow "x"', "A", "B", "C", "D", "A > B", "C > D: end", "D > A"));
    // The first and the last (its label goes with it).
    expect(run(chain, (t, p) => deleteLink(t, p, 0))).toContain("B > C > D: end\n");
    expect(run(chain, (t, p) => deleteLink(t, p, 2))).toContain("A > B > C\nD > A");
    // Out of range and a comment-only line change nothing.
    expect(deleteLink(chain, parseFlow(chain), 9)).toEqual([]);
    expect(deleteLink(chain, parseFlow(chain), -1)).toEqual([]);
  });

  test("delete_link_op_runs_through_the_editor_entry", () => {
    const t = lines('diagram flow "x"', "A", "B", "A > B");
    const r = applyFlowEdit(t, parseFlow(t), { op: "deleteLink", index: 0 });
    expect(apply(t, r.edits)).toBe(lines('diagram flow "x"', "A", "B"));
  });
});

// Diagram build 1, S5: a participant added between two lands between them in the text, so the drawing shows it there.
test("addNode with before writes the new line just before that node", () => {
  const seq = lines('diagram sequence "Pay"', "participant App", "  participant Api", "App -> Api : charge");
  const r = applyFlowEdit(seq, parseFlow(seq), { op: "addNode", name: "Bank", kind: "participant", before: "Api" });
  expect(apply(seq, r.edits)).toBe(lines('diagram sequence "Pay"', "participant App", "  participant Bank", "  participant Api", "App -> Api : charge"));
  // An unknown name to go before: at the usual place.
  const r2 = applyFlowEdit(seq, parseFlow(seq), { op: "addNode", name: "Bank", kind: "participant", before: "Nobody" });
  expect(apply(seq, r2.edits)).toBe(lines('diagram sequence "Pay"', "participant App", "  participant Api", "participant Bank", "App -> Api : charge"));
});

test("a taken name gets the next free number after a space", () => {
  const flow = lines('diagram flow "f"', "Step");
  expect(applyFlowEdit(flow, parseFlow(flow), { op: "addNode", name: "Step", kind: null, unique: true }).name).toBe("Step 2");
});
