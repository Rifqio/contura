# Visual Query writes its SQL in the Core, and every diagram runs on one engine

Step 6 adds three things: the Visual Query (tables of one Connection on a canvas, ticked columns, Joins, filters, sorts, run with Ctrl+Enter, saved under Saved Queries), the query diagram (a read-only drawing of the current statement beside a SQL tab or a Visual Query) and the shared diagram engine (`src/diagram/`) that both of them and the Schema Builder now draw with. ADR 0005 keeps a Visual Query within one Connection; this ADR records how it is built.

## How a Visual Query becomes SQL

- **The generator lives in the Core.** `visual_query::generate(kind, server_version, &VisualQuery, &ColumnTypes)` is one pure function per Dialect. The preview pane (`visual_query_sql`), Run (`run_visual_query`), Save and Open in editor all take their text from it, so what the pane shows is what runs and what is saved. It uses the Core's shared quoting (`common::sql_ident`, `sql_string`, and `bare_ident` for names that need no quotes, P1) and the 5a `classify`: the generator refuses its own text unless `classify` reads it as one read statement. A failed check is an `InvalidInput` with a plain sentence (P2), so no new error kind reaches the UI.
- **Check, then write, from one plan.** `check` lists every problem with its target (the query, the Columns, a Join, a table, a filter, a sort) and `generate` refuses with the first one, so Run refuses exactly what the preview flagged (D4). `check` and `generate` share one `plan(vq)`: kept tables, Join kinds after the Left and Right swap, CROSS JOIN groups and tables left out by a pending pick (V2). A Join with no ON pairs that is not pending makes its table a CROSS JOIN.
- **Generation is one way.** SQL is made from the model, never read back into it. Open in editor copies the text into a new SQL tab; editing that text does not change the Visual Query.
- **A Visual Query runs as a Query.** `run_visual_query(session, query, types, pass)` generates the text, then calls `execute_sql` on the tab's own Query Session (ADR 0011), so the 5a verdict, Query History and the paged result are the editor's (D12). There is no new pass scope: the text is always a read, so Production asks nothing and Read-only allows it. The session opens on the model's database, because MySQL tables in the tab's database are written without the database name.
- **Saved in `saved_queries`.** Store schema 4 (migration 4) adds `kind TEXT NOT NULL DEFAULT 'sql'` and `visual_json TEXT` in one transaction. The Connection a saved query opens on stays in the `saved_query_connections` setting map that parity added (D2), so "Connection removed" is a visual row with no map entry. An update keeps `kind` and `visual_json` unless the request sets them, and a change of kind is refused; the UI refuses to save a SQL query over a Visual Query's name or the reverse (V8). A row read without `kind` is `sql` (P14).

## The diagram engine

- **`src/diagram/`** holds the metrics (`CARD_WIDTH` 216, `QUERY_CARD_WIDTH` 200, `RESULT_WIDTH` 268, `cardHeight`), `CardFrame`, `DiagramCanvas`, the edge types and markers, the level of detail, the layout runner and the scene export with the Publish dialog. The Schema Builder, the Visual Query and the query diagram are clients of it.
- **Level of detail.** Below 45 percent zoom every card is a 100 x 48 name box; below 15 percent it is a plain block in its stroke colour. Over 300 nodes the canvas runs in fast mode: name boxes at every zoom, straight edges, no ports, no hover. Only visible nodes render, so 2,000 nodes stay under 300 DOM nodes.
- **Layout runs in the language worker** (D14). `layoutMissing` places only the nodes without a position, with dagre inside the worker; tests without a client call it in process.
- **The query diagram** reads the current statement with the language worker's analysis (`sqlShape`, debounced like diagnostics and sharing the per-document parse cache, D13) and draws table cards and a Result node: the output columns with their source and type, then the clauses. It shows table details only, never rows. It loads the schema of every database the statement names and shows "loading" until it arrives, never "Not in the schema" for a table in another database (V9).
- **Scene export.** Every diagram exports through one scene (`scene.ts`) and `sceneToSvg`, with colours read from the theme tokens; the Publish dialog (whole diagram, what is on screen, or selected nodes, with a crop box) writes PNG or SVG.

## Visible changes to the Schema Builder

Moving the Schema Builder onto the engine changed what it looks like and how it behaves. The reviews kept every change:

- Fit stops at 100 percent zoom, so a small model is not blown up.
- Cards snap to a 16 px grid (DESIGN-NEXT 10.6); the grid hides below 40 percent zoom. Superseded by ADR 0019's guides (ER build B): no card snaps to the grid; the dot grid stays as a backdrop.
- Zoomed out, cards turn into name boxes (below 45 percent) and blocks (below 15 percent).
- The canvas is a tab stop.
- Dragging several selected cards saves the position of every one of them.
- Esc cancels a connection drag.
- Backspace no longer removes a selected card behind the client's back (`deleteKeyCode` is off; removal goes through the client).
- The PNG and SVG export now draws on the canvas background, with orthogonal edges and crow's foot and bar markers, PK and FK tags on columns, the schema as a subtitle and "name as alias" titles. Frames are 8 px taller, matching the canvas cards.

## Rulings from the plan (D1 to D17)

- **D1, card sizes in 6.2.** Query diagram cards are 200 px wide and the Result node 268 px, on the view tokens; CTE and subquery cards get a `derived` chip. Cost: the engine carries three card widths, not one.
- **D2, the saved Connection stays in the setting map.** Migration 4 adds no `connection_id` column. Cost: "opens on" lives apart from the row, as it does for SQL queries.
- **D3, server version without a round trip.** Only SQLite's version matters (RIGHT and FULL need 3.39); the service passes the bundled library's version, so the preview works while the Connection is closed.
- **D4, problems, not only the first error.** Described above.
- **D5, a non-number on a number column is refused** ("total is a number column; 12,5 is not a number."). On any other column every value is text. Cost: a value the server would have cast, such as `1,204` with a thousands separator or a hex `0x1F`, is refused instead of left to the server.
- **D6, table addressing.** `VqTable.schema` is the PostgreSQL schema, or the MySQL database or SQLite attached scope when it differs from the tab's database. `tables[0]` is the root of FROM.
- **D7, the Core names the outputs.** Default names and clash suffixes (`count_id`, `count_id_2`) are Core rules; the Columns panel shows them as placeholders.
- **D8, sorting while grouping.** With an aggregate, a sort on a column that is not an output is a problem on the sort row. V1 extends it to DISTINCT. Cost: a sort MySQL would accept without `ONLY_FULL_GROUP_BY` is refused.
- **D9, keys.** `Ctrl+Shift+E` (Open in editor) and `Ctrl+Shift+D` (diagram) are registry commands; Ctrl+S reuses `query.save`. Ctrl+Enter is handled in the Visual Query tab's own `onKeyDown`, because the registry's `query.run` is scoped to the editor. Cost: Ctrl+Enter in a Visual Query cannot be rebound.
- **D10, New-tab menu.** A chevron beside New query offers New query and New Visual Query.
- **D11, one set of golden cases.** `crates/contura-core/src/visual_query/golden/` holds each model, its SQL per Dialect and a hand-written shape (P5); the Rust tests and the TypeScript shape test read the same files.
- **D12, Run keeps the editor's pass shape.** Described above.
- **D13, `sqlShape` carries the text.** Typing in a SQL tab parses once for diagnostics and the diagram.
- **D14, layout in the language worker.** Described above.
- **D15, drag from the tree.** Table and view rows drag into a Visual Query; a drop from another Connection is refused with "Visual Queries use one Connection. Data Transfer copies between Connections."
- **D16, the CROSS JOIN ask is remembered per tab, in memory.** Each confirmed set of CROSS JOIN tables is not asked about again in that tab. Cost: after a restart, or in a new tab, it asks again.
- **D17, the Core carries no row counts.** The CROSS JOIN dialog fills its counts from the tree's row estimates, so they read "about".

## Rulings taken while building (P1 to P16, V1 to V10)

The pre-flight rulings (P1 to P16) and the build rulings (V1 to V10) are in `.superpowers/sdd/2026-10-18-step6-visual-query/`. The ones that shape behaviour:

- **P9, Foreign Key names and comments.** `SqlFk` gains `name` and `comment`; the Pick popover shows them. SQLite unnamed keys have no name, and only PostgreSQL has comments.
- **P10, a removed Connection.** A Visual Query whose Connection was deleted opens, says "Connection removed" and offers Connections of the model's Dialect.
- **V1, types.** A PostgreSQL array type is text. A NUL character in a value, name or alias is a problem.
- **V2, sorting an output.** An output without its own alias sorts by its expression on every Dialect (SQLite reads a bare output name as ambiguous); an aliased output sorts by its alias.
- **V3, the canvas surface.** `onDragOver` reports the source and the target port, Esc cancels a column drag, the Visual Query connects in loose mode and the Schema Builder in strict mode.
- **V4, the TypeScript model matches the Core plan.** Tables group only through active or pending Joins; Manual GROUP BY entries survive an untick; a table in a database still loading reads "Loading schema"; table nouns follow a rule with an irregular list.
- **V5, sentence case.** The analyzer says "A value is missing after >=."; the 6.2 banner writes "Line 10: a value is missing after >=."
- **V6, every database.** A table from any database the Connection reaches can be dragged in from the tree, and a failed schema load shows "Schema did not load." with Try again.
- **Item 35 (step 12b), drag only.** The "Find a table" finder, its `Ctrl+Shift+A`, the toolbar Add table and the canvas menu's Add table are gone: tables come from the tree by drag and drop (or the tree row's menu), and the tree's filter box finds them.
- **Items 36, 38, 39, 40 (step 12b, board B1), the bottom panel.** Its top edge is a resize handle (a separator: drag, Up and Down keys, double-click resets to 252 px); it keeps at least its 37 px tab strip and leaves the canvas 120 px, and its height is the user's (`vqPanelHeight` in the UI prefs, the same in every tab). Tab counts are badges hidden at 0; "Changed since the last run" shows once, at the end of the tab strip. Columns and Filter and sort are bordered boxes (Group by in the grid's footer bar; Where, Sort, Limit and Distinct side by side). Results has no "Result 1" tab. The canvas hint has its own 28 px strip under the canvas while tables are on it. The SQL tab says "Writing the SQL..." until the Core's text arrives.
- **Items 25, 41, 51 (step 12b, board B2), resizing.** A selected card or diagram node resizes from pointer zones on its edges and corners (no square handles), live: once a frame the node takes the new box in React Flow, so lines follow, and the size is kept when the drag ends (diagram nodes in the `.flow` layout file, 96 to 320 by 44 to 200 px; Visual Query cards in the tab's draft, `widths` and `heights`, 216 to 340 px wide and from two rows up to 480 px high, so every corner resizes both ways; release 1.0: the live box follows the pointer to the sub-pixel, the kept size is whole pixels). A card shorter than its rows scrolls them inside; past 40 rows it draws only those in view and the joined ones. A Join to a column scrolled out of view ends at the card's edge, dashed, on a hollow ring.
- **V7, counts.** Moving a card is not a change. A joined CROSS JOIN group is counted by its largest table's estimate.
- **V8, kinds never mix.** Described above.
- **V9, the query diagram loads every named database.** Described above.
- **V10, the final review.** A run refuses when the session's database is not the model's ("The tab's database changed. Run again."). LIKE and NOT LIKE take any pattern on a number column; PostgreSQL casts the column, as in `o.id::text LIKE '12%'`. On SQLite a column with no declared type, such as a view's computed column, takes a number-looking value bare, since SQLite never finds `'5'` equal to `5`; a value typed in quotes stays text.
- **P16, deferred checks.** See below.

### Accepted deviations

- Golden models are reused in the live tests with the database and schema rewritten per test database (P3).
- Query diagram cards can be dragged; the drawing stays read only, since only the SQL defines it.
- Saving regenerates the SQL every time; with the Connection closed, an unchanged model keeps its stored SQL.
- `VALUES` and `TABLE t` draw a shape (`TABLE t` as `SELECT * FROM t`).
- The CardFrame takes `tone: "danger" | "warning"`.

## Known limits

- **Saving while closed or loading.** An edited model saved while its Connection is closed keeps the previous model's SQL until the next open; a save while column types are still loading writes values as text literals. The first save of a never-saved tab with a closed Connection stores the preview SQL.
- **A stopped run reads as a failure.** A run stopped by a session change shows as "Statement 1 failed" with Contura's note, not as a stopped state.
- **A Join naming a missing card** cannot be removed from the canvas; GROUP BY problems are matched to their rows by message text, not by a Core target.
- **Table nouns.** Words the rule is unsure about (sizes, menus, aliases) fall back to the table name unchanged.
- **Analyzer.** Finding a table reference is still superlinear at 2,000 Joins; SQLite `WITH ... REPLACE INTO` reads "Expected SELECT".
- **Layout.** A rejected layout reply is not caught; stale node ids can skew the extent of pinned nodes.
- **Publish.** There is no pixel cap at 3x scale (a very large image fails with a vague error); SVG copy copies the text.
- **Query diagram schema loads.** A database whose schema failed to load has no Try again in the query diagram (the Visual Query card has one, V6), and hidden tabs merge schema notices again although nothing is shown.
- **Popovers.** A press outside the Join or Pick popover on a non-focusable area loses the restored focus.
- **The Core read-then-save of a Saved Query** is not one transaction; harmless in one process.

## Deferred checks

At the user's instruction of 2026-10-18 (P16), these are moved to the end-of-roadmap pass and are not a merge gate for step 6:

- **Frame capture.** Screen 6.1 in all five states (Join kind, Pick a Foreign Key, No Join, Results, Empty) and screen 6.2 in both states (Diagram, Statement with an error), in Alucard and Dracula, captured from the release exe and compared with Artifact A15Z5kepCRSAyQ8zXhSCvg. Differences go to the step 12 list.
- **Memory gates** with `scripts/measure-memory.ps1` on the release exe: idle under 150 MB (ADR 0003); a 20-table Visual Query after a run under 180 MB; a 2,000-node diagram, fitted and panned, under 250 MB; after closing those tabs, back within 10 MB of idle. The numbers will be recorded here, or in a new ADR if they move the budget.
- **End to end on the release exe** against live MySQL, PostgreSQL and SQLite.

## Checks

`cargo test -j 6 --workspace --features contura-core/test-util`, the clippy gate, `npx vitest run`, `npx tsc --noEmit` and `npm run build` on the step6 branch.
