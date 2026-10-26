// Diagram build 1, step 2: the .flow lines a copy puts on the clipboard, and the lines a paste writes into the
// text with free names (diagram-ux-research F2), for every diagram kind.
import { expect, test } from "vitest";
import { copyLines, pasteLines } from "./clip";
import { sqlFreeName } from "./model";
import { parseFlow } from "./parse";
import { applyEdits } from "./service";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

function docOf(text: string) {
  const p = parseFlow(text);
  if (!p.doc) throw new Error(p.problems.map((x) => x.message).join("; "));
  return p.doc;
}

/** The text after a paste of `clip` into `text`, and the names it used; null when the paste is refused. */
function paste(text: string, clip: string, place?: Parameters<typeof pasteLines>[3]) {
  const r = pasteLines(text, parseFlow(text), clip, place);
  if (r.edits.length === 0) return null;
  const out = applyEdits(text, r.edits);
  // What a paste writes always reads back without an error.
  expect(parseFlow(out).problems.filter((p) => p.severity === "error").map((p) => p.message)).toEqual([]);
  return { text: out, names: r.names };
}

const FLOW = lines('diagram flow "Refund"', "", "Request in [start]", "Check [decision]", "Done [end]", "", "Request in > Check", "Check > Done: yes");

test("a copy is the shapes' lines, then only the lines between copied shapes", () => {
  expect(copyLines(docOf(FLOW), ["Check", "Done"])).toBe(lines("Check [decision]", "Done [end]", "Check > Done: yes"));
  expect(copyLines(docOf(FLOW), ["Request in"])).toBe(lines("Request in [start]"));
});

test("a copy keeps a line's colour, a preset or a hex", () => {
  const coloured = lines('diagram flow "C"', "A", "B", "C", "A > B: go [color: danger]", 'B > C [color: "#3b82f6"]');
  const clip = copyLines(docOf(coloured), ["A", "B", "C"]);
  expect(clip).toBe(lines("A", "B", "C", "A > B: go [color: danger]", 'B > C [color: "#3b82f6"]'));
  expect(docOf(paste(coloured, clip)!.text).links.map((l) => l.color)).toEqual(["danger", "#3b82f6", "danger", "#3b82f6"]);
});

test("a paste writes the shapes with free names after the last shape, and their lines with the others", () => {
  const r = paste(FLOW, lines("Check [decision]", "Done [end]", "Check > Done: yes"))!;
  expect(r.text).toBe(
    lines('diagram flow "Refund"', "", "Request in [start]", "Check [decision]", "Done [end]", "Check 2 [decision]", "Done 2 [end]", "", "Request in > Check", "Check > Done: yes", "Check 2 > Done 2: yes"),
  );
  expect(r.names).toEqual({ Check: "Check 2", Done: "Done 2" });
});

test("a free name counts on from a number the name already has", () => {
  const text = lines('diagram flow "F"', "Step", "Step 2");
  expect(paste(text, lines("Step 2"))!.names).toEqual({ "Step 2": "Step 3" });
  expect(paste(text, lines("Fresh"))!.names).toEqual({ Fresh: "Fresh" });
});

test("text that is not lines of this kind of diagram is refused and never written", () => {
  expect(paste(FLOW, "SELECT * FROM users WHERE id > 1")).toBeNull();
  expect(paste(FLOW, "{ \"a\": [1, 2] }")).toBeNull();
  expect(paste(FLOW, "")).toBeNull();
  expect(paste(FLOW, lines("A > Nowhere"))).toBeNull();
  expect(paste(FLOW, lines("A [process, id: 1.0]"))).toBeNull();
  // A whole file of another kind is refused; a whole file of this kind pastes its shapes.
  expect(paste(FLOW, lines('diagram sequence "S"', "participant App"))).toBeNull();
  expect(paste(FLOW, lines('diagram flow "Other"', "Ship"))!.names).toEqual({ Ship: "Ship" });
  // Plain words are a valid flowchart line: they paste as a shape with those words, and nothing else happens.
  expect(paste(FLOW, "Call the bank")!.text).toBe(FLOW.replace("Done [end]\n", "Done [end]\nCall the bank\n"));
});

test("data flow: a pasted process and store take the next free ids", () => {
  const dfd = lines('diagram dfd "D"', "Customer [entity]", "Checkout [process, id: 1.0]", "Orders [store, id: D1]", "", "Customer > Checkout: order");
  const clip = copyLines(docOf(dfd), ["Customer", "Checkout", "Orders"]);
  expect(clip).toBe(lines("Customer [entity]", "Checkout [process, id: 1.0]", "Orders [store, id: D1]", "Customer > Checkout: order"));
  expect(paste(dfd, clip)!.text).toBe(
    lines(
      'diagram dfd "D"',
      "Customer [entity]",
      "Checkout [process, id: 1.0]",
      "Orders [store, id: D1]",
      "Customer 2 [entity]",
      "Checkout 2 [process, id: 2.0]",
      "Orders 2 [store, id: D2]",
      "",
      "Customer > Checkout: order",
      "Customer 2 > Checkout 2: order",
    ),
  );
});

test("ER: a table comes with its columns and keys, and the relationship between copied tables", () => {
  const er = lines('diagram er "Billing"', "customers {", "  id int pk", "  email text not null // login", "}", "invoices", "", "customers < invoices: bills");
  const clip = copyLines(docOf(er), ["customers", "invoices"]);
  expect(clip).toBe(lines("customers {", "  id int pk", "  email text not null // login", "}", "invoices", "customers < invoices: bills"));
  const r = paste(er, clip)!;
  expect(r.text).toBe(
    lines(
      'diagram er "Billing"',
      "customers {",
      "  id int pk",
      "  email text not null // login",
      "}",
      "invoices",
      "customers_2 {",
      "  id int pk",
      "  email text not null // login",
      "}",
      "invoices_2",
      "",
      "customers < invoices: bills",
      "customers_2 < invoices_2: bills",
    ),
  );
  expect(r.names).toEqual({ customers: "customers_2", invoices: "invoices_2" });
});

test("ER: a paste goes after the last table's }", () => {
  const er = lines('diagram er "Shop"', "orders {", "  id int pk", "}", "// tables end here");
  expect(paste(er, lines("refunds"))!.text).toBe(lines('diagram er "Shop"', "orders {", "  id int pk", "}", "refunds", "// tables end here"));
});

test("ER: a copy's free name is SQL-friendly: orders_2, then orders_3, and on from orders_2", () => {
  const er = lines('diagram er "Shop"', "orders {", "  id int pk", "}", "orders_2 {", "  id int", "}");
  const r = paste(er, lines("orders {", "  id int pk", "}"))!;
  expect(r.names).toEqual({ orders: "orders_3" });
  expect(r.text).toContain("orders_3 {\n  id int pk\n}\n");
  expect(paste(er, lines("orders_2 {", "  id int", "}"))!.names).toEqual({ orders_2: "orders_3" });
});

test("class: a type comes with its members", () => {
  const cls = lines('diagram class "Types"', "interface Payable", "Payable : pay(amount)", "class Invoice", "Invoice : + total: numeric", "Payable <|-- Invoice");
  const clip = copyLines(docOf(cls), ["Payable", "Invoice"]);
  expect(clip).toBe(lines("interface Payable", "Payable : pay(amount)", "class Invoice", "Invoice : + total: numeric", "Payable <|-- Invoice"));
  expect(paste(cls, clip)!.text).toBe(
    lines(
      'diagram class "Types"',
      "interface Payable",
      "Payable : pay(amount)",
      "class Invoice",
      "Invoice : + total: numeric",
      "interface Payable 2",
      "Payable 2 : pay(amount)",
      "class Invoice 2",
      "Invoice 2 : + total: numeric",
      "Payable <|-- Invoice",
      "Payable 2 <|-- Invoice 2",
    ),
  );
});

test("sequence: participants go after the participants, their messages at the end", () => {
  const seq = lines('diagram sequence "Pay"', "actor Customer", "participant App", "Customer -> App : Pay", "loop retry {", "  App -> App : check", "}");
  const clip = copyLines(docOf(seq), ["Customer", "App"]);
  expect(clip).toBe(lines("actor Customer", "participant App", "Customer -> App: Pay", "App -> App: check"));
  expect(paste(seq, clip)!.text).toBe(
    lines(
      'diagram sequence "Pay"',
      "actor Customer",
      "participant App",
      "actor Customer 2",
      "participant App 2",
      "Customer -> App : Pay",
      "loop retry {",
      "  App -> App : check",
      "}",
      "Customer 2 -> App 2: Pay",
      "App 2 -> App 2: check",
    ),
  );
});

test("state: the start and end markers stay shared, only the states are new", () => {
  const st = lines('diagram state "Invoice"', "Draft", "Sent", "[*] > Draft", "Draft > Sent : send", "Sent > [*]");
  const clip = copyLines(docOf(st), ["[*] start", "Draft", "Sent"]);
  expect(clip).toBe(lines("Draft", "Sent", "[*] > Draft", "Draft > Sent: send"));
  expect(paste(st, clip)!.text).toBe(lines('diagram state "Invoice"', "Draft", "Sent", "Draft 2", "Sent 2", "[*] > Draft", "Draft > Sent : send", "Sent > [*]", "[*] > Draft 2", "Draft 2 > Sent 2: send"));
});

test("mind map: topics keep their shape; a paste goes under a topic, after one, or under the central idea", () => {
  const mm = lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release");
  const clip = copyLines(docOf(mm), ["Diagrams", "New kinds"]);
  expect(clip).toBe(lines("  Diagrams", "    New kinds"));
  // Nothing chosen: under the central idea, after the last topic.
  expect(paste(mm, clip)!.text).toBe(lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release", "  Diagrams 2", "    New kinds 2"));
  // Under Diagrams: after its own subtopics, one level in.
  expect(paste(mm, clip, { under: "Diagrams" })!.text).toBe(lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Diagrams 2", "      New kinds 2", "  Release"));
  // After Diagrams (a duplicate): its sibling, next to it.
  expect(paste(mm, clip, { after: "Diagrams" })!.text).toBe(lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Diagrams 2", "    New kinds 2", "  Release"));
  // The central idea copied comes back as a topic.
  expect(copyLines(docOf(mm), ["Q4 plan", "Release"])).toBe(lines("  Q4 plan", "    Release"));
});

test("timeline: items keep their dates and go at the end", () => {
  const tl = lines('diagram timeline "2026"', "section Q4", "2026-10-19: Docs ready", "milestone v1.0", "2026-11 to 2026-12: Backup");
  const clip = copyLines(docOf(tl), ["Docs ready", "Backup"]);
  expect(clip).toBe(lines("2026-10-19: Docs ready", "2026-11 to 2026-12: Backup"));
  expect(paste(tl, clip)!.text).toBe(lines('diagram timeline "2026"', "section Q4", "2026-10-19: Docs ready", "milestone v1.0", "2026-11 to 2026-12: Backup", "2026-10-19: Docs ready 2", "2026-11 to 2026-12: Backup 2"));
});

test("cloud: a service keeps its icon; shapes in a group paste outside it", () => {
  const cloud = lines('diagram cloud "API"', "Users [icon: users]", "", "VPC {", "  API [icon: aws-api-gateway]", "}", "", "Users > API: HTTPS");
  const clip = copyLines(docOf(cloud), ["Users", "API"]);
  expect(clip).toBe(lines("Users [icon: users]", "API [icon: aws-api-gateway]", "Users > API: HTTPS"));
  expect(paste(cloud, clip)!.text).toBe(
    lines('diagram cloud "API"', "Users [icon: users]", "Users 2 [icon: users]", "API 2 [icon: aws-api-gateway]", "", "VPC {", "  API [icon: aws-api-gateway]", "}", "", "Users > API: HTTPS", "Users 2 > API 2: HTTPS"),
  );
});

// ---- Fix round 1

/** Why a paste of `clip` into `text` was refused, or the note a paste that went through gives. */
const noteOf = (text: string, clip: string, place?: Parameters<typeof pasteLines>[3]) => pasteLines(text, parseFlow(text), clip, place).note;

test("C1 a paste over 1 MB of text is refused with a note naming the limit", () => {
  const big = "Step\n".repeat(220_000);
  expect(big.length).toBeGreaterThan(1024 * 1024);
  const r = pasteLines(FLOW, parseFlow(FLOW), big);
  expect(r.edits).toEqual([]);
  expect(r.note).toBe("The clipboard text is larger than 1 MB, so nothing was pasted.");
});

test("C1 a paste that would make the diagram hold more than 2,000 shapes is refused; exactly 2,000 is fine", () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `S${i + from}`).join("\n");
  const text = lines('diagram flow "Big"', many(1997));
  // 3 shapes here now; 1,997 + 3 = 2,000.
  expect(paste(text, many(3, 5000))!.names).toEqual({ S5000: "S5000", S5001: "S5001", S5002: "S5002" });
  const r = pasteLines(text, parseFlow(text), many(4, 5000));
  expect(r.edits).toEqual([]);
  expect(r.note).toBe("Pasting 4 shapes would make 2,001 shapes, and a diagram holds at most 2,000, so nothing was pasted.");
});

test("M2 a refusal says why in plain words", () => {
  expect(noteOf(FLOW, lines("Ship [end]", "Check > Ship"))).toBe("Line 2 names Check, which is not one of the pasted shapes, so nothing was pasted.");
  expect(noteOf(FLOW, lines('diagram sequence "S"', "participant App"))).toBe("The clipboard holds a sequence diagram, not a flowchart, so nothing was pasted.");
  expect(noteOf(FLOW, lines("A [process]"))).toMatch(/^The clipboard does not hold flowchart lines \(line 1: .+\), so nothing was pasted\.$/);
  expect(noteOf(FLOW, "   ")).toBe("The clipboard has no text to paste.");
});

test("M9 a first line that only starts with the word diagram is read as a line, not as a whole file", () => {
  expect(paste(FLOW, "diagram cleanup")?.names).toEqual({ "diagram cleanup": "diagram cleanup" });
});

test("M4 groups and frames are not pasted yet, and the paste says so", () => {
  expect(noteOf(FLOW, lines("Box {", "  Inside", "}"))).toBe("Groups are not pasted yet, only the shapes in them.");
  expect(paste(FLOW, lines("Box {", "  Inside", "}"))!.names).toEqual({ Inside: "Inside" });
  const seq = lines('diagram sequence "S"', "participant App");
  expect(noteOf(seq, lines("participant Api", "loop retry {", "  Api -> Api : check", "}"))).toBe("Frames are not pasted yet, only the messages in them.");
  expect(noteOf(FLOW, lines("Ship"))).toBeUndefined();
});

test("I5 a pasted note goes after every note there is, so no note is renumbered, and gets the next free note name", () => {
  const text = lines('diagram flow "N"', "A", "note: first", "", "G {", "  B", "  note: in group", "}", "", "A > B");
  const r = paste(text, lines("note: copy"))!;
  expect(r.text).toBe(lines('diagram flow "N"', "A", "note: first", "", "G {", "  B", "  note: in group", "}", "note: copy", "", "A > B"));
  expect(r.names).toEqual({ "Note 1": "Note 3" });
  const notes = docOf(r.text).nodes.filter((n) => n.kind === "note").map((n) => [n.name, n.text]);
  expect(notes.sort()).toEqual([
    ["Note 1", "first"],
    ["Note 2", "in group"],
    ["Note 3", "copy"],
  ]);
  // With no note there yet, it goes with the shapes.
  expect(paste(FLOW, lines("Ship", "note: why"))!.text).toBe(FLOW.replace("Done [end]\n", "Done [end]\nShip\nnote: why\n"));
});

// ---- Fix round 2

test("O3 more than 2,000 non-empty lines are refused before any parse", () => {
  const text = lines('diagram flow "F"', "A");
  const many = Array.from({ length: 2001 }, (_, i) => `S${i}`).join("\n\n");
  expect(pasteLines(text, parseFlow(text), many)).toEqual({ edits: [], names: {}, note: "The clipboard text has more than 2,000 lines, so nothing was pasted." });
  // Blank lines do not count: 2,000 lines with blanks between them still paste.
  expect(paste(text, Array.from({ length: 1999 }, (_, i) => `S${i}`).join("\n\n"))).not.toBeNull();
});

// One rule for an ER table's free name, wherever it is made.
test("ER free names: _2, _3 on the original name, a number the app did not add is kept, and SQL's case-insensitive names collide", () => {
  expect(sqlFreeName("orders", ["orders"])).toBe("orders_2");
  expect(sqlFreeName("orders", ["orders", "orders_2"])).toBe("orders_3");
  // orders_2 exists because orders does: its copy counts on.
  expect(sqlFreeName("orders_2", ["orders", "orders_2"])).toBe("orders_3");
  // A year is part of the name: never log_2025.
  expect(sqlFreeName("log_2024", ["log_2024"])).toBe("log_2024_2");
  // Orders_2 and orders_2 are one name in SQL.
  expect(sqlFreeName("orders", ["orders", "Orders_2"])).toBe("orders_3");
  expect(sqlFreeName("Orders", ["orders"])).toBe("Orders_2");
  expect(sqlFreeName("fresh", ["orders"])).toBe("fresh");
  const er = lines('diagram er "Shop"', "log_2024 {", "  id int pk", "}");
  expect(paste(er, lines("log_2024 {", "  id int pk", "}"))!.names).toEqual({ log_2024: "log_2024_2" });
});
