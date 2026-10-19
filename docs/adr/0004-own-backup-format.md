# Backups are DB View's own SQL scripts, not pg_dump/mysqldump

A Backup is a plain SQL script (schema plus INSERTs) that the Core generates itself, and a Restore runs that script. We don't call `pg_dump` or `mysqldump`. Those tools would have to be installed on the PC, they don't cover SQLite, and they'd make Backup behave differently for each Dialect. The trade-off is that some Dialect-specific objects, such as Postgres extensions, may not be captured. A Backup is therefore not a full replacement for the native tools.

## Amendment (step 9)

Step 9 builds Backup and Restore on this decision. What it settled:

- **What a Backup carries.** Tables, indexes, Foreign Keys, enums, sequences, views, routines, triggers, checks, generated columns and rows. Anything Contura cannot write is listed by name in the header's `not-included` line (for example a PostgreSQL extension, large objects, grants and roles), so a Backup never claims more than it holds.
- **Structure is the server's own DDL text for the same Dialect.** MySQL `SHOW CREATE ...`, PostgreSQL definitions from its catalog with `search_path` empty so names come back qualified, SQLite `sqlite_master.sql` verbatim. No translation between Dialects.
- **The frame is SQL comments.** A header of `-- key: value` lines, `-- section: ...` markers, and a trailer as the last line, `-- contura-backup-end statements=N rows=M`. Any SQL client can run the file. A file with a Contura header and no trailer is incomplete, and Restore refuses it. A file with no Contura header is plain SQL.
- **MySQL `DEFINER=` clauses are removed**, and the header says so (`-- definer: removed`). Restore then creates routines, views and triggers owned by the user who restores.
- **SQLite may also be copied as a file.** The Backup can offer an exact `VACUUM INTO` copy beside the script.
- **Restore's Job pass covers the file's SHA-256.** On a Production Connection the confirmed plan fingerprints the file's hash. The file is hashed again while it streams, and a mismatch before COMMIT rolls back with `FileChanged`.

- **Settled during the build** (ADR 0021 has the rulings): the binding covers every Connection, not only Production, because Restore always shows its exact SQL (R28, R31); a value that would make one INSERT exceed 16 MB fails the Backup, since Restore could not read it (R23); a sequence owned by a table the Backup leaves out is left out with it (R33); MySQL writes routines before views and triggers last (R7).

The trade-off stands: a Backup is still not a full replacement for `pg_dump` or `mysqldump`.
