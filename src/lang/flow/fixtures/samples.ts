// One-diagram .flow texts: one per kind, and edge texts (comments, CRLF, a BOM, nested groups, chains, labels, colours
// and errors). Each is a whole file of one diagram, so a board of it must parse exactly as parseFlow does.
const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

export const KIND_SAMPLES: Record<string, string> = {
  dfd: lines(
    'diagram dfd "Checkout"',
    "Customer [entity]",
    "Checkout [process, id: 1]",
    "Orders [store, id: D1]",
    "Customer > Checkout: order details",
    "Checkout > Orders: new order",
  ),
  flow: lines('diagram flow "Sign in"', "Start [start]", "Valid? [decision]", "Done [end]", "Start > Valid?", "Valid? > Done: yes", "Valid? > Start: no"),
  cloud: lines('diagram cloud "Shop"', "Users [icon: users]", "AWS [icon: aws-cloud] {", "  Receipts [icon: aws-s3]", "}", "Users > Receipts: PUT"),
  sequence: lines(
    'diagram sequence "Pay an invoice"',
    "actor Customer",
    "participant App",
    "Customer -> App : Pay invoice",
    "loop retry 3 times {",
    "  App -> Billing : POST /payments",
    "}",
    "Billing --> App : 201 Created",
  ),
  state: lines('diagram state "Invoice"', "Open {", "  Draft [state]", "  Sent", "}", "[*] > Draft", "Draft > Sent : send", "Sent > [*]"),
  class: lines('diagram class "Billing types"', "interface Payable", "Payable : pay(amount)", "class Invoice", "Invoice : + id: int", "Payable <|-- Invoice"),
  mindmap: lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release", "    v1.0"),
  timeline: lines('diagram timeline "Contura 2026"', "section Q3 2026", "2026-07-14: Table designer", "section Q4 2026", "milestone v1.0", "2026-10-19 : Docs ready"),
};

export const EDGE_SAMPLES: Record<string, string> = {
  comments: lines("// a board's first comment", "", 'diagram flow "A" // the title', "// between", "A > B // a link", "A", "B"),
  crlf: 'diagram flow "A"\r\nA\r\nB\r\nA > B\r\n',
  bom: '\uFEFFdiagram flow "A"\nA\nB\nA > B\n',
  nestedGroups: lines('diagram cloud "Nest"', "Outer {", "  Middle {", "    Inner {", "      Leaf [icon: aws-s3]", "    }", "  }", "}"),
  chains: lines('diagram flow "Chain"', "A", "B", "C", "D", "A > B > C > D: along"),
  labels: lines('diagram flow "Labels"', "Pay [label: Pay the invoice]", "Done", "Pay > Done: when paid"),
  colours: lines('diagram flow "Colours"', "Pay [color: success]", "Fail [color: danger]", "Pay > Fail [color: warning]"),
  errors: lines('diagram flow "Broken"', "A > Missing", "Billing {", "  Pay [color: purple]", "Pay > Pay2"),
  noHeader: lines("A > B"),
  noTitle: lines("diagram state", "Idle > Busy"),
  empty: "",
  noFinalNewline: 'diagram flow "A"\nA > B',
  twice: lines('diagram flow "Twice"', "A", "A", "A > B"),
};

export const SAMPLES: string[] = [...Object.values(KIND_SAMPLES), ...Object.values(EDGE_SAMPLES)];
