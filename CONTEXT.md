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
_Avoid_: Relationship, connection

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
The line shown before an Ask, listing exactly what would leave the PC (question, schema, query text, sample rows). "Show exactly" opens the full text.
_Avoid_: Payload, context, preview

**AI access**:
The per-Connection setting that decides what an Ask may send: nothing, schema only, schema and query text, or those plus sample rows.
_Avoid_: AI permission, privacy mode, consent flag

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
Where a Schema Model is edited, either as DBML text or on a canvas, with each kept in step with the other.
_Avoid_: ER designer, modeler, diagram editor

**Layout**:
The canvas positions of a Schema Model's tables, saved beside the DBML file because DBML cannot hold them.
_Avoid_: Diagram, positions file

**Diagram engine**:
The one canvas that the Schema Builder, the Visual Query and the query diagram all draw with (`src/diagram/`): card sizes, edges, level of detail, layout and image export (ADR 0017).
_Avoid_: Canvas library, renderer, React Flow

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
Copying a table's structure and/or rows from one database to another, possibly across Dialects.
_Avoid_: Migration, sync, export

**Schema Compare**:
Comparing the structure of two databases of the same Dialect, which produces a Sync Script.
_Avoid_: Diff, schema sync

**Sync Script**:
The reviewable SQL that would make one database's structure match another's.
_Avoid_: Migration, patch

**Backup**:
A SQL script written by Contura itself, holding a database's structure and rows.
_Avoid_: Dump, export, snapshot

**Restore**:
Running a Backup against a database to recreate its structure and rows.
_Avoid_: Import, load
