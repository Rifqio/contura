// Step 12, item 19: the six newer diagram kinds, read as DiagramElements.dc.html writes them.
import { describe, expect, test } from "vitest";
import { DIAGRAM_KINDS, nodeStatement, STATE_END, STATE_START } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const ok = (text: string) => {
  const r = parseFlow(text);
  expect(r.problems.filter((p) => p.severity === "error").map((p) => p.message)).toEqual([]);
  return r.doc!;
};

describe("entity relationship", () => {
  // The ER kind is back, in table blocks (erBlocks.test.ts reads them in full).
  test("diagram er is a kind after cloud, offered by the first-line fixes, with entity and weak in brackets", () => {
    expect(DIAGRAM_KINDS.indexOf("er")).toBe(DIAGRAM_KINDS.indexOf("cloud") + 1);
    const doc = ok(lines('diagram er "Billing"', "customers {", "  id int pk", "}", "lines [weak]"));
    expect(doc.nodes.map((n) => [n.name, n.kind])).toEqual([
      ["customers", "entity"],
      ["lines", "weak"],
    ]);
    expect(nodeStatement("er", { name: "customers", kind: "entity", attrs: {} })).toBe("customers");
    expect(nodeStatement("er", { name: "lines", kind: "weak", attrs: {} })).toBe("lines [weak]");
    const none = parseFlow("customers\n").problems[0].fixes.map((f) => f.title);
    expect(none).toContain("Add diagram er");
    expect(parseFlow(lines('diagram er "x"', "a [process]")).problems[0].message).toBe(MESSAGES.unknownKind("process", "er", null));
  });
});

describe("sequence", () => {
  test("participants, actors, messages, replies, frames and activations", () => {
    const doc = ok(
      lines(
        'diagram sequence "Pay an invoice"',
        "actor Customer",
        "participant App",
        "participant Billing API",
        "Customer -> App : Pay invoice",
        "activate Billing API",
        "App -> Billing API : POST /payments",
        "loop retry 3 times {",
        "  Billing API -> payments : insert payment",
        "  payments --> Billing API : ok",
        "}",
        "Billing API --> App : 201 Created",
        "deactivate Billing API",
      ),
    );
    expect(doc.nodes.map((n) => [n.name, n.kind])).toEqual([
      ["Customer", "actor"],
      ["App", "participant"],
      ["Billing API", "participant"],
      // Used before it was declared: a participant all the same.
      ["payments", "participant"],
    ]);
    expect(doc.links.map((l) => `${l.from} ${l.arrow} ${l.to}: ${l.label}`)).toEqual([
      "Customer -> App: Pay invoice",
      "App -> Billing API: POST /payments",
      "Billing API -> payments: insert payment",
      "payments --> Billing API: ok",
      "Billing API --> App: 201 Created",
    ]);
    expect(doc.frames).toEqual([{ label: "loop retry 3 times", kind: "loop", from: 2, to: 3, depth: 0 }]);
    expect(doc.activations).toEqual([{ name: "Billing API", from: 1, to: 4 }]);
  });

  test("a frame without its brace or its close says so", () => {
    expect(parseFlow(lines('diagram sequence "x"', "loop forever")).problems[0].message).toBe(MESSAGES.frameNeedsBrace);
    expect(parseFlow(lines('diagram sequence "x"', "loop forever {", "a -> b")).problems[0].message).toBe(MESSAGES.unclosedFrame("loop forever"));
  });
});

describe("state", () => {
  test("states, start and end markers, choices, forks and composites", () => {
    const doc = ok(
      lines(
        'diagram state "Invoice"',
        "Open {",
        "  Draft [state]",
        "  Sent",
        "}",
        "Paid in full? [choice]",
        "Split [fork]",
        "[*] > Draft",
        "Draft > Sent : send",
        "Sent > Paid in full? : payment",
        "Paid in full? > [*]",
      ),
    );
    expect(doc.nodes.map((n) => [n.name, n.kind])).toEqual([
      [STATE_START, "start"],
      [STATE_END, "end"],
      ["Paid in full?", "choice"],
      ["Split", "fork"],
      ["Draft", "state"],
      ["Sent", "state"],
    ]);
    expect(doc.groups).toEqual([{ name: "Open", nodes: ["Draft", "Sent"], groups: [] }]);
    expect(doc.links[0]).toEqual({ from: STATE_START, to: "Draft", arrow: ">" });
    expect(doc.links[3]).toEqual({ from: "Paid in full?", to: STATE_END, arrow: ">" });
  });
});

describe("class", () => {
  test("classes, interfaces, enums, members and the three lines", () => {
    const doc = ok(
      lines(
        'diagram class "Billing types"',
        "interface Payable",
        "Payable : pay(amount)",
        "class Invoice",
        "Invoice : + id: int",
        "Invoice : + send()",
        "enum InvoiceStatus",
        "InvoiceStatus : DRAFT",
        "class LineItem",
        "Payable <|-- Invoice",
        "Invoice *-- LineItem : lines",
        "Invoice ..> InvoiceStatus : uses",
      ),
    );
    expect(doc.nodes.map((n) => [n.name, n.kind, n.rows ?? []])).toEqual([
      ["Payable", "interface", ["pay(amount)"]],
      ["Invoice", "class", ["+ id: int", "+ send()"]],
      ["InvoiceStatus", "enum", ["DRAFT"]],
      ["LineItem", "class", []],
    ]);
    expect(doc.links.map((l) => l.arrow)).toEqual(["<|--", "*--", "..>"]);
  });

  test("a member of an unknown class says so", () => {
    expect(parseFlow(lines('diagram class "x"', "Ghost : x")).problems[0].message).toBe(MESSAGES.noClass("Ghost"));
  });
});

describe("mind map", () => {
  test("the root, topics by indent, and a branch across", () => {
    const doc = ok(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release", "    v1.0", "Diagrams > Release"));
    expect(doc.nodes.map((n) => [n.name, n.kind, n.depth])).toEqual([
      ["Q4 plan", "root", 0],
      ["Diagrams", "topic", 1],
      ["New kinds", "topic", 2],
      ["Release", "topic", 1],
      ["v1.0", "topic", 2],
    ]);
    expect(doc.links).toEqual([
      { from: "Diagrams", to: "Release", arrow: ">" },
      { from: "Q4 plan", to: "Diagrams", arrow: "-", tree: true },
      { from: "Diagrams", to: "New kinds", arrow: "-", tree: true },
      { from: "Q4 plan", to: "Release", arrow: "-", tree: true },
      { from: "Release", to: "v1.0", arrow: "-", tree: true },
    ]);
  });
});

describe("timeline", () => {
  test("events, periods, milestones and sections", () => {
    const doc = ok(
      lines('diagram timeline "Contura 2026"', "section Q3 2026", "2026-07-14: Table designer", "2026-08 to 2026-09: Data transfer", "section Q4 2026", "milestone v1.0", "2026-10-19 : Docs ready"),
    );
    expect(doc.sections).toEqual(["Q3 2026", "Q4 2026"]);
    expect(doc.nodes.map((n) => [n.name, n.kind, n.date, n.until, n.section])).toEqual([
      ["Table designer", "event", "2026-07-14", undefined, "Q3 2026"],
      ["Data transfer", "period", "2026-08", "2026-09", "Q3 2026"],
      ["v1.0", "milestone", undefined, undefined, "Q4 2026"],
      ["Docs ready", "event", "2026-10-19", undefined, "Q4 2026"],
    ]);
  });

  test("a bad date and a line with no date say what to write", () => {
    expect(parseFlow(lines('diagram timeline "x"', "2026-1-5: x")).problems[0].message).toBe(MESSAGES.badDate);
    expect(parseFlow(lines('diagram timeline "x"', "Release")).problems[0].message).toBe(MESSAGES.timelineLine);
  });
});

describe("dotted line", () => {
  test("dotted_line_in_every_line_kind", () => {
    for (const k of ["dfd", "flow", "cloud", "state", "mindmap"]) {
      const text = k === "mindmap" ? lines('diagram mindmap "x"', "Root", "  Child", "Root -- Child") : lines(`diagram ${k} "x"`, k === "dfd" ? "A [entity]" : "A", k === "dfd" ? "B [process]" : "B", "A -- B");
      const links = ok(text).links.filter((l) => !l.tree);
      expect(links.map((l) => l.arrow), k).toEqual(["--"]);
    }
    expect(ok(lines('diagram class "x"', "class A", "class B", "A -- B")).links.map((l) => l.arrow)).toEqual(["--"]);
    const seq = parseFlow(lines('diagram sequence "x"', "A -- B"));
    expect(seq.problems.some((p) => p.severity === "error")).toBe(true);
  });
});

describe("shared", () => {
  test("a note is a remark the canvas draws, in the kinds that have it", () => {
    const doc = ok(lines('diagram flow "x"', "note: Prices exclude tax.", "A"));
    expect(doc.nodes[0]).toEqual({ name: "Note 1", kind: "note", attrs: {}, text: "Prices exclude tax." });
  });

  test("flowcharts gain document and database", () => {
    const doc = ok(lines('diagram flow "x"', "Packing slip [document]", "orders [database]"));
    expect(doc.nodes.map((n) => n.kind)).toEqual(["document", "database"]);
  });

  test("each kind writes its own statement and reads it back", () => {
    const cases: [Parameters<typeof nodeStatement>[0], Parameters<typeof nodeStatement>[1], string][] = [
      ["sequence", { name: "App", kind: "participant", attrs: {} }, "participant App"],
      ["class", { name: "Invoice", kind: "class", attrs: {} }, "class Invoice"],
      ["mindmap", { name: "Topic", kind: "topic", attrs: {}, depth: 2 }, "    Topic"],
      ["timeline", { name: "Ship", kind: "event", attrs: {}, date: "2026-10-19" }, "2026-10-19: Ship"],
      ["timeline", { name: "Run", kind: "period", attrs: {}, date: "2026-09", until: "2026-10" }, "2026-09 to 2026-10: Run"],
      ["state", { name: "Draft", kind: "state", attrs: {} }, "Draft"],
      ["flow", { name: "Note 1", kind: "note", attrs: {}, text: "Mind the gap" }, "note: Mind the gap"],
    ];
    for (const [kind, node, line] of cases) expect(nodeStatement(kind, node)).toBe(line);
  });
});

describe("completion", () => {
  test("a kind's leading words at the start of a line, and names after its arrows", async () => {
    const { completeFlow } = await import("./complete");
    // The text ends where you are typing.
    const at = (text: string) => completeFlow(text, text.length, []).items.map((i) => i.label);
    expect(at('diagram sequence "x"\npa')).toEqual(["participant"]);
    expect(at('diagram class "x"\nclass Invoice\nclass Payable\nPayable <|-- In')).toEqual(["Invoice"]);
    expect(at('diagram flow "x"\nno')).toEqual(["note"]);
  });
});

describe("canvas edits", () => {
  test("adds write each kind's statement; delete and rename take a node's own lines", async () => {
    const { applyFlowEdit } = await import("./edits");
    const apply = (text: string, op: Parameters<typeof applyFlowEdit>[2]) => {
      const r = applyFlowEdit(text, parseFlow(text), op);
      let out = text;
      for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
      return out;
    };
    const seq = lines('diagram sequence "x"', "participant App");
    expect(apply(seq, { op: "addNode", name: "API", kind: "participant" })).toBe(lines('diagram sequence "x"', "participant App", "participant API"));
    const cls = lines('diagram class "x"', "class Invoice", "Invoice : + send()", "class Line", "Invoice *-- Line");
    expect(apply(cls, { op: "deleteNode", name: "Invoice" })).toBe(lines('diagram class "x"', "class Line"));
    expect(apply(cls, { op: "renameNode", old: "Invoice", next: "Bill" })).toBe(lines('diagram class "x"', "class Bill", "Bill : + send()", "class Line", "Bill *-- Line"));
  });
});

describe("icon checks by kind", () => {
  const icons = new Set(["aws-lambda", "users"]);
  const hints = (text: string) => parseFlow(text, { icons }).problems.map((p) => p.message);

  test("a flowchart node's unknown icon is not checked, a cloud node's is", () => {
    expect(hints(lines('diagram flow "F"', "Run [step, icon: aws-lamda]"))).toEqual([]);
    expect(hints(lines('diagram cloud "C"', "Run [icon: aws-lamda]"))).toEqual([MESSAGES.notAnIcon("aws-lamda", "aws-lambda")]);
  });
});
