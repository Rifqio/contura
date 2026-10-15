# DB View

A personal desktop database client for browsing, querying and changing databases, in the spirit of Navicat but lighter on memory.

## Language

**Core**:
The Rust side of DB View that talks to databases and owns all data access.
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

**Theme**:
A named set of visual tokens (colours, type, corners, icon style) that DB View can be switched to. Flat minimal is the default.
_Avoid_: Skin, style, appearance

**Home**:
The starting place of DB View, listing every Group and the Ungrouped Connections.
_Avoid_: Dashboard, start page, launcher

**Suggested Connection**:
A Connection that DB View pre-fills from a database it found installed locally (currently Laragon). It isn't saved until the user accepts it.
_Avoid_: Auto-connection, detected connection, discovered server

**Production Connection**:
A Connection flagged as production, where every write needs an extra confirmation, including SQL typed by hand.
_Avoid_: Live, prod mode

**Read-only Connection**:
A Connection that DB View will not send any write to.
_Avoid_: Safe mode, locked

### Querying

**Visual Query**:
A query built by adding tables to a canvas and linking their columns, instead of typing SQL.
_Avoid_: Query builder, diagram, designer

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

### Changing databases

**Pending Edit**:
A change to row data in the grid that has not been saved yet. All Pending Edits are saved together in one transaction, or none are.
_Avoid_: Draft, unsaved change, dirty row

**Table Designer**:
The editor for one table's columns, indexes and Foreign Keys, which produces schema-changing SQL.
_Avoid_: Schema editor, ER model

### Designing schemas

**Schema Model**:
A design of tables, columns, indexes, enums and Foreign Keys for one Dialect, written in DBML. It exists only in DB View until it is applied to a Connection.
_Avoid_: ER diagram, design, draft, model file

**Schema Builder**:
Where a Schema Model is edited, either as DBML text or on a canvas, with each kept in step with the other.
_Avoid_: ER designer, modeler, diagram editor

**Layout**:
The canvas positions of a Schema Model's tables, saved beside the DBML file because DBML cannot hold them.
_Avoid_: Diagram, positions file

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
A SQL script written by DB View itself, holding a database's structure and rows.
_Avoid_: Dump, export, snapshot

**Restore**:
Running a Backup against a database to recreate its structure and rows.
_Avoid_: Import, load
