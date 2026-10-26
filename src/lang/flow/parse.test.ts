import { describe, expect, test } from "vitest";
import { writeFlow } from "../../flow/flowModel";
import { mermaidToFlow } from "../../flow/mermaid";
import type { TextEdit } from "../protocol";
import type { FlowDoc } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES, staleBanner } from "./problems";

const apply = (text: string, edits: TextEdit[]) =>
  [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;
const ok = (text: string) => {
  const r = parseFlow(text);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  if (!r.doc) throw new Error("no doc");
  return r.doc;
};
const errors = (text: string) => parseFlow(text).problems.filter((p) => p.severity === "error");
const at = (text: string, from: number, to: number) => text.slice(from, to);

describe("the first line", () => {
  test("names the kind and the title", () => {
    const r = parseFlow('diagram dfd "Checkout"\n');
    expect(r.kind).toBe("dfd");
    expect(r.doc).toEqual({ kind: "dfd", title: "Checkout", comments: [], nodes: [], links: [], groups: [] });
    expect(r.problems).toEqual([]);
  });

  test("reads every kind, an unquoted title and an escaped one", () => {
    expect(parseFlow("diagram flow Order handover\n").doc?.title).toBe("Order handover");
    expect(parseFlow('diagram cloud "Say \\"hi\\" \\\\ there"').doc).toMatchObject({ kind: "cloud", title: 'Say "hi" \\ there' });
  });

  test("blank lines and comments may come before it", () => {
    const r = parseFlow('\n// made by hand\n\ndiagram flow "A"\n');
    expect(r.kind).toBe("flow");
    expect(r.doc?.comments).toEqual([{ line: 2, text: "made by hand" }]);
  });

  test("a wrong first line is a problem with a fix per kind", () => {
    const text = 'diagram dfx "A"\nA [step]\n';
    const r = parseFlow(text);
    expect(r.kind).toBeNull();
    expect(r.doc).toBeNull();
    expect(r.problems).toHaveLength(1);
    const p = r.problems[0];
    expect(p).toMatchObject({ line: 1, severity: "error", message: MESSAGES.firstLine });
    expect(at(text, p.from, p.to)).toBe("dfx");
    expect(p.fixes.map((f) => f.title).slice(0, 3)).toEqual(["Make it diagram dfd", "Make it diagram flow", "Make it diagram cloud"]);
    expect(parseFlow(apply(text, p.fixes[1].edits)).doc?.kind).toBe("flow");
  });

  test("a file without the first line gets a fix that adds it", () => {
    const text = "A [step]\n";
    const p = parseFlow(text).problems[0];
    expect(p.message).toBe(MESSAGES.firstLine);
    expect(p.line).toBe(1);
    const fixed = apply(text, p.fixes[1].edits);
    expect(fixed).toBe('diagram flow "Untitled"\nA [step]\n');
    expect(ok(fixed).nodes).toEqual([{ name: "A", kind: "step", attrs: {} }]);
  });

  test("an empty file says what the first line must be", () => {
    const r = parseFlow("");
    expect(r.problems.map((p) => [p.line, p.from, p.to, p.message])).toEqual([[1, 0, 0, MESSAGES.firstLine]]);
  });
});

describe("nodes and kinds", () => {
  test("data flow kinds", () => {
    const doc = ok(lines('diagram dfd "C"', "Customer [entity]", "Checkout [process, id: 1]", "Orders [store, id: D1, table: shop.orders]"));
    expect(doc.nodes).toEqual([
      { name: "Customer", kind: "entity", attrs: {} },
      { name: "Checkout", kind: "process", attrs: { id: "1" } },
      { name: "Orders", kind: "store", attrs: { id: "D1", table: "shop.orders" } },
    ]);
  });

  test("flowchart kinds, step by default", () => {
    const doc = ok(lines('diagram flow "F"', "A", "B [start]", "C [end]", "D [decision]", "E [io, table: shop.orders]", "F [subprocess]", "G [step]"));
    expect(doc.nodes.map((n) => [n.name, n.kind])).toEqual([
      ["A", "step"],
      ["B", "start"],
      ["C", "end"],
      ["D", "decision"],
      ["E", "io"],
      ["F", "subprocess"],
      ["G", "step"],
    ]);
  });

  test("cloud nodes are services drawn with their icon", () => {
    const doc = ok(lines('diagram cloud "Shop"', "Users [icon: users]", "API [icon: aws-api-gateway, color: accent]", "Queue"));
    expect(doc.nodes).toEqual([
      { name: "Users", kind: "service", attrs: { icon: "users" } },
      { name: "API", kind: "service", attrs: { icon: "aws-api-gateway", color: "accent" } },
      { name: "Queue", kind: "service", attrs: {} },
    ]);
  });

  test("attributes take quoted values and keep their order", () => {
    const doc = ok(lines('diagram flow "F"', 'A [table: shop.orders, color: "warning, soft", id: 7]'));
    expect(doc.nodes[0].attrs).toEqual({ table: "shop.orders", color: "warning, soft", id: "7" });
    expect(Object.keys(doc.nodes[0].attrs)).toEqual(["table", "color", "id"]);
  });

  test("an unknown attribute is a problem", () => {
    const text = lines('diagram flow "F"', "A [step, colour: accent]");
    const [p] = errors(text);
    expect(p.message).toBe('Unknown attribute "colour". Use id, icon, label, color or table.');
    expect(at(text, p.from, p.to)).toBe("colour");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use color"]);
    expect(ok(apply(text, p.fixes[0].edits)).nodes[0].attrs).toEqual({ color: "accent" });
  });

  test("a list without its closing bracket is a problem", () => {
    const text = lines('diagram flow "F"', "A [step, id: 1", "B");
    const [p] = errors(text);
    expect(p.line).toBe(2);
    expect(p.message).toBe("This list has no closing ].");
  });
});

describe("links", () => {
  test("all five arrows", () => {
    const doc = ok(lines('diagram cloud "C"', "A", "B", "A > B", "A <> B", "A - B", "A --> B", "A ..> B"));
    expect(doc.links.map((l) => l.arrow)).toEqual([">", "<>", "-", "-->", "..>"]);
    expect(doc.links[0]).toEqual({ from: "A", to: "B", arrow: ">" });
  });

  test("arrows need no spaces around them", () => {
    const doc = ok(lines('diagram cloud "C"', "A", "B", "A>B", "A<>B", "A-->B", "A..>B"));
    expect(doc.links.map((l) => [l.from, l.arrow, l.to])).toEqual([
      ["A", ">", "B"],
      ["A", "<>", "B"],
      ["A", "-->", "B"],
      ["A", "..>", "B"],
    ]);
  });

  test("a dash inside a word is part of the name", () => {
    const doc = ok(lines('diagram flow "F"', "Sign-in", "Two-step check", "Sign-in > Two-step check"));
    expect(doc.links).toEqual([{ from: "Sign-in", to: "Two-step check", arrow: ">" }]);
  });

  test("the dotted line is for cloud diagrams only", () => {
    const text = lines('diagram flow "F"', "A", "B", "A ..> B");
    const [p] = errors(text);
    expect(p.message).toBe("The dotted line ..> is for cloud diagrams only.");
    expect(at(text, p.from, p.to)).toBe("..>");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use -->"]);
    expect(ok(apply(text, p.fixes[0].edits)).links[0].arrow).toBe("-->");
  });

  test("chains", () => {
    const doc = ok(lines('diagram flow "F"', "A", "B", "C", "D", "A > B > C - D"));
    expect(doc.links).toEqual([
      { from: "A", to: "B", arrow: ">" },
      { from: "B", to: "C", arrow: ">", chained: true },
      { from: "C", to: "D", arrow: "-", chained: true },
    ]);
  });

  test("a chain's label belongs to its last link", () => {
    const doc = ok(lines('diagram flow "F"', "A", "B", "C", "A > B > C: done"));
    expect(doc.links).toEqual([
      { from: "A", to: "B", arrow: ">" },
      { from: "B", to: "C", arrow: ">", label: "done" },
    ]);
  });

  test("labels run to the end of the line", () => {
    const doc = ok(lines('diagram flow "F"', "A", "B", "A > B: amount > 0: yes", 'A > B: "see // notes"', "A > B: stock level // checked daily"));
    expect(doc.links.map((l) => l.label)).toEqual(["amount > 0: yes", "see // notes", "stock level"]);
  });

  test("a link may end at a group", () => {
    const doc = ok(lines('diagram flow "F"', "A", "Kitchen {", "  B", "}", "A > Kitchen"));
    expect(doc.links).toEqual([{ from: "A", to: "Kitchen", arrow: ">" }]);
  });

  test("a link without its second name is a problem", () => {
    const text = lines('diagram flow "F"', "A", "A >");
    const [p] = errors(text);
    expect(p.line).toBe(3);
    expect(p.message).toBe("This link needs a name after >.");
  });
});

describe("groups", () => {
  test("nest, carry icons and keep their nodes in order", () => {
    const doc = ok(
      lines(
        'diagram cloud "Shop"',
        "Users [icon: users]",
        "AWS [icon: aws-cloud] {",
        "  VPC [icon: aws-vpc] {",
        "    API [icon: aws-lambda]",
        "    Private {",
        "      DB [icon: aws-rds]",
        "    }",
        "    Cache [icon: aws-elasticache]",
        "  }",
        "  Bucket [icon: aws-s3]",
        "}",
        "Users > API",
      ),
    );
    expect(doc.groups).toEqual([
      {
        name: "AWS",
        icon: "aws-cloud",
        nodes: ["Bucket"],
        groups: [{ name: "VPC", icon: "aws-vpc", nodes: ["API", "Cache"], groups: [{ name: "Private", nodes: ["DB"], groups: [] }] }],
      },
    ]);
    // The ones in no group first, then each group's own nodes before its inner groups, as the writer writes them.
    expect(doc.nodes.map((n) => n.name)).toEqual(["Users", "Bucket", "API", "Cache", "DB"]);
  });

  test("a group takes only an icon and a colour (step 11)", () => {
    const text = lines('diagram flow "F"', "Kitchen [process] {", "  A", "}");
    expect(errors(text).map((p) => p.message)).toEqual(["A group takes only an icon and a colour, for example [icon: aws-vpc, color: muted]."]);
  });

  test("a group never closed is a problem with a fix", () => {
    const text = lines('diagram flow "F"', "Kitchen {", "  A");
    const [p] = errors(text);
    expect(p).toMatchObject({ line: 2, message: "Kitchen has no closing }." });
    expect(p.fixes.map((f) => f.title)).toEqual(["Add } at the end"]);
    expect(ok(apply(text, p.fixes[0].edits)).groups).toEqual([{ name: "Kitchen", nodes: ["A"], groups: [] }]);
  });

  test("a closing brace with no group is a problem with a fix", () => {
    const text = lines('diagram flow "F"', "A", "}");
    const [p] = errors(text);
    expect(p).toMatchObject({ line: 3, message: "This } closes no group." });
    expect(p.fixes.map((f) => f.title)).toEqual(["Remove it"]);
    expect(ok(apply(text, p.fixes[0].edits)).nodes).toHaveLength(1);
  });
});

describe("comments and quoted names", () => {
  test("comments go to the end of the line, on their own or after a line", () => {
    const doc = ok(lines('diagram flow "F"', "// the happy path", "A [start] // first", "//", "A > A"));
    expect(doc.comments).toEqual([
      { line: 2, text: "the happy path" },
      { line: 3, text: "first" },
      { line: 4, text: "" },
    ]);
    expect(doc.nodes).toEqual([{ name: "A", kind: "start", attrs: {} }]);
  });

  test("quoted names keep reserved characters, \\\" and \\\\", () => {
    const doc = ok(lines('diagram flow "F"', '"Say \\"hi\\""', '"C:\\\\temp // [x]"', '"Say \\"hi\\"" > "C:\\\\temp // [x]": copy'));
    expect(doc.nodes.map((n) => n.name)).toEqual(['Say "hi"', "C:\\temp // [x]"]);
    expect(doc.links).toEqual([{ from: 'Say "hi"', to: "C:\\temp // [x]", arrow: ">", label: "copy" }]);
  });

  test("an empty quoted name is a name", () => {
    expect(ok(lines('diagram flow "F"', '"" [end]')).nodes).toEqual([{ name: "", kind: "end", attrs: {} }]);
  });
});

describe("lineOf and ranges", () => {
  test("say where each node, group and link is written", () => {
    const text = lines('diagram dfd "C"', "Customer [entity]", "Payments [icon: bank] {", "  Charge card [process, id: 2]", "}", "Customer > Charge card: amount");
    const r = parseFlow(text);
    expect(r.lineOf).toEqual({ Customer: 2, Payments: 3, "Charge card": 4 });
    const show = (x: { from: number; to: number } | undefined) => (x ? at(text, x.from, x.to) : null);
    const node = r.ranges["node:Charge card"];
    expect(show(node)).toBe("Charge card [process, id: 2]");
    expect(show(node.name)).toBe("Charge card");
    expect(show(node.attrs)).toBe("[process, id: 2]");
    expect(show(node.kind)).toBe("process");
    expect(show(node.values?.id)).toBe("2");
    const group = r.ranges["group:Payments"];
    expect(show(group)).toBe("Payments [icon: bank] {\n  Charge card [process, id: 2]\n}");
    expect(show(group.name)).toBe("Payments");
    expect(show(group.values?.icon)).toBe("bank");
    expect(show(group.open)).toBe("{");
    expect(show(group.close)).toBe("}");
    const link = r.ranges["link:0"];
    expect(show(link)).toBe("Customer > Charge card");
    expect(show(link.fromName)).toBe("Customer");
    expect(show(link.toName)).toBe("Charge card");
    expect(show(link.arrow)).toBe(">");
    expect(show(link.label)).toBe("amount");
    expect(show(link.line)).toBe("Customer > Charge card: amount");
    expect(show(r.ranges.title)).toBe('"C"');
    expect(show(r.ranges.kind)).toBe("dfd");
    expect(show(r.ranges.diagram)).toBe('diagram dfd "C"');
  });

  test("are kept while the text has an error", () => {
    const r = parseFlow(lines('diagram dfd "C"', "Customer [entity]", "Customer > Nobody"));
    expect(r.doc).toBeNull();
    expect(r.lineOf.Customer).toBe(2);
    expect(r.ranges["link:0"]).toBeDefined();
  });
});

describe("problems, verbatim, with their fixes", () => {
  const refunds = lines(
    'diagram dfd "Checkout"',
    "",
    "Customer [entity]",
    "Checkout [process, id: 1]",
    "Orders [store, id: D1, table: shop.orders]",
    "Card network [entity]",
    "",
    "Payments {",
    "  Charge card [process, id: 2]",
    "}",
    "",
    "Customer > Checkout: order details",
    "Checkout > Orders: new order",
    "Checkout > Refunds: reversal",
    "Charge card <> Card network: authorise",
  );

  test("Refunds is not defined", () => {
    const r = parseFlow(refunds);
    expect(r.doc).toBeNull();
    expect(r.problems).toHaveLength(1);
    const [p] = r.problems;
    expect(p).toMatchObject({ line: 14, severity: "error", message: "Refunds is not defined." });
    expect(at(refunds, p.from, p.to)).toBe("Refunds");
    expect(p.fixes.map((f) => f.title)).toEqual(["Add Refunds as a store", "Send it to Orders", "Send it to Charge card"]);
    const added = apply(refunds, p.fixes[0].edits);
    expect(added.endsWith("Charge card <> Card network: authorise\nRefunds [store, id: D2]\n")).toBe(true);
    expect(ok(added).nodes.find((n) => n.name === "Refunds")).toEqual({ name: "Refunds", kind: "store", attrs: { id: "D2" } });
    expect(ok(apply(refunds, p.fixes[2].edits)).links[2]).toEqual({ from: "Checkout", to: "Charge card", arrow: ">", label: "reversal" });
  });

  test("an unknown source in a flowchart is added as a step", () => {
    const text = lines('diagram flow "F"', "Pack order", "Packing", "Ship > Pack order");
    const [p] = parseFlow(text).problems;
    expect(p.message).toBe("Ship is not defined.");
    // The other end of the link is never offered.
    expect(p.fixes.map((f) => f.title)).toEqual(["Add Ship as a step", "Send it from Packing"]);
    expect(ok(apply(text, p.fixes[0].edits)).nodes.map((n) => n.name)).toEqual(["Pack order", "Packing", "Ship"]);
  });

  test("a name that needs quotes is added and sent to in quotes", () => {
    const text = lines('diagram flow "F"', '"Pay: card"', "A [start]", "A > Pay card");
    const [p] = parseFlow(text).problems;
    const send = p.fixes.find((f) => f.title === "Send it to Pay: card");
    expect(send).toBeDefined();
    expect(apply(text, send?.edits ?? [])).toContain('A > "Pay: card"');
  });

  test("Checkout is defined twice", () => {
    const text = lines('diagram flow "x"', "", "Start [start]", "Checkout [step]", "Pay [step]", "", "Shop {", "  Cart [step]", "  Checkout [step]", "}");
    const [p] = errors(text);
    expect(p).toMatchObject({ line: 9, message: "Checkout is defined twice (lines 4 and 9)." });
    expect(at(text, p.from, p.to)).toBe("Checkout");
    expect(p.fixes.map((f) => f.title)).toEqual(["Rename the second one"]);
    expect(ok(apply(text, p.fixes[0].edits)).groups[0].nodes).toEqual(["Cart", "Checkout 2"]);
  });

  test("a data flow node needs a kind", () => {
    const text = lines('diagram dfd "C"', "Checkout", "Orders [id: D1]");
    const ps = errors(text);
    expect(ps.map((p) => [p.line, p.message])).toEqual([
      [2, "A data flow node needs a kind: entity, process or store."],
      [3, "A data flow node needs a kind: entity, process or store."],
    ]);
    expect(ps[0].fixes.map((f) => f.title)).toEqual(["Make it an entity", "Make it a process", "Make it a store"]);
    const fixed = apply(apply(text, ps[1].fixes[2].edits), ps[0].fixes[1].edits);
    expect(ok(fixed).nodes).toEqual([
      { name: "Checkout", kind: "process", attrs: {} },
      { name: "Orders", kind: "store", attrs: { id: "D1" } },
    ]);
  });

  test('Unknown kind "proces"', () => {
    const text = lines('diagram dfd "C"', "Checkout [proces, id: 1]");
    const [p] = errors(text);
    expect(p.message).toBe('Unknown kind "proces". Did you mean process?');
    expect(at(text, p.from, p.to)).toBe("proces");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use process"]);
    expect(ok(apply(text, p.fixes[0].edits)).nodes[0].kind).toBe("process");
  });

  test("kinds are lower case", () => {
    expect(errors(lines('diagram dfd "C"', "Checkout [Process]"))[0].message).toBe('Unknown kind "Process". Did you mean process?');
  });

  test("a kind from another diagram lists the right ones", () => {
    expect(errors(lines('diagram flow "F"', "A [store]"))[0].message).toBe('Unknown kind "store". Use start, end, step, decision, io, subprocess, document or database.');
    expect(errors(lines('diagram cloud "C"', "A [process]"))[0].message).toBe("A cloud node takes an icon, not a kind, for example [icon: aws-s3].");
  });

  test("aws-dynamdb is not an icon (cloud only)", () => {
    const icons = new Set(["aws-dynamodb", "aws-s3", "users"]);
    const text = lines('diagram cloud "C"', "Table [icon: aws-dynamdb]", "Users [icon: users]");
    const r = parseFlow(text, { icons });
    expect(r.problems).toHaveLength(1);
    const [p] = r.problems;
    expect(p.message).toBe("aws-dynamdb is not an icon. Did you mean aws-dynamodb?");
    expect(at(text, p.from, p.to)).toBe("aws-dynamdb");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use aws-dynamodb"]);
    // The drawing still shows it, with the unknown-icon tile.
    expect(r.doc?.nodes[0].attrs.icon).toBe("aws-dynamdb");
    expect(parseFlow(lines('diagram flow "F"', "A [icon: aws-dynamdb]"), { icons }).problems).toEqual([]);
  });

  test("The first line must say", () => {
    expect(parseFlow("hello\n").problems[0].message).toBe(MESSAGES.firstLine);
  });

  test("a decision needs a label on each way out, as a hint", () => {
    const text = lines('diagram flow "F"', "Paid? [decision]", "A", "B", "Paid? > A: yes", "Paid? > B");
    const r = parseFlow(text);
    expect(r.doc).not.toBeNull();
    expect(r.problems.map((p) => [p.line, p.severity, p.message])).toEqual([[6, "hint", "A decision needs a label on each way out, for example yes and no."]]);
    expect(at(text, r.problems[0].from, r.problems[0].to)).toBe("Paid? > B");
    expect(parseFlow(text.replace('diagram flow "F"', 'diagram dfd "F"')).problems.some((p) => p.severity === "hint")).toBe(false);
  });

  test("the banner over the last good drawing", () => {
    expect(staleBanner(14)).toBe("Showing the last drawing that worked. Fix line 14 to update it.");
  });

  test("an unterminated quote says so", () => {
    const text = lines('diagram flow "F"', '"Pack order [step]', "B");
    const [p] = errors(text);
    expect(p).toMatchObject({ line: 2, message: "This name has no closing quote." });
  });
});

describe("writer_parser_round_trip", () => {
  const own = import.meta.glob("./fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const step7 = import.meta.glob("../../flow/fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const mermaid = import.meta.glob("../../flow/fixtures/*.mmd", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const fixtures = { ...own, ...step7 };

  // Comments come back as the writer places them (after the first line), so only their line numbers can move.
  const lineless = (d: FlowDoc) => ({ ...d, comments: d.comments.map((c) => c.text) });

  test("covers every fixture, including order-handover.flow", () => {
    expect(Object.keys(fixtures).some((k) => k.endsWith("order-handover.flow"))).toBe(true);
    expect(Object.keys(own).length).toBeGreaterThanOrEqual(4);
  });

  for (const [path, text] of Object.entries(fixtures)) {
    test(path, () => {
      const first = ok(text);
      const again = ok(writeFlow(first));
      expect(lineless(again)).toEqual(lineless(first));
      // Fixtures with their comments at the top come back exactly.
      if (path.includes("order-handover") || path.includes("quoting")) expect(again).toEqual(first);
    });
  }

  for (const [path, text] of Object.entries(mermaid)) {
    test(`${path} through Mermaid import`, () => {
      const r = mermaidToFlow(text, "Imported");
      const parsed = ok(r.flow);
      // The writer puts the nodes in no group first, so compare them by name.
      const byName = (d: FlowDoc) => ({ ...lineless(d), nodes: [...d.nodes].sort((a, b) => a.name.localeCompare(b.name)) });
      expect(byName(parsed)).toEqual(byName(r.doc));
      expect(ok(writeFlow(parsed))).toEqual(parsed);
    });
  }

  test("the writer quotes what the parser reads back", () => {
    const doc: FlowDoc = {
      kind: "cloud",
      title: 'A "quoted" \\ title',
      comments: [],
      nodes: [
        { name: "a > b", kind: "service", attrs: { icon: "aws-s3" } },
        { name: " padded ", kind: "service", attrs: { color: "warning, soft", table: "" } },
        { name: "x -- y", kind: "service", attrs: {} },
        { name: "wait..", kind: "service", attrs: {} },
        { name: "-", kind: "service", attrs: {} },
      ],
      links: [
        { from: "a > b", to: " padded ", arrow: "..>", label: "it's // fine" },
        { from: "x -- y", to: "wait..", arrow: ">" },
        { from: "wait..", to: "-", arrow: "-", chained: true },
      ],
      groups: [{ name: "VPC {1}", icon: "aws-vpc", nodes: ["x -- y"], groups: [] }],
    };
    const back = ok(writeFlow(doc));
    expect(back).toEqual({ ...doc, nodes: [doc.nodes[0], doc.nodes[1], doc.nodes[3], doc.nodes[4], doc.nodes[2]] });
  });
});

describe("odd_files_parse_with_problems", () => {
  const body = ['diagram dfd "Checkout"', "Customer [entity]", "Checkout [process, id: 1]", "Customer > Checkot: order", "Checkout > Customer: receipt"];

  test("CRLF line ends", () => {
    const text = `${body.join("\r\n")}\r\n`;
    const r = parseFlow(text);
    expect(r.lineOf).toEqual({ Customer: 2, Checkout: 3 });
    expect(r.problems).toHaveLength(1);
    const [p] = r.problems;
    expect(p.line).toBe(4);
    expect(at(text, p.from, p.to)).toBe("Checkot");
    expect(ok(apply(text, p.fixes.find((f) => f.title === "Send it to Checkout")?.edits ?? [])).links).toHaveLength(2);
    const label = r.ranges["link:1"].label;
    expect(label && at(text, label.from, label.to)).toBe("receipt");
  });

  test("a byte order mark", () => {
    const text = `\uFEFF${body.join("\n")}`;
    const r = parseFlow(text);
    expect(r.kind).toBe("dfd");
    expect(r.problems.map((p) => [p.line, at(text, p.from, p.to)])).toEqual([[4, "Checkot"]]);
  });

  test("tabs", () => {
    const text = lines('diagram\tflow\t"F"', "Kitchen\t{", "\tA\t[start]", "\t\tB\t[end]\t// done", "}", "A\t>\tB:\tready");
    const doc = ok(text);
    expect(doc.nodes.map((n) => n.name)).toEqual(["A", "B"]);
    expect(doc.links).toEqual([{ from: "A", to: "B", arrow: ">", label: "ready" }]);
  });

  test("an unterminated quote keeps the rest of the file readable", () => {
    const text = lines('diagram flow "F"', "A [start]", 'A > "Pack order', "B [end]", "A > B");
    const r = parseFlow(text);
    expect(r.problems.map((p) => [p.line, p.message])).toEqual([[3, "This name has no closing quote."]]);
    expect(at(text, r.problems[0].from, r.problems[0].to)).toBe('"Pack order');
    expect(r.lineOf).toEqual({ A: 2, B: 4 });
    expect(r.ranges["link:0"].fromName).toEqual({ from: text.indexOf("A > B"), to: text.indexOf("A > B") + 1 });
  });

  test("an unterminated title quote", () => {
    const r = parseFlow('diagram flow "Checkout\nA\n');
    expect(r.problems.map((p) => [p.line, p.message])).toEqual([[1, "This title has no closing quote."]]);
  });

  test("a 5 MB file", () => {
    const parts = ['diagram flow "Big"'];
    let size = parts[0].length;
    for (let k = 0; size < 5 * 1024 * 1024; k++) {
      let line: string;
      if (k > 0 && k % 50_000 === 0) line = `Missing ${k} > Node 1`;
      else if (k % 2) line = `Node ${k} [step, id: ${k}]`;
      else if (k >= 4) line = `Node ${k - 1} > Node ${k - 3}: step ${k}`;
      else line = `// part ${k}`;
      parts.push(line);
      size += line.length + 1;
    }
    parts.push(`"${"x".repeat(200_000)}`);
    const text = parts.join("\n");
    expect(text.length).toBeGreaterThan(5 * 1024 * 1024);
    const start = performance.now();
    const r = parseFlow(text);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(r.doc).toBeNull();
    const [first] = r.problems;
    expect(first).toMatchObject({ line: 50_002, message: "Missing 50000 is not defined." });
    expect(at(text, first.from, first.to)).toBe("Missing 50000");
    const last = r.problems[r.problems.length - 1];
    expect(last).toMatchObject({ line: parts.length, message: "This name has no closing quote." });
    expect(r.lineOf["Node 1"]).toBe(3);
  });

  test("a very long line with no names", () => {
    const text = `diagram flow "F"\n${"> ".repeat(100_000)}\n`;
    expect(() => parseFlow(text)).not.toThrow();
    expect(errors(text)[0].line).toBe(2);
  });

  const nested = (depth: number) => {
    const opens = Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}G${i} {`);
    const closes = Array.from({ length: depth }, (_, i) => `${"  ".repeat(depth - 1 - i)}}`);
    return lines('diagram flow "Deep"', ...opens, `${"  ".repeat(depth)}A`, ...closes);
  };

  test("groups nest at most 20 deep", () => {
    const doc = ok(nested(20));
    expect(ok(writeFlow(doc))).toEqual(doc);
    const text = nested(21);
    const r = parseFlow(text);
    expect(r.doc).toBeNull();
    expect(r.problems.map((p) => [p.line, p.message])).toEqual([[22, "Groups nest at most 20 deep."]]);
    expect(at(text, r.problems[0].from, r.problems[0].to)).toBe("G20");
  });

  test("10,000 nested groups give problems, not a throw", () => {
    const text = nested(10_000);
    let r: ReturnType<typeof parseFlow> | null = null;
    expect(() => {
      r = parseFlow(text);
    }).not.toThrow();
    const out = r as ReturnType<typeof parseFlow> | null;
    expect(out?.doc).toBeNull();
    expect(out?.problems[0]).toMatchObject({ line: 22, message: "Groups nest at most 20 deep." });
  });
});

describe("fix round 1", () => {
  test("the writer is not recursive", () => {
    // A doc built in code can nest deeper than a parsed one; writing it must not blow the stack.
    const root: FlowDoc["groups"][number] = { name: "G0", nodes: [], groups: [] };
    let g = root;
    for (let i = 1; i < 10_000; i++) {
      const child = { name: `G${i}`, nodes: [], groups: [] };
      g.groups.push(child);
      g = child;
    }
    g.nodes.push("A");
    const doc: FlowDoc = { kind: "flow", title: "T", comments: [], nodes: [{ name: "A", kind: "step", attrs: {} }], links: [], groups: [root] };
    const text = writeFlow(doc);
    expect(text.split("\n").filter((l) => l.trim() === "}")).toHaveLength(10_000);
  });

  test("a line break in a name, label, value, title or comment round-trips", () => {
    const doc: FlowDoc = {
      kind: "cloud",
      title: "Two\nlines",
      comments: [{ line: 3, text: "a\nb" }],
      nodes: [
        { name: "a\nb", kind: "service", attrs: { color: "x\ry" } },
        { name: "c\r\n", kind: "service", attrs: {} },
      ],
      links: [{ from: "a\nb", to: "c\r\n", arrow: ">", label: "go\nnow" }],
      groups: [],
    };
    const text = writeFlow(doc);
    expect(text.split("\n")).toHaveLength(9);
    const back = ok(text);
    expect({ ...back, comments: [] }).toEqual({ ...doc, comments: [] });
    // A comment cannot span lines, so its line break becomes a space.
    expect(back.comments.map((c) => c.text)).toEqual(["a b"]);
  });

  test("an empty group icon is kept", () => {
    const doc = ok(lines('diagram cloud "C"', 'G [icon: ""] {', "  A", "}"));
    expect(doc.groups[0].icon).toBe("");
    expect(ok(writeFlow(doc))).toEqual(doc);
  });

  test("the kind word on the first line must end there", () => {
    const text = 'diagram flow2 "T"\n';
    const r = parseFlow(text);
    expect(r.kind).toBeNull();
    expect(r.problems[0].message).toBe(MESSAGES.firstLine);
    expect(at(text, r.problems[0].from, r.problems[0].to)).toBe("flow2");
    expect(parseFlow(apply(text, r.problems[0].fixes[1].edits)).kind).toBe("flow");
    expect(parseFlow('diagram flow"T"\n').doc?.title).toBe("T");
    expect(parseFlow("diagram cloud // later\n").kind).toBe("cloud");
  });

  test("a kind on a cloud node has a fix that removes it", () => {
    for (const [line, fixed] of [
      ["S3 [store]", "S3 []"],
      ["S3 [store, icon: aws-s3]", "S3 [icon: aws-s3]"],
      ["S3 [icon: aws-s3, store]", "S3 [icon: aws-s3]"],
    ]) {
      const text = lines('diagram cloud "C"', line);
      const [p] = errors(text);
      expect(p.message).toBe("A cloud node takes an icon, not a kind, for example [icon: aws-s3].");
      expect(p.fixes.map((f) => f.title)).toEqual(["Remove it"]);
      const out = apply(text, p.fixes[0].edits);
      expect(out.split("\n")[1]).toBe(fixed);
      expect(errors(out)).toEqual([]);
    }
  });

  test("send-it-to suggestions are worked out once per missing name", () => {
    const names = Array.from({ length: 2000 }, (_, i) => `Node ${i}`);
    const uses = Array.from({ length: 150 }, (_, i) => `Node ${i} > Nod ${i % 3}`);
    const text = lines('diagram flow "F"', ...names, ...uses);
    const start = performance.now();
    const r = parseFlow(text);
    const took = performance.now() - start;
    expect(r.problems).toHaveLength(150);
    // Every use still gets its own two suggestions, never its own other end.
    for (const p of r.problems) {
      const sends = p.fixes.filter((f) => f.title.startsWith("Send it to"));
      expect(sends).toHaveLength(2);
      const other = text.slice(text.lastIndexOf("\n", p.from) + 1, p.from).replace(" > ", "");
      expect(sends.map((f) => f.title)).not.toContain(`Send it to ${other}`);
    }
    expect(took).toBeLessThan(1000);
  });

  test("the comparison budget is 100,000 per parse", () => {
    // 2,000 nodes: 50 different missing names fit the budget; the 51st and later get only the add fix.
    const names = Array.from({ length: 2000 }, (_, i) => `Node ${i}`);
    const uses = Array.from({ length: 60 }, (_, i) => `Node 1 > Gone ${i}`);
    const r = parseFlow(lines('diagram flow "F"', ...names, ...uses));
    const withSends = r.problems.filter((p) => p.fixes.some((f) => f.title.startsWith("Send it")));
    expect(withSends).toHaveLength(50);
    expect(r.problems.every((p) => p.fixes[0].title.startsWith("Add "))).toBe(true);
  });
});

describe("text it can't read", () => {
  test("a quoted token is shown in one pair of quotes", () => {
    expect(errors('diagram flow "x"\nA "Checkout"\n').map((p) => p.message)).toEqual([`Can't read "Checkout" here.`]);
    expect(MESSAGES.extra("<- B")).toBe(`Can't read "<- B" here.`);
    expect(MESSAGES.extra('"')).toBe(`Can't read """ here.`);
  });
});

describe("a header with a word that is no diagram kind", () => {
  const ALL = "dfd, flow, cloud, er, sequence, state, class, mindmap, timeline";
  const fix = (text: string) => {
    const p = parseFlow(text).problems.filter((x) => x.line === 3);
    expect(p).toHaveLength(1);
    return { p: p[0], text };
  };

  test("a known other name is one problem with a fix to the kind", () => {
    const { p, text } = fix('diagram flow "x"\nA [step]\ndiagram flowchart "Checkout"\n');
    expect(p.message).toBe("flowchart is not a diagram kind. Use flow.");
    expect(at(text, p.from, p.to)).toBe("flowchart");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use flow"]);
    expect(apply(text, p.fixes[0].edits)).toBe('diagram flow "x"\nA [step]\ndiagram flow "Checkout"\n');
    // The line defines nothing: the rest of the frame reads as before.
    expect(parseFlow(text).doc).toBeNull();
    expect(parseFlow(text).problems).toHaveLength(1);
  });

  test("every alias names its kind", () => {
    const cases: [string, string][] = [
      ["flowchart", "flow"],
      ["erd", "er"],
      ["entity", "er"],
      ["seq", "sequence"],
      ["mind map", "mindmap"],
      ["mind-map", "mindmap"],
      ["dataflow", "dfd"],
      ["data-flow", "dfd"],
      ["statechart", "state"],
      ["uml", "class"],
      ["Flow", "flow"],
    ];
    for (const [word, kind] of cases) {
      const { p, text } = fix(`diagram flow "x"\nA [step]\ndiagram ${word} "Checkout"\n`);
      expect(p.message).toBe(`${word} is not a diagram kind. Use ${kind}.`);
      expect(apply(text, p.fixes[0].edits)).toBe(`diagram flow "x"\nA [step]\ndiagram ${kind} "Checkout"\n`);
    }
  });

  test("an unknown word lists the kinds and offers no fix", () => {
    const { p, text } = fix('diagram flow "x"\nA [step]\ndiagram chart "Checkout" // later\n');
    expect(p.message).toBe(`chart is not a diagram kind. Use one of: ${ALL}.`);
    expect(at(text, p.from, p.to)).toBe("chart");
    expect(p.fixes).toEqual([]);
    expect(fix('diagram flow "x"\nA [step]\ndiagram erd // later\n').p.message).toBe("erd is not a diagram kind. Use er.");
  });

  test("on the first line an alias gets the same problem and fix; another word keeps the fixes for every kind", () => {
    const text = 'diagram flowchart "X"\nA [step]\n';
    const p = parseFlow(text).problems;
    expect(p.map((x) => [x.message, at(text, x.from, x.to)])).toEqual([["flowchart is not a diagram kind. Use flow.", "flowchart"]]);
    expect(p[0].fixes.map((f) => f.title)).toEqual(["Use flow"]);
    expect(apply(text, p[0].fixes[0].edits)).toBe('diagram flow "X"\nA [step]\n');
    const mind = 'diagram mind map "X"\n';
    const m = parseFlow(mind).problems[0];
    expect([m.message, at(mind, m.from, m.to)]).toEqual(["mind map is not a diagram kind. Use mindmap.", "mind map"]);
    expect(apply(mind, m.fixes[0].edits)).toBe('diagram mindmap "X"\n');
    const other = parseFlow('diagram chart "X"\n').problems[0];
    expect(other.message).toBe(MESSAGES.firstLine);
    expect(other.fixes).toHaveLength(9);
  });

  test("an indented line or a shape called diagram something is left alone", () => {
    ok('diagram flow "x"\ngroup G {\n  diagram store [step]\n}\n');
    ok('diagram flow "x"\ndiagram store [step]\n');
    ok('diagram flow "x"\ndiagram cleanup\n');
    ok('diagram flow "x"\ndiagram entity [step]\n');
    expect(errors('diagram flow "x"\n  diagram flowchart "Checkout"\n').map((p) => p.message)).not.toContain(
      "flowchart is not a diagram kind. Use flow.",
    );
  });
});
