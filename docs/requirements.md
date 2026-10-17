# Contura: User Requirements

Contura was called DB View until 2026-10-16.

What Contura must let its user do, as settled in the design session on 2026-10-14. Terms are defined in [CONTEXT.md](../CONTEXT.md). Decisions and their reasons are in [docs/adr/](adr/). This document says nothing about how screens look or are laid out. Visual design is done separately.

## Product

- A personal database client for one user (the author) on Windows. Windows-only APIs are avoided where practical so macOS and Linux remain possible (ADR 0001).
- Rust Core, React + TypeScript UI inside Tauri 2 (ADR 0001).
- Supported Dialects: MySQL 8.0+, Postgres 13+, SQLite (bundled). MariaDB is best effort through the MySQL Dialect and not tested.
- Each Dialect uses its own crate behind a `Dialect` trait: `mysql_async`, `tokio-postgres`, `rusqlite` (ADR 0002).

## Memory (ADR 0003)

- Idle with one open Connection: under ~150 MB private working set, summed over Contura and its WebView2 processes (ADR 0003).
- Table data and query results are fetched a page at a time (1,000 rows), never whole.
- Closing a tab releases its rows.
- Large text/JSON/BLOB cells show a preview of about 1 KB. The full value loads only when the user opens that cell.
- A large Schema Model with every card in view may go over the budget: a 300-table model measured about 200 MB (ADR 0003, accepted 2026-10-16).

## Storage and distribution (ADR 0006)

- Portable app. All Contura data (Connections, Query History, Saved Queries, Visual Queries, logs, WebView2 cache) lives in `data\` next to the `.exe`. Nothing is written to `%APPDATA%` or `%LOCALAPPDATA%`.
- Passwords live in Windows Credential Manager, never in the data folder.
- No installer, auto-update or code signing.

## Connections

- The user can create, edit, delete and test Connections.
- SSL modes: disable, require, verify-CA with a CA file.
- No SSH tunnels in v1.
- Several Connections can be open at once.
- A SQLite Connection opens an existing file or creates a new empty one. Contura never overwrites an existing file.
- A Connection can be marked **Production**, which adds an extra confirmation to every write, including typed SQL. It can be marked **Read-only**, which blocks every write.
- Each Connection has an **AI access** level (`aiAccess`): "Never send anything", "Schema only" (the default), "Schema and query text", or "Schema, query text and sample rows". It decides what the AI assistant may send (see AI assistant).
- **Suggested Connections from Laragon:**
  - On each start, Contura looks for Laragon in the Windows installed-programs list, then reads `<install>\usr\laragon.ini`.
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
  - It types like VS Code: monospace, font ligatures on (Cascadia Code), editing in several places at once, bracket matching, autocomplete as you type.
  - Format SQL makes keywords UPPERCASE.
  - Ctrl Enter runs the current statement, or the selection if there is one. Ctrl Shift Enter runs every statement and stops at the first one that fails.
  - Running again replaces the last result. A result can be pinned to keep it.
  - No Vim mode.
- **Safety:** an UPDATE or DELETE with no WHERE, typed in the editor, asks for confirmation before it runs. This comes on top of the Production and Read-only rules.
- **Grid:**
  - Start editing with double-click, Enter or F2. Editing happens in place: the value never moves.
  - Ctrl C copies tab-separated text with headers, which pastes into Excel.
  - NULL is shown as italic grey "NULL".
  - Numbers and dates are shown exactly as stored, with no grouping and no time-zone conversion.
- **Feedback:** saving confirms with a toast in the bottom right.
- **Startup:** Contura reopens the last Group and its tabs.

## Browsing

- An object tree: Connection → databases (and schemas, for Postgres) → tables, views, routines, triggers.
- Postgres system schemas are hidden unless the user shows them.
- Views can be created, edited and dropped as SQL definitions. Routines and triggers are read-only (their definitions can be viewed).
- A table data grid with paging, sort and filter. Edits are Pending Edits until the user saves, and then all of them are applied in one transaction or none are.
- The filter is a one-line SQL expression above the grid, such as `status = 'paid'`, with completion of that table's columns. Enter applies it, Esc clears it. The Core runs it as `WHERE (<filter>)` and refuses a filter that tries to add a second statement. A server error shows in the grid with Clear filter.

## Querying

- SQL editor with autocomplete from the open Connection's tables and columns. Run selection runs the highlighted text. Run all runs every statement, and each result set gets its own tab.
- The editor knows the query (plan 4b):
  - **Completion** as you type and on Ctrl Space: tables and views after FROM and JOIN (picking one adds a short alias, `orders o`), an alias's or CTE's columns after `o.`, a whole JOIN from a Foreign Key, keywords and functions of the Connection's Dialect. Names that need quotes are inserted with them.
  - **Inspections** with quick-fixes on Ctrl . or Alt Enter: an unknown table or column ("Did you mean orders?", or qualify a table that is only in another schema), an ambiguous column (qualify it), UPDATE or DELETE without WHERE (a warning: Add WHERE), an unused alias (a faint hint: Remove alias), unbalanced parentheses and stray commas. An error where you are typing waits 1.5 s. Checks against the schema wait until it has loaded, so nothing is flagged unknown while it loads.
  - **Refactors:** expand `*` or `o.*` into the column list; F2 selects every use of an alias or CTE so typing renames them all (a table or column is renamed in the Table Designer); F12 goes to an alias's or CTE's declaration, and on a table shows it in the Database Tree; Ctrl Shift Space shows a function's parameters.
  - **Live templates** on Tab at the start of a statement: `sel`, `selw`, `cnt`, `ins` (fills in every column of its table, each value a field) and `upd`.
  - The schema index is one per Connection and database, loaded once in the background. It reloads after a statement starting with CREATE, ALTER, DROP, RENAME, TRUNCATE or COMMENT succeeds, and on the Database Tree's Refresh; it is dropped when the Connection closes. The status line says Loading schema while it loads.
- Running queries can be cancelled with Esc or the Cancel button; the Core stops them on the server. Each Connection has an optional query timeout in seconds, past which the query is cancelled on the server.
- Queries are tabs in the title bar (Ctrl T opens one). Each query tab has its own session on its Connection (ADR 0011), so a typed `BEGIN` ... `COMMIT`, `SET` or temporary table lasts across that tab's statements. Statements typed in the editor otherwise commit on success, one at a time. Closing the tab, changing its Connection or database, switching Group or editing the Connection ends the session and rolls back a transaction left open, without asking yet (a known gap).
- Results sit below the editor in a resizable split. A result over 1,000 rows shows its first 1,000; Fetch next 1,000 (or scrolling to the end) reads the next page from the same open result. Running anything else in the tab, or closing the result, releases it. Query results show the 1 KB preview of long values; the full value opens from the table view.
- An UPDATE or DELETE with no WHERE asks before it runs: Run it, Cancel, or Add WHERE.
- Format SQL (Shift Alt F) makes keywords UPPERCASE and starts each clause on its own line. Strings, names and comments are left alone.
- Query History keeps the last 1,000 statements per Connection, with the time, duration and outcome. It opens in a panel on the right, can be searched and filtered (failed, changes), and puts a statement into the editor or a new tab; it never runs anything itself. Clear Query History is on the Connection's menu.
- Saved Queries are stored by name (unique, ignoring case) and are global: they list under Saved Queries for every Connection and run on the tab's Connection. Ctrl S saves a query tab; a Saved Query's tab shows a dot when it has unsaved changes.
- Unsaved query tabs are kept per Group (and for Ungrouped) and come back after a restart.
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
  - While the DBML has a syntax error, the canvas keeps the last valid version and points at the error. Canvas editing is blocked until the error is fixed.
- **Typing DBML** has DataGrip-level help with VS Code keys (see [the editor design](superpowers/specs/2026-10-16-editor-and-ai-design.md)):
  - completion of the model's own tables and columns, and of the model Dialect's types (Ctrl+Space, and as you type)
  - a Ref to a missing table or column is flagged, with "Did you mean" quick-fixes (Ctrl+. or Alt+Enter)
  - templates for `Table`, `Ref` and `Enum` (type the name, press Tab)
  - F2 renames a table or column everywhere it is used
  - an error where you are typing waits 1.5 s before it shows; errors elsewhere show at once
  - lines changed since the last save get a quiet bar in the gutter
- **The layout:** DBML on the left (about 42% of the width, collapsible with Ctrl+B), the canvas on the right.
- **Foreign Keys by drag:** a column can be dropped onto any column. When the target is not a key, unique or indexed, Contura still adds the Ref and warns that the database may refuse it.
- **Enums** live in the DBML only. They get no cards on the canvas.
- On the canvas, dragging between columns creates a **Foreign Key in the model**. In a Visual Query the same gesture makes a Join.
- Starting points: blank, reverse-engineered from an existing database through a Connection (read only), or an existing `.dbml` file.
- Saved anywhere the user chooses, as `<name>.dbml` plus `<name>.dbml.layout.json` for canvas positions, not in `data\` (Contura refuses a path inside it). A model that was never saved, such as a reverse-engineered one, asks where to save on the first Save.
- Outputs:
  - export a SQL script for the model's Dialect
  - export the diagram as PNG or SVG
  - while the DBML has an error, an export uses the last valid version and says so first
  - "Apply to Connection" is shown disabled with "Arrives with Schema Compare" until build step 10
  - apply to a Connection, which compares the model with the database and produces a Sync Script the user reviews and confirms before it runs

## AI assistant

The assistant UI is built; real providers come in a later step (ADR 0010).

- **Placement**
  - Inline Ask: a small "Ask" button at the end of a non-empty SQL selection, and Ctrl+I, offering actions that fit (Explain, Fix this error, Optimize, Suggest indexes). It also appears on a failed query ("Ask AI" in the error), the grid filter box (Write a WHERE for this filter) and a Schema Builder table card.
  - Chat panel: docked on the right, toggled with Ctrl+Alt+I, with its context as removable chips (the open table, the selected SQL, the Schema Model). Esc closes the inline Ask.
  - "Open in chat" carries an inline question and its context into the panel.
- **Safety and privacy**
  - AI-written SQL is never run automatically. Running it follows the normal rules (Production confirmation, Read-only, UPDATE or DELETE without WHERE).
  - Before anything could be sent, the prompt shows a "Sends" line, and "Show exactly" opens the full text. The text is capped at 200 KB.
  - Per Connection, **AI access** is one of four levels: "Never send anything", "Schema only", "Schema and query text", "Schema, query text and sample rows". With "Never send anything" only the question goes, and the panel says what it cannot see. When rows are allowed, each question has a switch to leave them out.
  - Production Connections will default to "Never send anything" (step 5).
- **Providers**
  - One provider for everything, optionally overridden per Group. Settings has a provider picker (OpenAI-compatible, Anthropic Claude, Groq, DeepSeek, Custom), presets for the base URL and model, optional temperature and max tokens, and a Test button.
  - The API key is stored in Windows Credential Manager (`AI/<provider id>`), never in `data\`. After saving, the form shows only its last 4 characters.
  - Provider calls are made from the Core, not the WebView.
- **Placeholder phase**
  - No network calls. With no provider saved, asking shows "Connect an AI provider in Settings" with a button that opens Settings. With one saved, it says answers arrive in a later Contura version and that nothing was sent.
- **Chat history**
  - Threads are kept in `data\` per Group (and for Ungrouped), with a Clear action.

## Changing databases

- Table Designer for columns, indexes and Foreign Keys.
- Before running, the exact SQL is shown and must be confirmed for Table Designer, Data Transfer, Sync Scripts and Restore. SQL typed in the editor runs as written (subject to Production/Read-only).
- Data Transfer works across Dialects, with a type mapping the user reviews. Each run copies structure, data, or both.
- Import/export: CSV, JSON, Excel (.xlsx), SQL INSERT scripts. Large files are streamed.
- Backup/Restore uses Contura's own SQL scripts (ADR 0004).
- Schema Compare between two databases of the same Dialect produces a reviewable Sync Script.

## Testing

- Integration tests run against real servers on the author's Laragon: MySQL at `127.0.0.1:3306` and Postgres at `127.0.0.1:5432`, read from environment variables. MySQL tests sign in as a scoped `dbview_test` user (password `dbview_test`) that can only touch databases named `dbview_test_%`, never as `root`. Postgres tests sign in as a `dbview_test` role (password `dbview_test`) with `LOGIN CREATEDB`, never as `postgres`. SQLite tests use temporary files. Tests create and drop throwaway `dbview_test_*` databases.

## Build order

1. Connections + object tree + read-only data grid, on MySQL
2. Postgres and SQLite Dialects
3. Schema Builder: DBML ↔ canvas, reverse-engineering, SQL and image export (moved up because designing schemas is one of the user's two main activities)
4. SQL editor (CodeMirror 6, ADR 0009), Query History, Saved Queries
5. Pending Edits, Table Designer, Production and Read-only Connections
6. Visual Query, plus the shared diagram engine and the query diagram and result shape
   - then lineage, the flow language (`.flow`), data flow diagrams and flowcharts, and cloud architecture diagrams
7. Import/export, plus Mermaid flowchart import
8. Data Transfer
9. Backup/Restore
10. Schema Compare, plus applying a Schema Model to a Connection
   - then sequence diagrams; cloud sharing later

The diagram work and its memory budget are in `docs/superpowers/specs/2026-10-16-contura-direction-design.md`.
