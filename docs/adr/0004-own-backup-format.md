# Backups are DB View's own SQL scripts, not pg_dump/mysqldump

A Backup is a plain SQL script (schema plus INSERTs) that the Core generates itself, and a Restore runs that script. We don't call `pg_dump` or `mysqldump`. Those tools would have to be installed on the PC, they don't cover SQLite, and they'd make Backup behave differently for each Dialect. The trade-off is that some Dialect-specific objects, such as Postgres extensions, may not be captured. A Backup is therefore not a full replacement for the native tools.
