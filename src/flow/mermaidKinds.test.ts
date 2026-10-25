// Diagram step 10 (F28, board DiagramStartWell): each Mermaid kind comes in as its Contura kind, one way. The samples
// are real Mermaid (mermaid.js.org syntax pages); each test checks the exact .flow text, what is not carried over and
// why, and the lines refused with their reasons. Everything written parses back with no error.
import { describe, expect, test } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { isMermaid, mermaidToFlow } from "./mermaid";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const clean = (flow: string) => expect(parseFlow(flow).problems.filter((p) => p.severity === "error")).toEqual([]);

const CHECKOUT = lines(
  "sequenceDiagram",
  "    title Checkout",
  "    autonumber",
  "    actor C as Customer",
  "    participant S as Shop",
  "    participant P as Payments",
  "    C->>S: place order",
  "    S->>+P: charge card",
  "    P-->>-S: approved",
  "    loop every item",
  "        S->>S: reserve stock",
  "    end",
  "    Note right of P: Card data stays at the bank",
  "    S-->>C: receipt",
);

describe("sequenceDiagram", () => {
  test("participants, actors, messages, replies, a loop and a note; autonumber and the activation marks are left out", () => {
    const r = mermaidToFlow(CHECKOUT, "Untitled");
    expect(r.kind).toBe("sequence");
    expect(r.flow).toBe(
      lines(
        'diagram sequence "Checkout"',
        "actor Customer",
        "participant Shop",
        "participant Payments",
        "note: Card data stays at the bank",
        "Customer -> Shop: place order",
        "Shop -> Payments: charge card",
        "Payments --> Shop: approved",
        "loop every item {",
        "  Shop -> Shop: reserve stock",
        "}",
        "Shop --> Customer: receipt",
      ),
    );
    expect(r.notes.map((n) => n.text)).toEqual([
      "Line 3: autonumber is left out: Contura does not number messages.",
      "Line 8: the + activation mark is left out; use activate to start one.",
      "Line 9: the - activation mark is left out; use activate to start one.",
    ]);
    expect(r.errors).toEqual([]);
    expect(r.count).toBe("Sequence: 3 participants, 5 messages");
    clean(r.flow);
  });

  test("activate and deactivate come in; alt keeps its messages without the frame; a line it cannot read says how to write one", () => {
    const r = mermaidToFlow(
      lines("sequenceDiagram", "    Alice->>John: Hello", "    activate John", "    alt is sick", "        John-->>Alice: Not so good", "    else is well", "        John-->>Alice: Fine", "    end", "    deactivate John", "    Shop ->>"),
      "Hi",
    );
    expect(r.flow).toBe(
      lines('diagram sequence "Hi"', "Alice -> John: Hello", "activate John", "John --> Alice: Not so good", "John --> Alice: Fine", "deactivate John"),
    );
    expect(r.notes.map((n) => n.text)).toEqual(["Line 4: alt is not a Contura frame; its messages come in without it."]);
    expect(r.errors.map((n) => n.text)).toEqual(["Line 10: cannot read Shop ->>. A message is written A->>B: text."]);
  });
});

describe("stateDiagram", () => {
  const INVOICE = lines(
    "stateDiagram-v2",
    "    state Open {",
    "        Sent --> Overdue : due date passes",
    "        Overdue --> Sent : reminder",
    "    }",
    "    [*] --> Draft",
    "    Draft --> Sent : send",
    "    Sent --> Paid : payment",
    "    Overdue --> Paid : payment",
    "    Paid --> [*]",
    "    classDef late fill:#f96",
  );

  test("a composite becomes a group and [*] the start and end markers", () => {
    const r = mermaidToFlow(INVOICE, "Invoice");
    expect(r.kind).toBe("state");
    expect(r.flow).toBe(
      lines(
        'diagram state "Invoice"',
        "",
        "Draft",
        "Paid",
        "",
        "Open {",
        "  Sent",
        "  Overdue",
        "}",
        "",
        "Sent > Overdue: due date passes",
        "Overdue > Sent: reminder",
        "[*] > Draft",
        "Draft > Sent: send",
        "Sent > Paid: payment",
        "Overdue > Paid: payment",
        "Paid > [*]",
      ),
    );
    expect(r.notes.map((n) => n.text)).toEqual(["Line 11: classDef is left out: Contura draws with its theme."]);
    expect(r.count).toBe("State: 4 states, 7 transitions");
    clean(r.flow);
  });

  test("a choice, a fork, a named state and a note", () => {
    const r = mermaidToFlow(
      lines("stateDiagram-v2", '    state "Waiting for payment" as Wait', "    state Check <<choice>>", "    state Split <<fork>>", "    Wait --> Check", "    Check --> Split : paid", "    note right of Wait : Reminders go out daily"),
      "Pay",
    );
    expect(r.flow).toBe(lines('diagram state "Pay"', "", "Waiting for payment", "Check [choice]", "Split [fork]", "note: Reminders go out daily", "", "Waiting for payment > Check", "Check > Split: paid"));
    clean(r.flow);
  });

  test("a transition it cannot read says how one is written", () => {
    const r = mermaidToFlow(lines("stateDiagram-v2", "    A --> B", "    A -> B"), "S");
    expect(r.errors.map((e) => e.text)).toEqual(["Line 3: cannot read A -> B. A transition is written A --> B : event."]);
  });
});

describe("classDiagram", () => {
  const BILLING = lines(
    "classDiagram",
    "    class Invoice {",
    "        +int id",
    "        +numeric total",
    "        +send()",
    "    }",
    "    class Payable {",
    "        <<interface>>",
    "        +pay(amount)",
    "    }",
    "    Payable <|.. Invoice",
    '    Invoice "1" *-- "many" LineItem : lines',
    "    Invoice --> InvoiceStatus",
    "    class InvoiceStatus {",
    "        <<enumeration>>",
    "        DRAFT",
    "        SENT",
    "        PAID",
    "    }",
  );

  test("interfaces and enums by their mark, members rewritten, a realization as inheritance; multiplicities left out", () => {
    const r = mermaidToFlow(BILLING, "Billing");
    expect(r.kind).toBe("class");
    expect(r.flow).toBe(
      lines(
        'diagram class "Billing"',
        "",
        "class Invoice",
        "Invoice : + id: int",
        "Invoice : + total: numeric",
        "Invoice : + send()",
        "interface Payable",
        "Payable : + pay(amount)",
        "class LineItem",
        "enum InvoiceStatus",
        "InvoiceStatus : DRAFT",
        "InvoiceStatus : SENT",
        "InvoiceStatus : PAID",
        "",
        "Payable <|-- Invoice",
        "Invoice *-- LineItem: lines",
        "Invoice --> InvoiceStatus",
      ),
    );
    expect(r.notes.map((n) => n.text)).toEqual(["Line 11: the realization <|.. became inheritance <|--.", 'Line 12: the multiplicities "1" and "many" are left out.']);
    expect(r.count).toBe("Class: 4 classes, 3 relationships");
    clean(r.flow);
  });

  test("A --|> B is written parent first; a member line by name; aggregation becomes an association", () => {
    const r = mermaidToFlow(lines("classDiagram", "    Dog --|> Animal", "    Animal : +String name", "    Zoo o-- Animal"), "Zoo");
    expect(r.flow).toBe(lines('diagram class "Zoo"', "", "class Dog", "class Animal", "Animal : + name: String", "class Zoo", "", "Animal <|-- Dog", "Zoo -- Animal"));
    expect(r.notes.map((n) => n.text)).toEqual(["Line 4: the aggregation o-- became an association --."]);
  });
});

describe("mindmap", () => {
  test("the root is the central idea, indents are levels; shapes and icons are left out", () => {
    const r = mermaidToFlow(lines("mindmap", "  root((Q4 plan))", "    Diagrams", "      New kinds", "      Inline editing", "    Redis", "      ::icon(fa fa-database)", "    Release", "      Docs"), "Untitled");
    expect(r.kind).toBe("mindmap");
    expect(r.flow).toBe(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Redis", "  Release", "    Docs"));
    expect(r.notes.map((n) => n.text)).toEqual(["Line 2: the shape (( )) of Q4 plan is left out: topics are drawn one way.", "Line 7: the icon is left out."]);
    expect(r.count).toBe("Mind map: 7 topics");
    clean(r.flow);
  });

  test("a second central idea is refused", () => {
    const r = mermaidToFlow(lines("mindmap", "  Plan", "    A", "  Other"), "M");
    expect(r.errors.map((e) => e.text)).toEqual(["Line 4: Other sits beside the central idea; a mind map has one."]);
  });
});

describe("timeline", () => {
  test("sections and dated events; a month is dated its first day; a period with no date is refused", () => {
    const r = mermaidToFlow(
      lines("timeline", "    title Release 1.0", "    section Build", "        2026-09-01 : Alpha", "        2026-10-19 : Beta", "    section Ship", "        2026-11 : Release candidate", "        2026-12-01 : Launch"),
      "Untitled",
    );
    expect(r.kind).toBe("timeline");
    expect(r.flow).toBe(lines('diagram timeline "Release 1.0"', "section Build", "2026-09-01: Alpha", "2026-10-19: Beta", "section Ship", "2026-11-01: Release candidate", "2026-12-01: Launch"));
    expect(r.notes.map((n) => n.text)).toEqual(["Line 7: 2026-11 is dated 2026-11-01."]);
    expect(r.count).toBe("Timeline: 4 items");
    clean(r.flow);
    const q = mermaidToFlow(lines("timeline", "    Q3 : Beta", "    2026-10-19 : Docs : Site"), "T");
    expect(q.errors.map((e) => e.text)).toEqual(["Line 2: Q3 is not a date. A Contura timeline needs one, such as 2026-10-19 : Beta."]);
    expect(q.flow).toBe(lines('diagram timeline "T"', "2026-10-19: Docs", "2026-10-19: Site"));
  });
});

describe("refused kinds", () => {
  test("a Mermaid kind Contura has none of is refused by name", () => {
    const r = mermaidToFlow(lines("pie title Pets", '    "Dogs" : 386'), "P");
    expect(r.errors.map((e) => e.text)).toEqual(["Line 1: Contura has no pie kind. The Mermaid diagrams that come in are flowchart, sequence, state, class, mindmap and timeline."]);
    expect(r.nodes).toBe(0);
  });

  test("an ER diagram goes to the Schema Builder", () => {
    const r = mermaidToFlow(lines("erDiagram", "    CUSTOMER ||--o{ ORDER : places"), "S");
    expect(r.errors.map((e) => e.text)).toEqual(["ER diagrams live in the Schema Builder. Open the Schema Builder to model tables."]);
    expect(r.nodes).toBe(0);
  });
});

test("isMermaid: the first line that is not blank or a comment starts a Mermaid diagram Contura reads", () => {
  expect(isMermaid("\n%% hi\nflowchart LR\n A --> B")).toBe(true);
  expect(isMermaid("graph TD;A-->B")).toBe(true);
  expect(isMermaid("sequenceDiagram\n  A->>B: hi")).toBe(true);
  expect(isMermaid("stateDiagram\n  A --> B")).toBe(true);
  expect(isMermaid("stateDiagram-v2\n  A --> B")).toBe(true);
  expect(isMermaid("classDiagram\n  class A")).toBe(true);
  expect(isMermaid("mindmap\n  root")).toBe(true);
  expect(isMermaid("timeline\n  2026 : A")).toBe(true);
  expect(isMermaid("erDiagram\n  A ||--o{ B : x")).toBe(true);
  expect(isMermaid('diagram flow "x"\nA')).toBe(false);
  expect(isMermaid("A > B")).toBe(false);
  expect(isMermaid("graphs are fun")).toBe(false);
  expect(isMermaid("pie title x")).toBe(false);
});

test("keepUnread: each line it cannot read is kept as a // comment holding the line itself and its reason, in every kind", () => {
  const kept = (text: string) => mermaidToFlow(text, "K", { keepUnread: true }).flow.split("\n").filter((l) => l.startsWith("//"));
  expect(mermaidToFlow(lines("sequenceDiagram", "    A->>B: hi", "    Shop ->>"), "K", { keepUnread: true }).flow).toBe(
    lines('diagram sequence "K"', "// Shop ->>  // cannot read Shop ->>. A message is written A->>B: text.", "A -> B: hi"),
  );
  expect(kept(lines("flowchart LR", "    A --> B", "    D -> B"))).toEqual(["// D -> B  // cannot read the link D -> B. Mermaid links are -->, ---, -.-> or ==>."]);
  expect(kept(lines("stateDiagram-v2", "    A --> B", "    A -> B"))).toEqual(["// A -> B  // cannot read A -> B. A transition is written A --> B : event."]);
  expect(kept(lines("classDiagram", "    class A", "    A ~~ B"))).toEqual(["// A ~~ B  // cannot read A ~~ B. A relationship is written A <|-- B."]);
  expect(kept(lines("mindmap", "  Plan", "    A", "  Other"))).toEqual(["// Other  // Other sits beside the central idea; a mind map has one."]);
  expect(kept(lines("timeline", "    2004 : Facebook", "    Q3 2006 : Twitter"))).toEqual(["// Q3 2006 : Twitter  // Q3 2006 is not a date. A Contura timeline needs one, such as 2026-10-19 : Beta."]);
  for (const t of [lines("timeline", "    Q3 2006 : Twitter"), lines("mindmap", "  Plan", "  Other")]) {
    const flow = mermaidToFlow(t, "K", { keepUnread: true }).flow;
    expect(parseFlow(flow).problems.filter((p) => p.severity === "error")).toEqual([]);
  }
});

test("fix round 1, M1 and M2: a kind word alone is not Mermaid; a multi-line %%{ }%% directive is skipped", () => {
  for (const w of ["graph", "timeline", "mindmap", "classDiagram", "sequenceDiagram\n", "  stateDiagram-v2  \n\n"]) expect(isMermaid(w), w).toBe(false);
  expect(isMermaid("timeline\n    2004 : Facebook")).toBe(true);
  expect(isMermaid(lines("%%{", "  init: { 'theme': 'dark' }", "}%%", "sequenceDiagram", "    A->>B: hi"))).toBe(true);
  const r = mermaidToFlow(lines("%%{", "  init: { 'theme': 'dark' }", "}%%", "sequenceDiagram", "    A->>B: hi"), "D");
  expect(r.kind).toBe("sequence");
  expect(r.errors).toEqual([]);
});

test("fix round 1, M2: a flowchart after a multi-line directive reads too", () => {
  const r = mermaidToFlow(lines("%%{", "  init: { 'theme': 'dark' }", "}%%", "flowchart LR", "    A --> B"), "D");
  expect(r.errors).toEqual([]);
  expect(r.nodes).toBe(2);
});

describe("fix round 1, I4: stateDiagram composites (the Mermaid docs samples)", () => {
  test("a composite named in a transition before its block is the same composite, with its own start and end", () => {
    const r = mermaidToFlow(
      lines("stateDiagram-v2", "    [*] --> Active", "", "    state Active {", "        [*] --> NumLockOff", "        NumLockOff --> NumLockOn : EvNumLockPressed", "        NumLockOn --> NumLockOff : EvNumLockPressed", "    }"),
      "Keys",
    );
    expect(r.flow).toBe(
      lines('diagram state "Keys"', "", "Active {", "  NumLockOff", "  NumLockOn", "  [*] > NumLockOff", "}", "", "[*] > Active", "NumLockOff > NumLockOn: EvNumLockPressed", "NumLockOn > NumLockOff: EvNumLockPressed"),
    );
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.count).toBe("State: 2 states, 4 transitions");
    clean(r.flow);
    const doc = parseFlow(r.flow).doc!;
    expect(doc.groups).toEqual([{ name: "Active", nodes: ["NumLockOff", "NumLockOn", "[*] start in Active"], groups: [] }]);
  });

  test("the docs' simple composite", () => {
    const r = mermaidToFlow(lines("stateDiagram-v2", "    [*] --> First", "    state First {", "        [*] --> second", "        second --> [*]", "    }"), "S");
    expect(r.flow).toBe(lines('diagram state "S"', "", "First {", "  second", "  [*] > second", "  second > [*]", "}", "", "[*] > First"));
    clean(r.flow);
  });

  test("the docs' nested composites, three deep, each with its own markers", () => {
    const r = mermaidToFlow(
      lines(
        "stateDiagram-v2",
        "    [*] --> First",
        "    state First {",
        "        [*] --> Second",
        "        state Second {",
        "            [*] --> second",
        "            second --> Third",
        "            state Third {",
        "                [*] --> third",
        "                third --> [*]",
        "            }",
        "        }",
        "    }",
      ),
      "N",
    );
    expect(r.flow).toBe(
      lines(
        'diagram state "N"',
        "",
        "First {",
        "  [*] > Second",
        "",
        "  Second {",
        "    second",
        "    [*] > second",
        "",
        "    Third {",
        "      third",
        "      [*] > third",
        "      third > [*]",
        "    }",
        "  }",
        "}",
        "",
        "[*] > First",
        "second > Third",
      ),
    );
    expect(r.errors).toEqual([]);
    clean(r.flow);
    const doc = parseFlow(r.flow).doc!;
    expect(doc.nodes.filter((n) => n.kind === "start").map((n) => n.name)).toEqual(["[*] start", "[*] start in First", "[*] start in Second", "[*] start in Third"]);
  });

  test("the docs' transitions between composites", () => {
    const r = mermaidToFlow(
      lines(
        "stateDiagram-v2",
        "    [*] --> First",
        "    First --> Second",
        "    First --> Third",
        "",
        "    state First {",
        "        [*] --> fir",
        "        fir --> [*]",
        "    }",
        "    state Second {",
        "        [*] --> sec",
        "        sec --> [*]",
        "    }",
        "    state Third {",
        "        [*] --> thi",
        "        thi --> [*]",
        "    }",
      ),
      "T",
    );
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.flow).toBe(
      lines(
        'diagram state "T"',
        "",
        "First {",
        "  fir",
        "  [*] > fir",
        "  fir > [*]",
        "}",
        "",
        "Second {",
        "  sec",
        "  [*] > sec",
        "  sec > [*]",
        "}",
        "",
        "Third {",
        "  thi",
        "  [*] > thi",
        "  thi > [*]",
        "}",
        "",
        "[*] > First",
        "First > Second",
        "First > Third",
      ),
    );
    clean(r.flow);
  });

  test("the docs' concurrency: the -- that splits a composite is kept as a comment with its reason, never merged silently", () => {
    const r = mermaidToFlow(
      lines("stateDiagram-v2", "    [*] --> Active", "    state Active {", "        [*] --> NumLockOff", "        NumLockOff --> NumLockOn : EvNumLockPressed", "        --", "        [*] --> CapsLockOff", "        CapsLockOff --> CapsLockOn : EvCapsLockPressed", "    }"),
      "C",
    );
    expect(r.errors.map((e) => e.text)).toEqual(["Line 6: the -- that splits Active into parallel parts is not a Contura composite. Its parts come in as one composite."]);
    const kept = mermaidToFlow(
      lines("stateDiagram-v2", "    state Active {", "        [*] --> NumLockOff", "        --", "        [*] --> CapsLockOff", "    }"),
      "C",
      { keepUnread: true },
    );
    expect(kept.flow).toContain("// --  // the -- that splits Active into parallel parts is not a Contura composite. Its parts come in as one composite.");
    clean(kept.flow);
  });
});

test("fix round 1, M5: a mind map topic named twice comes in with a number, and says so", () => {
  const r = mermaidToFlow(lines("mindmap", "  root((Plan))", "    Research", "      Notes", "    Build", "      Research"), "M");
  expect(r.flow).toBe(lines('diagram mindmap "Plan"', "root Plan", "  Research", "    Notes", "  Build", "    Research 2 [label: Research]"));
  expect(r.notes.map((n) => n.text)).toContain("Line 6: two topics show Research. This one comes in as Research 2 with label: Research, so it shows the same words.");
});

test("fix round 1, M11: Mermaid v10 sequence lines come in or are noted, never blocking Create", () => {
  const r = mermaidToFlow(
    lines(
      "sequenceDiagram",
      "    accTitle: Checkout",
      "    accDescr: How an order is paid",
      "    participant Shop",
      "    create participant Bank",
      "    Shop->>Bank: open account",
      "    destroy Bank",
      "    Bank-->>Shop: closed",
      "    link Shop: Site @ https://example.com",
      "    links Shop: {\"Repo\": \"https://example.com\"}",
      "    create actor Clerk",
      "    Shop->>Clerk: hello",
    ),
    "S",
  );
  expect(r.errors).toEqual([]);
  expect(r.flow).toBe(lines('diagram sequence "S"', "participant Shop", "participant Bank", "actor Clerk", "Shop -> Bank: open account", "Bank --> Shop: closed", "Shop -> Clerk: hello"));
  expect(r.notes.map((n) => n.text)).toEqual([
    "Line 2: accTitle is left out.",
    "Line 3: accDescr is left out.",
    "Line 5: create is left out: Bank is drawn from the start.",
    "Line 7: destroy is left out: Bank stays to the end.",
    "Line 9: link is left out: participants do not open links.",
    "Line 10: links is left out: participants do not open links.",
    "Line 11: create is left out: Clerk is drawn from the start.",
  ]);
});
