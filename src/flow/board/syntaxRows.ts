// Syntax Help's rows: what each kind's syntax does and an example of it, 8 to 12 rows a kind. Every
// example is the language's own: syntaxRows.test.ts reads each one with the parser in its kind, and checks that the
// rows together use every kind word and arrow the kind has. Kind names live in `CARDS`, never here.
import type { DiagramKind } from "../../lang/flow/model";

export interface HelpRow {
  /** What the syntax does, for the Description column. */
  what: string;
  /** The text to write, one code line per line. */
  example: string;
  /** Lines the example needs before it to read clean (the tables a line joins, the class a member is on); never shown. */
  context?: string;
}

const lines = (...ls: string[]) => ls.join("\n");

/** The shapes an example's lines join, each on its own line: a line needs both its ends written. */
const shapes = (...names: string[]) => names.map((n) => `${n}\n`).join("");

/** Each kind's rows, in the order Syntax Help lists them. */
export const SYNTAX_HELP: Record<DiagramKind, HelpRow[]> = {
  flow: [
    { what: "A step", example: "Check stock [step]" },
    { what: "Start and end", example: lines("Cart [start]", "Done [end]") },
    { what: "A decision", example: "Paid? [decision]" },
    { what: "Input or output", example: "Card details [io]" },
    { what: "A subprocess, a document, a database", example: lines("Ship order [subprocess]", "Receipt [document]", "Orders [database]") },
    { what: "An arrow", example: "Cart > Pay", context: shapes("Cart", "Pay") },
    { what: "A labelled arrow", example: "Paid? > Ship: yes", context: shapes("Paid? [decision]", "Ship") },
    { what: "Fan out to several steps", example: "Pack > Ship, Email", context: shapes("Pack", "Ship", "Email") },
    { what: "Both ways, and dashed", example: lines("Pay <> Bank", "Pay --> Audit"), context: shapes("Pay", "Bank", "Audit") },
    { what: "No arrow, and dotted", example: lines("Pay - Bank", "Retry -- Pay"), context: shapes("Pay", "Bank", "Retry") },
    { what: "A group", example: lines("Dispatch {", "  Ship order", "}") },
    { what: "A label and a colour", example: "Cart [label: Your cart, color: success]" },
  ],
  er: [
    { what: "A table", example: "orders" },
    { what: "A table with its columns", example: lines("orders {", "  id int pk", "  total decimal(10, 2)", "}") },
    { what: "Column flags", example: lines("users {", "  id int pk", "  email text not null unique", "}") },
    { what: "A column comment", example: lines("orders {", "  total decimal // in cents", "}") },
    { what: "A weak table", example: lines("order_items [weak] {", "  order_id int", "}") },
    { what: "A label and a colour", example: "orders [entity, label: Orders, color: info]" },
    { what: "Many to one", example: "orders.customer_id > customers.id", context: lines("orders {", "  customer_id int", "}", "customers {", "  id int pk", "}", "") },
    { what: "One to many", example: "customers.id < orders.customer_id", context: lines("orders {", "  customer_id int", "}", "customers {", "  id int pk", "}", "") },
    { what: "One to one", example: "users.id - profiles.user_id", context: lines("users {", "  id int pk", "}", "profiles {", "  user_id int", "}", "") },
    { what: "Many to many", example: "orders.id <> tags.id", context: lines("orders {", "  id int pk", "}", "tags {", "  id int pk", "}", "") },
    {
      what: "A label on a line",
      example: "orders.customer_id > customers.id: placed by",
      context: lines("orders {", "  customer_id int", "}", "customers {", "  id int pk", "}", ""),
    },
    { what: "Tables in a group", example: lines("group Billing {", "  invoices {", "    id int pk", "  }", "}") },
  ],
  sequence: [
    { what: "A participant", example: "participant App" },
    { what: "A person", example: "actor Customer" },
    { what: "A message", example: "Customer -> App: Pay" },
    { what: "A reply (dashed)", example: "App --> Customer: Receipt" },
    { what: "A message to itself", example: "Billing -> Billing: Check fraud" },
    { what: "A participant with an icon and a colour", example: "participant Db [icon: database, color: success]" },
    { what: "Show it as busy", example: lines("activate Billing", "Billing -> Bank: Charge", "deactivate Billing") },
    { what: "A repeated block", example: lines("loop until paid {", "  App -> Billing: Retry", "}") },
    { what: "An optional block", example: lines("opt card saved {", "  App -> Vault: Save card", "}") },
    { what: "Number the messages", example: "autonumber" },
    { what: "At the same time", example: lines("par {", "  App -> Mail: Send", "  App -> Log: Write", "}") },
    { what: "A note", example: "note: Retries stop after 3" },
  ],
  dfd: [
    { what: "An outside party", example: "Customer [entity]" },
    { what: "A process with its number", example: "Checkout [process, id: 1]" },
    { what: "A data store", example: "Orders [store, id: D1]" },
    { what: "A data flow", example: "Customer > Checkout: order details", context: shapes("Customer [entity]", "Checkout [process]") },
    { what: "Both ways", example: "Checkout <> Payments", context: shapes("Checkout [process]", "Payments [process]") },
    { what: "Dashed", example: "Checkout --> Audit", context: shapes("Checkout [process]", "Audit [store]") },
    { what: "No arrow, and dotted", example: lines("Checkout - Orders", "Orders -- Reports"), context: shapes("Checkout [process]", "Orders [store]", "Reports [process]") },
    { what: "A store linked to a table", example: "Orders [store, table: public.orders]" },
    { what: "A group", example: lines("Billing {", "  Checkout [process]", "}") },
    { what: "A label and a colour", example: "Checkout [process, label: Take payment, color: warning]" },
  ],
  cloud: [
    { what: "A service", example: "Api [service]" },
    { what: "A service with an icon", example: "Web [icon: server]" },
    { what: "A group", example: lines("Network {", "  Web [icon: server]", "}") },
    { what: "An arrow with a label", example: "Users > Web: HTTPS", context: shapes("Users", "Web") },
    { what: "Fan out to several services", example: "Web > Api, Cache", context: shapes("Web", "Api", "Cache") },
    { what: "Both ways", example: "Web <> Cache", context: shapes("Web", "Cache") },
    { what: "Dashed", example: "Web --> Logs", context: shapes("Web", "Logs") },
    { what: "Dotted, one way", example: "Web ..> Queue", context: shapes("Web", "Queue") },
    { what: "No arrow, and dotted", example: lines("Web - Db", "Web -- Backup"), context: shapes("Web", "Db", "Backup") },
    { what: "A label and a colour", example: "Db [label: Main database, color: danger]" },
  ],
  state: [
    { what: "A state", example: "Draft [state]" },
    { what: "Start and end", example: lines("[*] > Draft", "Paid > [*]"), context: shapes("Draft", "Paid") },
    { what: "A transition on an event", example: "Draft > Sent: send", context: shapes("Draft", "Sent") },
    { what: "A choice", example: "Paid? [choice]" },
    { what: "A fork", example: "Split [fork]" },
    { what: "Dashed", example: "Sent --> Draft: reopen", context: shapes("Draft", "Sent") },
    { what: "Dotted", example: "Sent -- Archived", context: shapes("Sent", "Archived") },
    { what: "States inside a state", example: lines("Open {", "  Draft", "  Sent", "  [*] > Draft", "  Draft > Sent", "}") },
    { what: "A note", example: "note: Sent waits for payment" },
    { what: "A label and a colour", example: "Overdue [label: Past due, color: danger]" },
  ],
  class: [
    { what: "A class", example: "class Invoice" },
    { what: "An interface", example: "interface Payable" },
    { what: "An enum", example: "enum Status" },
    { what: "A field", example: "Invoice : + id: int", context: "class Invoice\n" },
    { what: "A method", example: "Invoice : + send()", context: "class Invoice\n" },
    { what: "Extends", example: "Document <|-- Invoice", context: "class Document\nclass Invoice\n" },
    { what: "Made of (composition)", example: "Invoice *-- Line", context: "class Invoice\nclass Line\n" },
    { what: "Depends on (dotted)", example: "Invoice ..> Mailer", context: "class Invoice\nclass Mailer\n" },
    { what: "Uses", example: "Invoice --> Customer", context: "class Invoice\nclass Customer\n" },
    { what: "Linked to", example: "Invoice -- Order", context: "class Invoice\nclass Order\n" },
    { what: "A plain line", example: "Invoice - Payment", context: "class Invoice\nclass Payment\n" },
    { what: "A note", example: "note: Totals are in cents" },
  ],
  mindmap: [
    { what: "The idea in the middle", example: "root Q4 plan" },
    { what: "A topic, indented under it", example: lines("root Q4 plan", "  Diagrams") },
    { what: "A subtopic, indented once more", example: lines("root Q4 plan", "  Diagrams", "    New kinds") },
    { what: "An icon", example: "  Release [icon: star]", context: "root Q4 plan\n" },
    { what: "A label and a colour", example: "  Release [label: Ship it, color: success]", context: "root Q4 plan\n" },
    { what: "An arrow across branches", example: "Diagrams > Release", context: "root Q4 plan\n  Diagrams\n  Release\n" },
    { what: "A line across branches, solid or dotted", example: lines("Diagrams - Release", "Diagrams -- Release"), context: "root Q4 plan\n  Diagrams\n  Release\n" },
    { what: "A note", example: "note: Due by December", context: "root Q4 plan\n" },
  ],
  timeline: [
    { what: "An item on a day", example: "2026-10-19: Docs ready" },
    { what: "An item in a month", example: "2026-11: Beta" },
    { what: "An item in a year", example: "2027: Version 2" },
    { what: "A period", example: "2026-09 to 2026-10: Data transfer" },
    { what: "A milestone", example: "milestone v1.0" },
    { what: "A section", example: "section Q4 2026" },
    { what: "Items in a section", example: lines("section Q3 2026", "2026-07-14: Table designer", "2026-08-03: Query history") },
    { what: "A comment", example: "// Dates are year, month, day" },
  ],
};
