# Backup writes Contura's own script from one snapshot; Restore checks it and runs exactly what was shown

Step 9 adds Backup and Restore. A Backup writes one database (MySQL, SQLite) or one schema (PostgreSQL) to Contura's own plain SQL script, from one consistent snapshot, with no `pg_dump` or `mysqldump`. A Restore checks that file against the target, shows the exact SQL it will run, and runs it into a new database, an empty one, or over the same tables. This ADR builds on ADR 0004 (amended for step 9), ADR 0018 (Jobs and the Job pass), ADR 0013 (Production and Read-only) and ADR 0003 (memory budget).

## Backup

- **A read job on any Connection, no pass**, Production and Read-only included. It writes through `PartialFile` (`name.sql.partial`, renamed when complete, deleted on Cancel or failure), and the path guard refuses the data folder. On Production the dialog warns that the file holds Production rows in plain text.
- **One snapshot.** MySQL `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` (InnoDB only; a MyISAM table gets a warning), PostgreSQL `REPEATABLE READ READ ONLY` with `search_path = ''` and `TimeZone = 'UTC'`, SQLite one read transaction. Structure and rows are read inside it.
- **Structure is the server's own DDL text** (`backup/structure/`): MySQL `SHOW CREATE`, PostgreSQL catalog definitions, SQLite `sqlite_master.sql`. Rows go through step 7's `RowSource` and `InsertBuilder`, in primary key order, 100, 500 or 1,000 rows per INSERT.
- **The file frame** (ADR 0004 amendment): a header of `-- key: value` lines, `-- section:` markers, and the trailer `-- contura-backup-end statements=N rows=M`. Header values percent-encode `%`, `,`, `;`, `=`, CR and LF (R5); `-- drop-tables: yes` appears only when Add DROP TABLE is on.
- **Not included** is a header line naming what the file leaves out: events (MySQL); extensions, large objects, domains and composite types, partitioned tables and their partitions, publications, policies and grants (PostgreSQL); virtual tables and their shadow tables (SQLite).
- **SQLite exact file copy** (`VACUUM INTO`) is offered beside the script. It is not restored through Contura; it is opened as a Connection.

## Restore

- **A Write job.** Read-only refuses it past the header with `ReadOnly(0)`. One write job per target.
- **Checks first** (`inspect_restore`): header and trailer, one streaming pass that splits, classifies (5a), counts, finds skipped and refused statements, decides shape or full for each INSERT, and hashes the file (SHA-256); then the target: Dialect, version, existing objects, extensions. Plain SQL files with no Contura header are accepted (R16): no header list, no count check, and the shape rule applies only to tables the file creates.
- **The plan** (`plan_restore`) is deterministic from the request and the check. Its fingerprint covers the target, the mode and new name, Run as is, the file's path, size and SHA-256, and the setup and drop statements Contura adds.
- **Modes:**
  - **Into a new database**, named (default `<database>_restore_<mmdd>`; SQLite: a new file, never over an existing one). A failure or Cancel removes it.
  - **Into an existing database that must be empty**; the radio is disabled with "<database> is not empty" otherwise.
  - **Replace** the tables the file holds: every DROP is listed first, with the danger fill and banner. On MySQL, "Back up these tables first" is on by default.
- **Transactions.** PostgreSQL and SQLite restore in one transaction (apart from `CREATE DATABASE`), and any failure or Cancel rolls everything back. MySQL commits each DDL statement, runs each table's rows in one transaction, and stops at the first error with "n of m statements ran".
- **At the end** the row counts are compared with the header; the file's SHA-256 is compared again before COMMIT, and a mismatch gives `FileChanged`.
- **Single statements only.** Every statement runs by its own single-statement call: PostgreSQL extended protocol, MySQL prepared statement (text fallback on 1295), SQLite prepare. Never `simple_query`, `batch_execute` or a multi-statement COM_QUERY.

## Rulings from the build

- **R1.** `tests/common/backup_fixture.rs` holds the fixture per Dialect; the round trips extend it.
- **R2.** Service code in `connections/backup.rs` and `connections/restore.rs`, Tauri commands in `job_commands.rs`, TS clients in `src/api/jobs.ts`, as steps 7 and 8.
- **R3.** No command palette exists; the entries are tree menus only (Back up..., Restore... on database and schema rows; Restore... on Connection rows).
- **R4.** The Core returns the new SQLite file's path; "Add it as a Connection" is a UI tick.
- **R5.** Header values are percent-encoded; the trailer ends with LF; `drop-tables: yes` only when on.
- **R6.** Built in three parallel lanes (Core, restore engine, UI), one cargo user at a time.
- **R7.** MySQL order is tables, rows, routines, views (dependency order), triggers. A view may call a function, so routines come before views; triggers stay last so they never fire on load.
- **R8.** Structure items carry a kind and an owning table. On MySQL, indexes and Foreign Keys live inside `SHOW CREATE TABLE`, so that tick is shown on and disabled with a hint.
- **R9.** Per-routine `sql_mode`, the reading session's `sql_mode` pinned without `ANSI_QUOTES`, dependency order for views, and SQLite skip items on virtual and shadow tables.
- **R10, R15.** Shown order is run order: `CREATE DATABASE` (own line, maintenance connection) when the mode asks, then Contura's session setup (MySQL always includes `SET FOREIGN_KEY_CHECKS = 0`), then Replace drops, then the file. The cleanup line is shown separately.
- **R11.** Skipped statements are left out of what is shown and run unless Run as is; each statement carries its own 5a label (`setval` is labelled as a write).
- **R12.** Job commands take a UI-made `job` id and return nothing, like steps 7 and 8.
- **R13, R32.** Cheap user-visible minors were folded into the fix rounds.
- **R14.** The shape rule's literal list gains exactly the forms Contura writes: PostgreSQL `decode('<hex>', 'hex')` and MySQL or PostgreSQL `ST_GeomFromText('<literal>'[, <int>])`, literal arguments only. Any other call is shown in full.
- **R16.** Plain SQL files are accepted, as above.
- **R17.** One owner per file across lanes: the Core's serde types follow `api-contract.md`.
- **R18.** PostgreSQL Replace needs a known schema (the dialog's schema row or the header); without one Replace is disabled with a reason. Every DROP is schema-qualified.
- **R19, R20, R22, R26: where INSERT shapes end.** After any statement that could change where unqualified names land or run code, every later INSERT is shown in full: MySQL `USE`; PostgreSQL `SET search_path` and `SET SCHEMA` (an empty `search_path` is not a redirect, R20), matched in quoted and `U&"..."` forms too; any `set_config` call; `SET ROLE` and `SET SESSION AUTHORIZATION`; any `SELECT`, `DO`, `CALL`, `EXECUTE` or `PREPARE`; an INSERT, UPDATE, DELETE or MERGE shown in full that calls a function; `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER`, `CREATE RULE`, `CREATE EVENT TRIGGER`; statements starting with `(`, `TABLE` or `EXPLAIN`, and `CREATE TABLE .. AS`. Contura's own Backups have none of these before their rows (`setval` sits after them), so their shapes stay.
- **R21.** On PostgreSQL the "Enums and sequences" tick follows Tables (shown on and disabled while Tables is ticked).
- **R23.** A value that would make one INSERT exceed 16 MB fails the Backup, naming the table and the row's key, and the partial file is deleted, because Restore could not read that statement.
- **R24.** The shape rule accepts PostgreSQL `INSERT ... OVERRIDING SYSTEM VALUE VALUES` and compares SQLite names unquoted (bare, `"x"`, `[x]`, `` `x` ``).
- **R25.** `BackupRequest.localDate` (the user's own date) names the default file; UTC only as a fallback.
- **R27: the accepted residual.** Code the file itself creates (functions, defaults, checks, generated columns, casts, operators, materialized views) can run during a shape INSERT. Every such CREATE is shown in full in the confirmation, so nothing runs that the user was not shown. Ending shapes after every CREATE FUNCTION would cost every Contura Backup with routines its shapes.
- **R28, R31: binding.** `start_restore` carries the reviewed plan's fingerprint on every Connection, not only Production, because the confirmation shows exact SQL everywhere. Start first verifies and spends the Job pass against the reviewed fingerprint (before any full file read, so a large file cannot outlive its pass), then builds the plan and requires its fingerprint to equal the reviewed one before the first write. The streaming re-hash before COMMIT stays the file guard.
- **R29: drops.** PostgreSQL Replace also drops same-named enums and types and the standalone sequences the file creates, listed in the drops like tables, views, functions and triggers. Tables drop first, then the functions their triggers call, then sequences, then types.
- **R30: backup first.** MySQL "Back up these tables first" backs up exactly the tables Replace will drop, through an internal table filter on `BackupRequest`, before any DROP. If it fails, nothing is dropped.
- **R33.** A Backup does not write a sequence owned by a table it leaves out (no CREATE, no `setval`), so a PostgreSQL Replace over a schema that keeps its partitioned table does not collide with that table's own sequences.

## Testing

Unit tests cover the format, the structure writers on fixture catalog output, the classification and shape rule, and the fingerprint. Live tests (`backup_structure`, `backup_job`, `restore_run`, `backup_round_trip`) run as `dbview_test` on MySQL 8 and PostgreSQL 17 and on SQLite temp files. The round trips back up a fixture with every type family (20,000 rows; a 100,000-row run is `#[ignore]`), restore it into a new database, over a changed copy in Replace mode, and into the emptied source, and compare `schema_snapshot`, the definitions of views, routines and triggers, per-table counts, every row through `RowSource`, that the trigger did not fire on load, and the next identity and auto-increment insert. Since step 10, Schema Compare is the structure oracle as well: comparing the source with the restored copy finds no differences (ADR 0022). The 1,000,000-row memory runs are in the end-of-roadmap pass.

## Known limits

- **PostgreSQL Foreign Keys or views that reference a table the Backup leaves out** (a partitioned table, another schema) fail at restore.
- **PostgreSQL functions that name a table's row type, or `BEGIN ATOMIC` bodies**, are created before the tables, so they fail on restore; `check_function_bodies = false` covers only plain bodies. Domain columns fail the same way, since domains are not included.
- **`DROP TABLE IF EXISTS` without `CASCADE`** (Add DROP TABLE on PostgreSQL) fails when another object depends on the table.
- **SQLite runs a deferred `BEGIN`**, so the write lock is taken only at the first write, and a writer on the same file in between can make the restore fail.
- **A standalone sequence shared by several tables**: Replace's `DROP SEQUENCE` fails while a kept table still uses it. The restore stops and rolls back, so nothing is lost. A kept table whose default calls a sequence owned by a left-out table fails the same way.
- **A Production restore reads the file four times**: the check pass, the plan at confirm, the re-check at start, and the run.
- MySQL Replace is not atomic: dropped tables are gone if the restore fails, which the dialog says, and Back up these tables first is on by default.
- A `localDate` computed again at Run time can refuse a MySQL Replace across local midnight with a "file changed" message; checking again fixes it.
