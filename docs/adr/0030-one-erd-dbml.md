# One ERD: DBML

**Status:** Superseded for diagrams by ADR 0031 (2026-10-25). DBML and the Schema Builder stay as this ADR describes; its "Moves to 1.1" list stands.

Originally accepted 2026-10-25 (user decision: "we should only use dbml for erd, throw away the diagram erd").

## Context

Contura had two ways to draw tables. The Schema Builder (step 5) writes a Schema Model as DBML, draws it on the diagram engine, exports SQL and applies it to a Connection through a Sync Script. Step 12 then added an ER kind to the flow language (`diagram er`, ADR 0019), and ER builds A to C grew it into a second table editor: column lines with `[pk, not null, unique]`, cards edited in place, relationships that join columns (`invoices.customer_id *--1 customers.id`), Rails-style key names, a relationship pick by keyboard, weak entities and SQL-friendly free names. The two overlapped almost completely, wrote different files for the same thing, and only the Schema Builder could become SQL or reach a database.

## Decision

DBML is the only ERD. The `er` kind leaves the flow language: the parser, model, writer and edits, completion, clipboard, problems and their quick fixes, the canvas (ER card, column rows and ports, relationships by column, ER menus, weak entities), the New diagram sheet, the Shapes list, the toolbar, Publish, the diagram listing and the assistant. `diagram er` now reads like any unknown kind, and no kind list, completion or fix names it. Mermaid `erDiagram` stays refused with "ER diagrams live in the Schema Builder." (step 10). What other kinds or the Schema Builder share stays: guides, resize, the in-place editor and menus. The SQL-friendly free name (`orders_2`) now lives with the Table Designer's column paste, its only other user.

## Existing files are never stranded

A `.flow` file whose first line is `diagram er` opens read-only in the text pane with the strip "ER diagrams moved to the Schema Builder." and one action, **Open as DBML** (`src/flow/ErMoved.tsx`).

- **The conversion** (`src/flow/erToDbml.ts`) reads the ER text on its own: tables, `table.column type` with `pk`, `not null` and `unique`, and lines with their cardinality. `1--*` and `*--1` become `Ref: many.col > one.col`, `1--1` becomes `-`, `*--*` becomes `<>`. A line that names columns joins them; a line between two whole tables joins the key (the `pk` column, else `id`) and the referring column the ER board would have made (`customers` gives `customer_id`, Rails' singular and underscore). A relationship's name becomes a note on its referring column ("customers places orders"), `[weak]` a note on its table. Nothing is invented: a line with no column to join and a table with no columns stay as DBML comments, a column with no type gets `text`, and the result always parses as DBML. Ids, colours and comments are dropped. Tested on the README's billing schema and the ER builds' own samples.
- **Where it goes.** Nowhere, until the user saves it. The converted DBML opens in the Schema Builder as an unsaved model titled with the diagram's name, after the Dialect question (an ER file names no Dialect). Its first Save asks where to put it, suggesting `<name>.dbml`, as draw.io does after an import; closing it unsaved asks as any unsaved model does. Nothing is written on open, and the `.flow` is never written, renamed or deleted.
- **The guard is unchanged.** Schema Models stay outside Contura's data folder (ADR 0006). Writing the model beside the `.flow` in `<data>\diagrams` was considered and refused: it needed an exception to that guard for a file the user could not find outside Recent.
- The diagram listing names an old ER file's kind `unknown`, so Recent shows it as "Diagram".

## Moves to 1.1: Schema Builder canvas parity

The ER board edited on the card; the Schema Builder edits by double-click on a name or type, a settings popover per column (primary key, increment, not null, unique), the card's Add column, drag from a column's port to another column (a Ref) and the canvas menu's Add table. What the ER board had that the Schema Builder lacks, checked against `src/schema/TableCard.tsx`, `Canvas.tsx` and `src/lang/dbml/edits.ts`:

1. Delete a column, a table or a Ref on the canvas (there is no delete edit; only the text deletes).
2. A right-click menu on a table, a column and a Ref (rename, edit type, insert column above or below, duplicate column, show in the text, delete).
3. Keys on a selected column: F2 and Enter to edit, Ctrl+Enter to duplicate, Delete, K for primary key, N for not null; T to add a table.
4. Double-click on the empty canvas to add a table there, named in place before it is written.
5. Drag from a table onto another table to add the referring key column (`customer_id`, of the key's type, not null) and its Ref in one undo step; "Make a relationship from here" picked by keyboard.
6. A Ref's cardinality and direction changed from its menu, and a Ref's end dragged onto another column.
7. Copy, cut, paste and Ctrl+D of tables with their columns and Refs, and paste of one column line onto a table.

## Consequences

- One table editor to maintain, and the one that reaches SQL and a database.
- About 6,000 lines of ER code and tests leave the flow canvas; the parser's hot path loses its column pass.
- The README lists eight kinds and sends ER diagrams to the Schema Builder; the public site does the same.
- ADR 0019's ER sections (ER builds A to C) are history: this ADR replaces them.
