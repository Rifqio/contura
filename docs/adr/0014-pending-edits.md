# Pending Edits are written and run by the Core, in one transaction

Edits in a table's data grid stay Pending Edits until Save. The UI only keeps a model of them (`src/edits/pending.ts`) and sends an `EditSet` to the Core. The Core writes the SQL (`edits::plan_edits`), and Save runs exactly that text, so the SQL shown in Preview and in the Production confirmation is the SQL that runs, and the step 5a pass (ADR 0013) covers it unchanged.

## How a save runs

- `plan_edits` writes deletes, then updates, then inserts. Names use the Dialect's identifier quoting and values its string literals. An UPDATE's WHERE is the primary key plus the old value of every edited column; a DELETE's is the primary key.
- `apply_edits` writes the statements again, runs the 5a `authorize` on each (Read-only refuses, Production needs a pass for exactly this set), and runs them in one transaction. Every UPDATE and DELETE must hit exactly one row; otherwise the whole save rolls back with `RowChanged`, and a server error rolls back with `EditFailed`. The edits stay pending in both cases.
- A save on Production uses its own pass scope (`PassScope::Edits(connection, table)`), so a pass for a query tab never covers a save and the reverse. A pass covers exactly the set it was confirmed for; a changed set needs a new confirmation.
- A successful save adds one Query History entry with all its statements.

## Rulings

- **MySQL row counts:** a save opens its own connection with `CLIENT_FOUND_ROWS`, so an UPDATE whose value is the same after conversion (`1.00` to `1`) still counts its row and is not taken for a changed row.
- **Postgres isolation:** a save opens its own client for the table's database, so a page fetch from another tab is never pulled into its transaction. SQLite runs the whole save under the one connection lock, and every exit after BEGIN ends with no open transaction (a COMMIT refused with SQLITE_BUSY rolls back).
- **Old-value check scope:** the old value of an edited column is only compared when its type compares exactly. Approximate numbers (`float`, `double`, `real`, `float4`, `float8`, `double precision`), `json`, `jsonb`, `xml` and binary types match on the key alone, as does any column whose loaded value was binary.
- **MySQL backslashes:** a MySQL text value containing `\` is written as `_utf8mb4 X'<hex>'`, which reads the same with or without `NO_BACKSLASH_ESCAPES`.
- **Number cells** used as keys or old values are checked against a number grammar before they are written unquoted.
- **Key columns** of loaded rows are not editable in the grid; new rows can set them.
- **Tabs:** table tabs stay mounted while hidden, so Pending Edits survive a tab switch. Closing the tab, switching Group, editing the Connection or quitting asks Save, Discard or Cancel. Pending Edits are never kept across a restart.

## Known limits

- A table without a primary key only takes new rows; its loaded rows cannot be edited or deleted.
- Binary cells can only be set to NULL. Loading a binary value from a file is not in 5b.
- Values are typed as text; the server converts them, and a bad value shows as a server error on Save.
- For the types listed under the old-value rule, a change made by someone else to that column is not noticed.
- A server error at COMMIT (a deferred constraint) shows as a generic query error, not with a statement number.

## Checks

- Memory (`scripts/measure-memory.ps1`, release exe, one Connection open, no table tab): 104.4 MB private working set, under the 150 MB budget (5a measured 95.2 MB). Table tabs now stay mounted while hidden, so ADR 0003's "only the current page lives in state" becomes one page per open table tab.
- End-to-end on the release exe against MySQL 8: plain save, long-cell save, Production confirmation with a single-use pass, a forced "row changed" rollback and a Read-only refusal all behave as specified.