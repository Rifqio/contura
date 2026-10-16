# DB View: User Requirements

What DB View must let its user do, as settled in the design session on 2026-10-14. Terms are defined in [CONTEXT.md](../CONTEXT.md). Decisions and their reasons are in [docs/adr/](adr/). This document says nothing about how screens look or are laid out. Visual design is done separately.

## Product

- A personal database client for one user (the author) on Windows. Windows-only APIs are avoided where practical so macOS and Linux remain possible (ADR 0001).
- Rust Core, React + TypeScript UI inside Tauri 2 (ADR 0001).
- Supported Dialects: MySQL 8.0+, Postgres 13+, SQLite (bundled). MariaDB is best effort through the MySQL Dialect and not tested.
- Each Dialect uses its own crate behind a `Dialect` trait: `mysql_async`, `tokio-postgres`, `rusqlite` (ADR 0002).

## Memory (ADR 0003)

- Idle with one open Connection: under ~150 MB private working set, summed over DB View and its WebView2 processes (ADR 0003).
- Table data and query results are fetched a page at a time (1,000 rows), never whole.
- Closing a tab releases its rows.
- Large text/JSON/BLOB cells show a preview of about 1 KB. The full value loads only when the user opens that cell.

## Storage and distribution (ADR 0006)

- Portable app. All DB View data (Connections, Query History, Saved Queries, Visual Queries, logs, WebView2 cache) lives in `data\` next to the `.exe`. Nothing is written to `%APPDATA%` or `%LOCALAPPDATA%`.
- Passwords live in Windows Credential Manager, never in the data folder.
- No installer, auto-update or code signing.

## Connections

- The user can create, edit, delete and test Connections.
- SSL modes: disable, require, verify-CA with a CA file.
- No SSH tunnels in v1.
- Several Connections can be open at once.
- A SQLite Connection opens an existing file or creates a new empty one. DB View never overwrites an existing file.
- A Connection can be marked **Production**, which adds an extra confirmation to every write, including typed SQL. It can be marked **Read-only**, which blocks every write.
- **Suggested Connections from Laragon:**
  - On each start, DB View looks for Laragon in the Windows installed-programs list, then reads `<install>\usr\laragon.ini`.
  - Each database section (`[mysql]`, `[postgresql]`) yields a Suggested Connection on `127.0.0.1`, using the section's `Port` or the Dialect default (3306 / 5432), with user `root` (MySQL) or `postgres` (Postgres).
  - A Suggested Connection is saved only when the user accepts it. One matching a saved Connection's host and port is not offered.
  - Later changes in Laragon do not update saved Connections.

## Groups and Home

- The user can create, rename, recolour and delete **Groups** (e.g. one per company: "KFC").
- Each Group has a name and a colour picked from a fixed set of Group colours.
- Each Connection belongs to at most one Group and can be moved between Groups. Connections in no Group appear under **Ungrouped**. Groups don't nest.
- Deleting a Group moves its Connections to Ungrouped. It never deletes Connections.
- **Home** lists every Group (with its colour and number of Connections) and the Ungrouped Connections.
- Opening a Group shows only that Group's Connections, and everything opened from them, until the user leaves the Group. While inside it, the Group's coloured initial square and name stay visible beside the title-bar tabs.
- Home shows Groups as a grid of equal cards, one per Group.
- Suggested Connections are offered on Home and are created Ungrouped unless the user picks a Group.

## Look and feel

- The visual system is in [DESIGN.md](../DESIGN.md). The default Theme is **Flat minimal**, with Paper-notebook highlighting for Pending Edits.
- Each Theme has light and dark variants, following the Windows setting, with a manual override. Comfortable density (about 40 px data-grid rows).
- **Theme selector:** in Settings, the user can switch to any other Theme (ADR 0008): Fluent 2, Material 3, Precision dark, IBM Carbon, macOS, Nord, Gruvbox, Paper notebook, High contrast, Glassmorphism, Neo-brutalism, Skeuomorphism, Claymorphism, Terminal CRT, Editorial, Retro Windows, Frutiger Aero, Cyberpunk. Blueprint, Neumorphism, Raw brutalism and Aurora gradient are excluded.
- Open tables and queries are tabs inside the window's title bar.
- A Production Connection shows a Production tag. While a grid on it has Pending Edits, the grid also gets an amber outline.
- Motion is subtle: fades and slides of 150 ms or less, and none when Windows' reduce-motion setting is on.

## Working style (developer-experience survey, 2026-10-15)

- **Where time goes:** browsing table data and designing schemas. These two get polish first.
- **Shortcuts:** VS Code conventions throughout. A command palette (Ctrl Shift P) can run every action. Ctrl K searches tables.
- **SQL editor:**
  - It types like VS Code: monospace, font ligatures on (Cascadia Code), multi-cursor, bracket matching, autocomplete as you type.
  - Format SQL makes keywords UPPERCASE.
  - Ctrl Enter runs the statement under the cursor, or the selection if there is one.
  - Running again replaces the last result. A result can be pinned to keep it.
  - No Vim mode.
- **Safety:** an UPDATE or DELETE with no WHERE, typed in the editor, asks for confirmation before it runs. This comes on top of the Production and Read-only rules.
- **Grid:**
  - Start editing with double-click, Enter or F2. Editing happens in place: the value never moves.
  - Ctrl C copies tab-separated text with headers, which pastes into Excel.
  - NULL is shown as italic grey "NULL".
  - Numbers and dates are shown exactly as stored, with no grouping and no time-zone conversion.
- **Feedback:** saving confirms with a toast in the bottom right.
- **Startup:** DB View reopens the last Group and its tabs.

## Browsing

- An object tree: Connection → databases (and schemas, for Postgres) → tables, views, routines, triggers.
- Postgres system schemas are hidden unless the user shows them.
- Views can be created, edited and dropped as SQL definitions. Routines and triggers are read-only (their definitions can be viewed).
- A table data grid with paging, sort and filter. Edits are Pending Edits until the user saves, and then all of them are applied in one transaction or none are.

## Querying

- SQL editor with autocomplete from the open Connection's tables and columns. Run selection runs the highlighted text. Run all runs every statement, and each result set gets its own tab.
- Running queries can be cancelled. Each Connection has an optional timeout.
- Query History keeps the last 1,000 statements per Connection. Saved Queries are stored by name.
- Visual Query:
  - Tables from one Connection (any schema or database it can reach) on a canvas (ADR 0005).
  - Joins are pre-filled from Foreign Keys. Dragging a column onto another column adds or changes a Join without changing the database.
  - Supports column selection, Join type (inner/left/right/full), WHERE, GROUP BY, ORDER BY and LIMIT.
  - Generates SQL in one direction only: it can be opened in the SQL editor, but edits there don't flow back. Visual Queries can be saved.

## Designing schemas (Schema Builder)

- The user designs a Schema Model without executing any SQL.
- A Schema Model is written in **DBML** and targets one Dialect, chosen when it is created. Column types are that Dialect's types.
- It holds tables (with aliases and notes), columns (type, pk, increment, not null, unique, default, note), composite keys, indexes, enums, and Foreign Keys with ON DELETE / ON UPDATE.
- The user can edit it two ways, kept in step (ADR 0007):
  - **Text:** typing DBML updates the canvas as they type.
  - **Canvas:** adding tables, editing table names, column names, types and settings directly in the table cards, and dragging a column onto another column to create a Foreign Key. These changes rewrite only the affected DBML lines, keeping comments and formatting.
  - While the DBML has a syntax error, the canvas keeps the last valid version and points at the error.
- On the canvas, dragging between columns creates a **Foreign Key in the model**. In a Visual Query the same gesture makes a Join.
- Starting points: blank, reverse-engineered from an existing database through a Connection (read only), or an existing `.dbml` file.
- Saved anywhere the user chooses, as `<name>.dbml` plus `<name>.dbml.layout.json` for canvas positions, not in `data\`.
- Outputs:
  - export a SQL script for the model's Dialect
  - export the diagram as PNG or SVG
  - apply to a Connection, which compares the model with the database and produces a Sync Script the user reviews and confirms before it runs

## Changing databases

- Table Designer for columns, indexes and Foreign Keys.
- Before running, the exact SQL is shown and must be confirmed for Table Designer, Data Transfer, Sync Scripts and Restore. SQL typed in the editor runs as written (subject to Production/Read-only).
- Data Transfer works across Dialects, with a type mapping the user reviews. Each run copies structure, data, or both.
- Import/export: CSV, JSON, Excel (.xlsx), SQL INSERT scripts. Large files are streamed.
- Backup/Restore uses DB View's own SQL scripts (ADR 0004).
- Schema Compare between two databases of the same Dialect produces a reviewable Sync Script.

## Testing

- Integration tests run against real servers on the author's Laragon: MySQL at `127.0.0.1:3306` and Postgres at `127.0.0.1:5432`, read from environment variables. MySQL tests sign in as a scoped `dbview_test` user (password `dbview_test`) that can only touch databases named `dbview_test_%`, never as `root`. Postgres tests sign in as a `dbview_test` role (password `dbview_test`) with `LOGIN CREATEDB`, never as `postgres`. SQLite tests use temporary files. Tests create and drop throwaway `dbview_test_*` databases.

## Build order

1. Connections + object tree + read-only data grid, on MySQL
2. Postgres and SQLite Dialects
3. Schema Builder: DBML ↔ canvas, reverse-engineering, SQL and image export (moved up because designing schemas is one of the user's two main activities)
4. SQL editor (CodeMirror 6, ADR 0009), Query History, Saved Queries
5. Pending Edits, Table Designer, Production and Read-only Connections
6. Visual Query
7. Import/export
8. Data Transfer
9. Backup/Restore
10. Schema Compare, plus applying a Schema Model to a Connection
