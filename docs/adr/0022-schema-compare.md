# Schema Compare is a structural diff; the Core alone builds the Sync Script and Apply runs exactly what was shown

Step 10 adds Schema Compare: the structure of two databases of the same Dialect (on PostgreSQL, one schema against one schema), or a Schema Model against a database, shown as added, removed and changed items, with a Sync Script that makes the target match the source. The Schema Builder's "Apply to Connection..." opens the same compare with the model as the source. This ADR builds on ADR 0016 (the Table Designer's planners and runner, used as a library), ADR 0013 (Production and Read-only), ADR 0018 (Jobs) and ADR 0007 (the Schema Model).

## Compare

- **A structural diff of two Schema Models.** Each database side is read by `schema_snapshot`; a model side is the UI's DBML parse. One pure, deterministic `diff(source, target, options)` (`compare/diff.rs`) serves both uses. Nothing reads rows, except the data-loss counts below.
- **Normalised first** (`compare/normalise.rs`): type synonyms and case, MySQL display widths (but `tinyint(1)`), `serial` as an integer with increment, default casts and `now()` spellings, and a sequence default that is the column's own (PostgreSQL `pg_depend` OWNED BY on a live side; the `<table>_<column>_seq` name only where ownership is unknown). Names fold as the Dialect folds them; MySQL reads `lower_case_table_names` from the target server.
- **Matching.** Tables and columns by name; indexes by column list and uniqueness unless both sides name them; Foreign Keys by columns and referenced table and columns; the primary key by its columns; enums by name, values in order. Renames show as a removal plus an addition.
- **Same Dialect only.** Another Dialect, or the same database and schema on both sides, is refused with `InvalidInput` and the spec's sentence. A Schema Model is only ever the source.
- **Not compared, never hidden.** Views, routines, triggers, checks, generated column expressions, expression and partial indexes, comments where the Dialect has none, and tables in another schema are counted per side. "No differences" only appears when there are no items and both sides left out the same things; the screen always names what was not compared.
- **Stable item ids** (`column:billing.invoices.fax:removed`), so a selection survives comparing again.
- **Data loss.** Removed tables and columns and narrowing changes are data-loss items. Their rows are counted on the target (`count(*)` or `count(col)`, 2 s statement timeout each), falling back to the server's estimate, shown as "about". Data-loss items start unticked.

## The Sync Script

- **Built only in the Core.** `plan_sync` (`compare/script.rs`) turns the ticked items into 5c `DesignEdit` lists and plans them with 5c's planners, using the target's `table_design` for the real names of keys and indexes the snapshot hides. The UI sends only the selection and the hash of the statements it showed; statements never come from the UI.
- **Groups and order.** 1. Drop, 2. Change, 3. Create. On MySQL, where each DDL statement commits, `DROP TABLE` and `DROP COLUMN` move to the end of the script, so an earlier failure leaves data in place. The list keeps the groups; the script shows the real order.
- **Selection closure.** Unticking an item unticks everything that needs it; ticking an item ticks what it needs. A not-scriptable item reached through a dependency is refused before planning, naming the item and its reason. A ticked not-scriptable item makes the plan `CopyOnly`, which Apply refuses.
- **Fresh every time.** Compare, plan, confirm and apply each read both sides again and rebuild the diff and the script with the same functions. `apply_sync` refuses with `PlanChanged` when the rebuilt statements' hash differs from `expected_hash`, on every Connection, not only Production.

## Apply

- **A Job of kind Sync.** Progress is "Statement n of m"; Cancel stops between statements.
- **PostgreSQL** runs the script in one transaction; a failure or Cancel rolls everything back ("Nothing was changed."). The one exception: when a statement uses a new enum value (a default, a column type, a partial index, a CHECK, an array literal), the `ALTER TYPE .. ADD VALUE` statements run first in their own transaction, because a new value cannot be used before it commits. The plan says so (`enumValuesFirst`), and the Production confirmation then does not promise one transaction. A failure after that point leaves the added values in place.
- **SQLite** runs in one transaction, with `PRAGMA foreign_keys = OFF` and `foreign_key_check` around 5c rebuilds as shown statements; a `foreign_key_check` row rolls back.
- **MySQL DDL is not transactional.** Each statement commits. Apply stops at the first failure ("4 of 9 statements were applied. Statement 5 failed: ..."), and Cancel keeps what already ran. The screen says this before Apply.
- **History.** The applied statements are one Query History entry on the target with `changed: true`.
- **After Apply** the tab compares again, so what remains shows.

## Safety

- Compare, the DDL panes and planning are read-only on both sides and need no pass, on Read-only and Production too.
- Apply on a Read-only target is refused (`ReadOnly`). On Production it needs a pass from `confirm_sync`.
- **`PassScope::Sync(ConnectionId, ObjectPath)`** covers the target database (and schema) and follows the exact-set rule of `Edits` and `Design`: it authorizes exactly the confirmed statements, once. A Sync pass never covers a Query, Edits, Design or Job run, and none of those covers a Sync. Read-only always wins.

## Rulings from the build

- **R1.** Service in `connections/compare.rs`, Tauri commands in `job_commands.rs`, the TS client in `src/api/compare.ts`.
- **R2, R7.** The UI wrote the TS contract first; the Core's serde types follow it (`Change` tagged `kind`, definition text as strings).
- **R3.** No command palette; the entries are the tree menus, the Schema Builder's "Apply to Connection...", and later the feature bar's Compare button.
- **R4.** The 5c runner gained a per-statement progress callback (`RunControl`).
- **R5.** The DDL panes and the script are static highlighted text, not read-only editors.
- **R9, R11.** A PostgreSQL sequence is the column's own when `pg_depend` says it is OWNED BY that column, whatever its name, so renamed serial columns stay serial.
- **R12, R14: MySQL's generated indexes.** When a Foreign Key is added, MySQL makes or renames its own index on the key's columns. On MySQL an index on exactly a Foreign Key's columns matches by columns only when its name, on both sides, is one MySQL generates (the key's name, its first column's name, or `<table>_ibfk_<n>`). A user rename on those columns still shows as a difference. Without this, applying a script and comparing again would not be empty.
- **R13.** `enumValuesFirst` is sent with the plan so the Production dialog words the transactions truthfully.

## Testing

Unit tests cover the normalisers per Dialect, the diff over snapshot fixtures (every item kind, matching, schema stripping, not-compared lists, stable ids, deterministic output), the script per Dialect (order, MySQL end drops, `USING`, identity, enum value ordering, SQLite pragmas, real names, selection closure, `CopyOnly`) and the Sync pass. Live tests (`compare_live`) run as `dbview_test` on MySQL 8 and PostgreSQL 17 and on SQLite temp files: compare, apply everything, compare again with no differences; data-loss items left unticked; a failing statement; `PlanChanged`; Production and Read-only; Cancel mid-apply (MySQL keeps what ran, PostgreSQL rolls back); a PostgreSQL failure after the enum values committed; a Schema Model applied to an empty database and then changed. With step 9, `backup_round_trip` uses Schema Compare as its structure oracle: backing up A and restoring it as C, then after Replace and after Into, comparing A with C gives no differences.
