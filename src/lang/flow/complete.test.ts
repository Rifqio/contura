import { describe, expect, test } from "vitest";
import { completeFlow } from "./complete";
import { PALETTE } from "./model";

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
    expect(at(`${DFD}Refunds [|`).labels).toEqual(["entity", "process", "store", "id", "icon", "label", "color", "table"]);
    expect(at('diagram flow "A"\nCook [|').labels).toEqual(["start", "end", "step", "decision", "io", "subprocess", "document", "database", "id", "icon", "label", "color", "table"]);
    // A cloud node takes an icon, not a kind.
    expect(at('diagram cloud "A"\nQueue [|').labels).toEqual(["icon", "id", "label", "color", "table"]);
  });

  test("filters by what is typed and leaves out what the brackets have", () => {
    const r = at(`${DFD}Refunds [st|`);
    expect(r.labels).toEqual(["store"]);
    expect(r.from).toBe(r.pos - 2);
    expect(at(`${DFD}Refunds [store, |`).labels).toEqual(["id", "icon", "label", "color", "table"]);
    expect(at(`${DFD}Refunds [store, id: D2, |`).labels).toEqual(["icon", "label", "color", "table"]);
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
    expect(at("diagram e|").labels).toEqual(["er"]);
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

describe("step 11: labels and colours", () => {
  test("the label and colour keys say what they are for", () => {
    const r = at('diagram flow "A"\nCook [|');
    expect(r.items.find((i) => i.label === "label")?.detail).toBe("the words it shows, when another shape has the name");
    expect(r.items.find((i) => i.label === "color")?.detail).toBe("a preset, a CSS colour name or a hex");
  });

  test("colour_completion_lists_presets_first", () => {
    const r = at('diagram flow "A"\nCook [color: |');
    expect(r.labels.slice(0, 6)).toEqual([...PALETTE]);
    expect(r.labels[6]).toBe("aliceblue");
    expect(r.labels).toHaveLength(154);
    expect(r.items[4]).toMatchObject({ label: "danger", apply: "danger", detail: "Danger: failure, error, data at risk" });
    expect(r.items[6]).toMatchObject({ label: "aliceblue", detail: "#f0f8ff" });
    expect(at('diagram flow "A"\nCook [color: te|').labels).toEqual(["teal"]);
    expect(at('diagram flow "A"\nCook [step, color: wa|').labels).toEqual(["warning"]);
  });

  test("a line's brackets offer only color, after a label too", () => {
    const text = 'diagram flow "A"\nPaid?\nRetry\n';
    expect(at(`${text}Paid? > Retry [|`).labels).toEqual(["color"]);
    expect(at(`${text}Paid? > Retry: no [|`).labels).toEqual(["color"]);
    expect(at(`${text}Paid? > Retry: no [color: dang|`).labels).toEqual(["danger"]);
  });

  test("sequence, class and timeline shapes are offered no label or colour", () => {
    expect(at('diagram class "C"\nInvoice [|').labels).not.toContain("color");
    expect(at('diagram class "C"\nInvoice [|').labels).not.toContain("label");
  });

  test("each shape is listed by its name with the words it shows", () => {
    const text = 'diagram flow "A"\nRetry\nRetry 2 [label: Retry]\nCharge\nCharge > Re|';
    const r = at(text);
    expect(r.labels).toEqual(["Retry", "Retry 2"]);
    expect(r.items[1]).toMatchObject({ apply: "Retry 2", detail: 'shows "Retry" (label:)' });
    expect(r.items[0].detail).toBeUndefined();
  });
});

describe("a participant's brackets", () => {
  test("participant_bracket_completion", () => {
    expect(at('diagram sequence "A"\nparticipant App [|').labels).toEqual(["icon", "label", "color"]);
    expect(at('diagram sequence "A"\nactor Ann [icon: users, |').labels).toEqual(["label", "color"]);
    expect(at('diagram sequence "A"\nparticipant App [icon: |').labels.sort()).toEqual([...ICONS].sort());
  });
});

describe("a bare shape in a sequence", () => {
  test("offers no attribute keys after Name [", () => {
    expect(at('diagram sequence "A"\nShop [|').labels).toEqual([]);
  });
});

describe("ER completion", () => {
  const TABLES: Record<string, string[]> = { orders: ["id", "customer_id"], customers: ["id", "email"], "sales.orders": ["id", "total"] };
  const columnsOf = (t: string): readonly string[] | null => TABLES[t] ?? null;
  const er = (text: string, extra: { oldEr?: boolean; cols?: typeof columnsOf } = {}) => {
    const pos = text.indexOf("|");
    const clean = text.slice(0, pos) + text.slice(pos + 1);
    const r = completeFlow(clean, pos, ICONS, undefined, undefined, extra.cols ?? columnsOf, extra.oldEr);
    return { ...r, labels: r.items.map((i) => i.label), pos };
  };
  const HEAD = 'diagram er "Shop"\n';

  test("flags_after_a_column_type", () => {
    expect(er(`${HEAD}orders {\n  id int |`).labels).toEqual(["pk", "not null", "unique"]);
    expect(er(`${HEAD}orders {\n  id int pk |`).labels).toEqual(["not null", "unique"]);
    expect(er(`${HEAD}orders {\n  id int not null |`).labels).toEqual(["pk", "unique"]);
    expect(er(`${HEAD}orders {\n  id int u|`).labels).toEqual(["unique"]);
    expect(er(`${HEAD}orders {\n  id decimal(10, 2) |`).labels).toEqual(["pk", "not null", "unique"]);
  });

  test("no flags before the type is written, in a comment or outside a table", () => {
    expect(er(`${HEAD}orders {\n  id |`).labels).toEqual([]);
    expect(er(`${HEAD}orders {\n  id i|`).labels).toEqual([]);
    expect(er(`${HEAD}orders {\n  id int // |`).labels).toEqual([]);
    expect(er(`${HEAD}orders {\n  id int pk\n}\nid int |`).labels).not.toContain("pk");
  });

  test("columns_after_a_table_dot", () => {
    const r = er(`${HEAD}orders.customer_id > customers.|`);
    expect(r.labels).toEqual(["id", "email"]);
    expect(r.from).toBe(r.pos);
    expect(er(`${HEAD}orders.customer_id > customers.em|`).labels).toEqual(["email"]);
    expect(er(`${HEAD}orders.|`).labels).toEqual(["id", "customer_id"]);
    // The longest prefix that names a table.
    expect(er(`${HEAD}sales.orders.|`).labels).toEqual(["id", "total"]);
    expect(er(`${HEAD}nothing.|`).labels).toEqual([]);
    // A table with no columns still names the table: no fall back to a shorter prefix.
    const cols = (t: string) => ({ sales: ["region"], "sales.empty": [] as string[] })[t] ?? null;
    expect(er(`${HEAD}sales.empty.|`, { cols }).labels).toEqual([]);
  });

  test("group_at_a_line_start", () => {
    expect(er(`${HEAD}|`).labels).toEqual(["group"]);
    expect(er(`${HEAD}orders\ngr|`).labels).toEqual(["group"]);
    expect(er(`${HEAD}group Billing {\n  |`).labels).toContain("group");
    expect(er(`${HEAD}orders {\n  |`).labels).toEqual([]);
  });

  test("table_bracket_keys", () => {
    expect(er(`${HEAD}orders [|`).items.map((i) => i.apply)).toEqual(["entity", "weak", "icon: ", "label: ", "color: "]);
    expect(er(`${HEAD}orders [weak, |`).labels).toEqual(["icon", "label", "color"]);
    expect(er(`${HEAD}group Billing [|`).labels).toEqual(["icon", "color"]);
  });

  test("an old ER frame offers nothing ER-specific", () => {
    expect(er(`${HEAD}orders.customer_id > customers.|`, { oldEr: true }).labels).toEqual([]);
    expect(er(`${HEAD}|`, { oldEr: true }).labels).toEqual([]);
    expect(er(`${HEAD}orders [|`, { oldEr: true }).labels).toEqual(["entity", "weak", "id", "icon", "label", "color", "table"]);
  });

  test("braces in quotes and comments do not open a block", () => {
    expect(er(`${HEAD}"a {" [entity]\n// {\n|`).labels).toContain("group");
    expect(er(`${HEAD}orders {\n  "x}" int pk\n  id int |`).labels).toEqual(["pk", "not null", "unique"]);
  });
});

test("autonumber_is_offered_at_line_start_in_a_sequence", () => {
  expect(at('diagram sequence "A"\nauto|').labels).toContain("autonumber");
  expect(at('diagram flow "A"\nauto|').labels).not.toContain("autonumber");
});

describe("a sequence block's brackets", () => {
  test("a_block_bracket_offers_color", () => {
    for (const w of ["loop", "alt", "opt", "par", "critical"]) expect(at(`diagram sequence "A"\n${w} x [|`).labels).toEqual(["color"]);
    expect(at('diagram sequence "A"\nopt x [color: wa|').labels).toEqual(["warning"]);
    expect(at('diagram sequence "A"\nopt x [color: |').labels).toContain("danger");
  });
});
