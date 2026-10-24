import { describe, expect, test } from "vitest";
import { completeFlow } from "./complete";

const ICONS = ["users", "server", "database", "aws-s3", "aws-lambda", "aws-dynamodb", "azure-sql", "gcp-bigquery", "k8s-pod", "aws-sqs"];

/** Completes at the `|` in `text`. */
function at(text: string, icons: readonly string[] = ICONS) {
  const pos = text.indexOf("|");
  const clean = text.slice(0, pos) + text.slice(pos + 1);
  const r = completeFlow(clean, pos, icons);
  return { ...r, labels: r.items.map((i) => i.label), clean, pos };
}

const DFD = 'diagram dfd "Checkout"\nCustomer [entity]\nCharge card [process, id: 2]\nPayments {\n  Orders [store]\n}\n';

describe("completeFlow", () => {
  test("after [ it lists the kinds for the diagram kind, then the attribute keys", () => {
    expect(at(`${DFD}Refunds [|`).labels).toEqual(["entity", "process", "store", "id", "icon", "color", "table"]);
    expect(at('diagram flow "A"\nCook [|').labels).toEqual(["start", "end", "step", "decision", "io", "subprocess", "document", "database", "id", "icon", "color", "table"]);
    // A cloud node takes an icon, not a kind.
    expect(at('diagram cloud "A"\nQueue [|').labels).toEqual(["icon", "id", "color", "table"]);
  });

  test("filters by what is typed and leaves out what the brackets have", () => {
    const r = at(`${DFD}Refunds [st|`);
    expect(r.labels).toEqual(["store"]);
    expect(r.from).toBe(r.pos - 2);
    expect(at(`${DFD}Refunds [store, |`).labels).toEqual(["id", "icon", "color", "table"]);
    expect(at(`${DFD}Refunds [store, id: D2, |`).labels).toEqual(["icon", "color", "table"]);
    expect(at(`${DFD}Refunds [store, id: D2, i|`).labels).toEqual(["icon"]);
  });

  test("an attribute key is applied with its colon", () => {
    const r = at(`${DFD}Refunds [store, ta|`);
    expect(r.items[0]).toMatchObject({ label: "table", apply: "table: ", kind: "attr" });
    expect(at(`${DFD}Refunds [pro|`).items[0]).toMatchObject({ label: "process", apply: "process", kind: "kind" });
  });

  test("after icon: it lists icons, provider prefix first", () => {
    expect(at('diagram cloud "A"\nQueue [icon: |').labels).toEqual([
      "aws-dynamodb",
      "aws-lambda",
      "aws-s3",
      "aws-sqs",
      "azure-sql",
      "gcp-bigquery",
      "k8s-pod",
      "database",
      "server",
      "users",
    ]);
    // The typed text matched at the start first, then after the provider prefix, then anywhere.
    const s = at('diagram cloud "A"\nQueue [icon: s|');
    expect(s.labels).toEqual(["server", "aws-s3", "aws-sqs", "azure-sql", "database", "users"]);
    expect(s.from).toBe(s.pos - 1);
    expect(at('diagram cloud "A"\nQueue [table: x, icon:aws-l|').labels).toEqual(["aws-lambda"]);
    expect(at('diagram cloud "A"\nVPC [icon: k8|] {').labels).toEqual(["k8s-pod"]);
  });

  test("node names at the start of a line and after an arrow", () => {
    expect(at(`${DFD}Cu|`).labels).toEqual(["Customer"]);
    expect(at(`${DFD}Customer > |`).labels).toEqual(["Customer", "Charge card", "Payments", "Orders"]);
    const r = at(`${DFD}Customer --> Charge c|`);
    expect(r.labels).toEqual(["Charge card"]);
    expect(r.from).toBe(r.pos - "Charge c".length);
    expect(at(`${DFD}Customer <> or|`).labels).toEqual(["Orders"]);
  });

  test("a name that needs quotes is applied quoted", () => {
    const text = 'diagram flow "A"\n"a: b"\nX > |';
    expect(at(text).items.find((i) => i.label === "a: b")?.apply).toBe('"a: b"');
    // Typing the quote is part of what gets replaced.
    const q = at('diagram flow "A"\n"a: b"\nX > "a|');
    expect(q.labels).toEqual(["a: b"]);
    expect(q.from).toBe(q.pos - 2);
  });

  test("the first line offers the diagram kinds", () => {
    expect(at("diagram |").labels).toEqual(["dfd", "flow", "cloud", "er", "sequence", "state", "class", "mindmap", "timeline"]);
    expect(at("// notes\ndiagram cl|").labels).toEqual(["cloud", "class"]);
  });

  test("nothing in a comment, a label or a quoted value", () => {
    expect(at(`${DFD}// Cu|`).labels).toEqual([]);
    expect(at(`${DFD}Customer > Orders: Cu|`).labels).toEqual([]);
    expect(at(`${DFD}Refunds [table: "x, |`).labels).toEqual([]);
    expect(at(`${DFD}Customer [entity] // [|`).labels).toEqual([]);
  });

  test("names come from the text even while it has an error", () => {
    expect(at('diagram dfd "A"\nCustomer [entity]\nBroken [proces]\nCustomer > |').labels).toEqual(["Customer", "Broken"]);
  });

  test("names given by the worker are used as they are", () => {
    const given = new Map([
      ["Alpha", 3],
      ["Beta", 4],
    ]);
    const r = completeFlow('diagram flow "A"\nX > ', 'diagram flow "A"\nX > '.length, ICONS, given);
    expect(r.items.map((i) => i.label)).toEqual(["Alpha", "Beta"]);
  });
});

test("a typed provider prefix puts the provider icons first", () => {
  const icons = ["api", "app", "aws-s3", "azure-sql", "gcp-artifacts", "gcp-run", "storage", "s3-general"];
  const r = completeFlow('diagram cloud "A"\nQ [icon: a', 'diagram cloud "A"\nQ [icon: a'.length, icons);
  expect(r.items.map((i) => i.label)).toEqual(["aws-s3", "azure-sql", "gcp-artifacts", "api", "app", "s3-general", "storage"]);
  // Not a provider prefix: the order is unchanged.
  const s = completeFlow('diagram cloud "A"\nQ [icon: s', 'diagram cloud "A"\nQ [icon: s'.length, icons);
  expect(s.items.map((i) => i.label)).toEqual(["s3-general", "storage", "aws-s3", "azure-sql", "gcp-artifacts"]);
});

test("inside an ER column's brackets the column flags are offered, not node kinds (ER build A)", () => {
  const text = 'diagram er "x"\ncustomers\ncustomers.id int [pk, ';
  const r = completeFlow(text, text.length, []);
  expect(r.items.map((i) => i.label)).toEqual(["not null", "unique"]);
  const typed = 'diagram er "x"\ncustomers\ncustomers.email text [no';
  expect(completeFlow(typed, typed.length, []).items.map((i) => i.apply)).toEqual(["not null"]);
  // A table's own brackets still offer its kinds.
  const table = 'diagram er "x"\nlines [';
  expect(completeFlow(table, table.length, []).items.map((i) => i.label)).toContain("weak");
});
