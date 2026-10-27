# Contura

A personal desktop database client for browsing, querying and changing databases, in the spirit of Navicat but lighter on memory.

## Language

**Core**:
The Rust side of Contura that talks to databases and owns all data access.
_Avoid_: Engine, backend engine

**Dialect**:
One supported database product: Postgres, MySQL or SQLite.
_Avoid_: Engine, driver, database type

**Connection**:
The saved details for reaching one database server or SQLite file: host, port, user, credentials and options.
_Avoid_: Server, profile, datasource

**Group**:
A named, coloured collection of Connections for one context of work, usually one company (e.g. "KFC"). Each Connection belongs to at most one Group. Groups don't nest.
_Avoid_: Folder, workspace, project, tag

**Ungrouped**:
Where Connections that belong to no Group appear.
_Avoid_: Default group, misc, inbox

**Query Tab**:
A title-bar tab holding SQL typed for one Connection (and database), with its results below.
_Avoid_: Console, worksheet, script

**Query Session**:
The database connection a Query Tab owns while it is open, separate from browsing, so a typed transaction and session settings last across its statements.
_Avoid_: Console session, worker

**Query History**:
The last 1,000 statements run on a Connection, with when, how long and how they ended.
_Avoid_: Log, journal

**Saved Query**:
SQL kept by name in Contura, shared by every Connection.
_Avoid_: Snippet, favourite, bookmark
**Theme**:
A named set of visual tokens (colours, type, corners, icon style) that Contura can be switched to. Two ship today: Alucard (light) and Dracula (dark, the default), or System to follow Windows. The design source for both is DESIGN-NEXT.md (ADR 0015).
_Avoid_: Skin, style, appearance

**Home**:
The starting place of Contura, listing every Group and the Ungrouped Connections, with Recent beside them.
_Avoid_: Dashboard, start page, launcher

**Recent**:
The last opened queries, tables and Schema Models, newest first, each with its Connection and time. Shown on Home; selecting one opens it again.
_Avoid_: History (that is Query History), recents, MRU

**Suggested Connection**:
A Connection that Contura pre-fills from a database it found installed locally (currently Laragon). It isn't saved until the user accepts it.
_Avoid_: Auto-connection, detected connection, discovered server

**Production Connection**:
A Connection flagged as production, where every write needs an extra confirmation, including SQL typed by hand. The Core classifies each statement as a read or a write and decides; the UI shows one dialog with the exact SQL before anything runs. Turning it on sets AI access to never.
_Avoid_: Live, prod mode

**Read-only Connection**:
A Connection that Contura will not send any write to. The Core blocks writes before the driver, and the server refuses them too. It wins over Production: no dialog, the write is blocked.
_Avoid_: Safe mode, locked

**Confirm pass**:
The single-use permission the Core issues once the user confirms the dialog on a Production Connection. It is bound to the Query Session and to the exact text of each writing statement, and expires after 120 seconds. Editing the SQL means asking again.
_Avoid_: Token, approval

**Job pass**:
The Confirm pass for a writing Job (an Import or a SQL file import) on a Production Connection. It is bound to the Job's fingerprint: what is written, where, how, and the file's path, size and SHA-256. It is used once; a changed file means asking again (ADR 0018).
_Avoid_: Import token

### Querying

**Visual Query**:
A query built by adding tables of one Connection to a canvas and linking their columns, instead of typing SQL. It is its own tab and runs on its own Query Session. Saved under Saved Queries; SQL is generated one way: the Core writes it from the Visual Query, and editing that SQL never changes the Visual Query (ADR 0017).
_Avoid_: Query builder, diagram, designer

**Query diagram**:
A read-only drawing of the current statement, shown beside a SQL tab or a Visual Query. It shows table details only, never rows, and ends in the Result node.
_Avoid_: Visual Query, execution plan, ER diagram

**Result node**:
The node of a query diagram that lists the statement's output columns, each with its source and type, then its clauses (WHERE, GROUP BY, ORDER BY, LIMIT).
_Avoid_: Output table, result grid

**Join**:
An arrow between two columns in a Visual Query, saying how their tables are combined. Changing a Join changes only the query, never the database.
_Avoid_: Connection, link, relation

**Foreign Key**:
A real constraint stored in the database. A Visual Query pre-fills its Joins from Foreign Keys.
_Avoid_: connection; a drawn line is a Relationship

**ERD Column**:
One line inside a table's braces in an ERD Frame: a name, an optional type and flags (pk, not null, unique). Not a database's column: nothing in a database changes.
_Avoid_: field, attribute

**Relationship**:
A line between two tables of one ERD Frame, or between two of their ERD Columns, with a cardinality (`>`, `<`, `-`, `<>`). It is drawn, not a Foreign Key.
_Avoid_: reference, foreign key

**Saved Query**:
A SQL query or Visual Query the user stored by name, so it can be reopened later.
_Avoid_: Snippet, favourite

**Query History**:
The automatic record of statements the user has run.
_Avoid_: Log, recent queries

### AI assistant

**Ask**:
A question put to the AI assistant, inline where the user is working or in the chat panel.
_Avoid_: Prompt, query, chat message

**Sends**:
The line shown before an Ask, listing exactly what would leave the PC (question, schema, query text, sample rows). The Core builds it, and the text it shows is the text that is sent. "Show exactly" opens the full text.
_Avoid_: Payload, context, preview

**AI access**:
The per-Connection setting that decides what an Ask may send: nothing, schema only, schema and query text, or those plus sample rows.
_Avoid_: AI permission, privacy mode, consent flag

**AI Context**:
The local index of one database's schema that the assistant keeps per Connection: one card per table, a Context Tree, and a full-text index. It lets an Ask send the tables the question needs instead of the whole schema.
_Avoid_: Index, embeddings, cache

**Context Tree**:
The outline of an AI Context: Areas that group related tables, each with its tables below it. For a large schema the model is shown this outline once and picks the Areas and tables to read.
_Avoid_: Schema map, table list

**Area**:
A named group of related tables in a Context Tree, such as the tables around orders.
_Avoid_: Cluster, module, folder

**This tab**:
The Sends row with what the active tab shows, built by the Core from the tab's fields and gated by AI access. A tab spanning two Connections (Schema Compare, Data Transfer) is gated at the lower access.
_Avoid_: Tab context, screen context

**Recent steps**:
The Sends row with a short trail of what the user did since their last question in this place (opened New table, ran the Visual Query, 1 row), as labels only: no SQL and no row data. Kept in memory until an Ask sends it; each step is gated by its own Connection's AI access.
_Avoid_: History, activity log, breadcrumbs

**Asked in**:
The stamp on a question saying where it was asked, with a short summary of that tab and the Recent steps that went with it. It is kept with the thread and sent with later questions only as far as AI access still allows.
_Avoid_: Origin, source tab

**Topic**:
A stretch of a chat thread about one subject, with a short summary. A new Topic starts after a long pause, in a new place, or when the subject changes.
_Avoid_: Session, conversation, chapter

**Sent record**:
What one Ask sent to the provider, kept with the answer: sizes, the items sent, and a hash of the text. It keeps the exact text only when the privacy switch for that is on.
_Avoid_: Request log, history

**answer log**:
The steps and log lines of one answer, opened with "Show log". It lists what the Core checked and sent, and says that nothing ran on the database.
_Avoid_: Raw log, process

**compaction**:
Folding the older turns of a thread into a summary when the thread nears the model's context window. The user can show the summary and undo it.
_Avoid_: Truncation, trimming

### Changing databases

**Pending Edit**:
A change to row data in the grid that has not been saved yet: an edited cell, a new row or a deleted row. Pending Edits are kept by primary key across paging, sort and filter. The Core writes the SQL and saves all of them together in one transaction, or none are; a row that changed since it was loaded rolls the whole save back. Tables without a primary key only take new rows.
_Avoid_: Draft, unsaved change, dirty row

**Table Designer**:
The editor for one table's columns, indexes and Foreign Keys, which also creates a new table and drops one. It is its own tab ("orders design", tab kind `design`), opened from the table row menu in the tree or from the Design button in the table's grid. Changes are tracked by each column's, index's and key's name as loaded, so a renamed column stays one change, never a drop and an add. The Core writes the SQL and its warnings, the preview shows them, and Apply runs exactly what the preview showed (ADR 0016).
_Avoid_: Schema editor, ER model, structure editor

### Designing schemas

**Schema Model**:
A design of tables, columns, indexes, enums and Foreign Keys for one Dialect, written in DBML. It exists only in Contura until it is applied to a Connection.
_Avoid_: ER diagram, design, draft, model file

**Schema Builder**:
Where a Schema Model is edited, either as DBML text or on a canvas, with each kept in step with the other. It is where ER diagrams of real databases live: DBML is the one ERD that reaches SQL and a Connection (ADR 0030). A `diagram er` frame on a Board is a sketch, and Open as DBML converts it to a Schema Model (ADR 0031).
_Avoid_: ER designer, modeler, diagram editor

**Layout**:
The canvas positions of a Schema Model's tables, saved beside the DBML file because DBML cannot hold them.
_Avoid_: Diagram, positions file

**Diagram engine**:
The one canvas that the Schema Builder, the Visual Query, the query diagram, Diagrams and Lineage all draw with (`src/diagram/`): card sizes, edges, level of detail, layout, motion and image export (ADR 0017, ADR 0019).
_Avoid_: Canvas library, renderer, React Flow

### Diagrams

**Board**:
One `.flow` file holding several Diagrams, each in its own Frame, plus loose sketches. A file with one Diagram is a Board of one Frame (ADR 0031).
_Avoid_: canvas, workspace, page

**Frame**:
One Diagram on a Board: its own `diagram <kind> "<title>"` block in the `.flow`, named by its title. Only a Diagram's frame; a box of Sketches is a Section. The selected Frame is the one live on the canvas, with its kind's tools and its code pane. Add opens the Shelf and a Space tap opens the Space box; a pick adds a Frame. A sequence diagram's `loop` or `alt` box is a sequence frame, always said in full.
_Avoid_: panel, group

**Shelf**:
The panel Add opens on a Board: pick a Diagram kind, an icon or a shape on the left, start from a Template on the right, one search over both.
_Avoid_: insert panel, library

**Template**:
A ready Diagram, or a Board whose Diagrams agree with each other, on the Shelf's right side.
_Avoid_: example, sample

**Space box**:
The small add box a Space tap opens at the pointer; Enter drops the pick at its crosshair.
_Avoid_: quick add, command box

**Section**:
A titled box on a Board that holds Sketches and moves them with it; no Diagram's code. Drawn with F.
_Avoid_: frame, group

**Sketch**:
A shape on a Board that belongs to no Diagram: a rectangle, ellipse, diamond, line, arrow, pen stroke, text or note, saved in the layout file. The Assistant reads it as a note.
_Avoid_: annotation, drawing

**Note**:
A Sketch of text on a Board, drawn with N. Inside a Frame whose kind has notes, it is that Diagram's note.
_Avoid_: sticky note

**Diagram**:
A drawing the user writes and draws in a diagram tab, one of nine kinds: data flow, flowchart, cloud architecture, sequence, state, class, mind map, timeline and ER (tables, columns and relationships, for sketching; the Schema Builder is for real databases). It is a Frame of a Board: a `.flow` file plus its layout file in Contura's diagrams folder, named by the user. Publish and Save a copy as are the only ways it leaves that folder (ADR 0019, ADR 0031).
_Avoid_: Chart, drawing file, model, Schema Model

**.flow**:
The small text language a Board is written in: a first line `diagram <kind> "<title>"` for each Diagram, then nodes with `[kind, key: value]` (a `color` is a preset, a CSS colour name or a hex), links (`>`, `<>`, `-`, `-->`, `--` dotted, and `..>` in cloud; `A > B, C` fans out to several), groups in braces, ER tables as `orders { id int pk }` blocks and `//` comments. The text is the diagram; the canvas edits it through text edits, and moves go only to the layout file.
_Avoid_: DSL, Mermaid, script

**Lineage**:
A read-only drawing of one table's Foreign Keys both ways, with the Diagrams and views that read or write it, and a panel that says in plain sentences what each key does and what deleting a row would block or delete. It reads catalog details only, never rows.
_Avoid_: Dependency graph, ER diagram, impact analysis

**Icon pack**:
The cloud and general icon sets packed into the app (`icons.bin`): AWS, Azure, Google Cloud, Kubernetes, Lucide and a chosen set of Simple Icons brand logos. Icons load one at a time, are shown only as images, fitted into one 24×24 frame (the drawing never changed), outline icons in the theme's text colour, logos in their brand colour (a pale logo on light gets a hairline outline; a dark logo on dark takes the text colour), and credited in Icon credits.
_Avoid_: Icon font, sprite, stencils

**Import**:
Loading a CSV, JSON, Excel or SQL file into a table or database that exists. A writing Job: Read-only refuses it, Production asks once with a Job pass.
_Avoid_: Dump, load

**Export**:
Writing a table, a filter, a selected row or a query result to a CSV, JSON, Excel or SQL file. It never changes the database.
_Avoid_: Dump, download

**Job**:
A long run with progress and cancel, such as an Export or an Import. It can move to the status bar and keep running (ADR 0018).
_Avoid_: Task, process

**Data Transfer**:
Copying a table's structure and/or rows from one database to another, possibly across Dialects. Each column has a type mapping: its target type and a note, which the user reviews and can change before anything runs. Views, routines, triggers, checks, generated column expressions and partitions are not copied; they are listed as not copied, never dropped quietly. A writing Job on the target: Read-only refuses it, Production asks once with a Job pass (ADR 0020).
_Avoid_: Migration, sync, export

**Schema Compare**:
Comparing the structure of two databases of the same Dialect (on PostgreSQL, one schema against one schema), or a Schema Model against a database, which produces a Sync Script. Each difference is an item marked added, removed or changed. What Contura does not compare (views, routines, triggers, checks, generated column expressions, expression and partial indexes) is listed per side as **not compared**, so "No differences" never claims more than was compared. Renames show as a removal plus an addition (ADR 0022).
_Avoid_: Diff, schema sync

**Sync Script**:
The reviewable SQL that would make one database's structure match another's, built only by Contura from the ticked items and run exactly as shown. A **data-loss item** (a removed table or column, or a change that narrows a column) carries the rows it would lose and starts unticked. Unticking an item unticks what needs it; ticking one ticks what it needs.
_Avoid_: Migration, patch

**Backup**:
A SQL script written by Contura itself, holding a database's (on PostgreSQL, a schema's) structure and rows, taken from one consistent snapshot. Its header lists what it does **not include**, such as extensions, large objects, grants and roles, partitioned tables or virtual tables, so it never claims more than it holds.
_Avoid_: Dump, export, snapshot

**Restore**:
Running a Backup against a database to recreate its structure and rows, after Contura checks the file and shows the exact SQL. Three modes: **Into a new database** (removed again if the restore fails), **Into an existing database that must be empty**, and **Replace** the tables the file holds (every DROP is listed; on MySQL, back up those tables first).
_Avoid_: Import, load
