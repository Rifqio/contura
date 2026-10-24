# The AI Context is a local index of the schema, kept in step by a fingerprint

The Assistant sends the tables a question needs, not the whole schema. To pick them it keeps an AI Context per (Connection, database, schema) in `app.sqlite`: one card per table, a Context Tree of Areas, and a full-text index. ADR 0010 holds (consent per Connection, Core-built Sends); ADR 0025 covers the rails that check what goes out.

**Storage.** Migration 5 adds the `ai_context_meta`, `ai_context_node` and `ai_context_card` tables, the `ai_context_fts` FTS5 table, and the `ai_topic`, `ai_topic_fts` and `ai_compaction` tables of thread memory. Cards are built from a `schema_snapshot`. There are no embeddings: retrieval is names, synonyms, foreign keys, open tabs and FTS5 rank. `app.sqlite` gets a 1 MB page cache (`set_cache_kib(1024)`) so the index does not grow the memory budget (ADR 0003).

**The fingerprint.** `schema_fingerprint` is one catalog read per Dialect, with no table scan, that changes when structure changes and stays equal when only rows do. SQLite reads the file's schema cookie (`schema_version`). MySQL counts and CRC-sums the columns, key usage, indexes and tables in `information_schema` for the database. PostgreSQL hashes the relations, attributes, defaults, constraints, indexes, comments and enum labels of the schema.

**Sync.** Automatic is the default: an Ask checks the fingerprint at most once a minute per Context (`CHECK_EVERY_MS`), and a successful DDL statement, a Pending Edits Apply or a tree Refresh marks the Context stale. Manual never queries until Re-sync. A stale mark covers the whole Connection. Re-sync rebuilds; Clear deletes the Context (also done when AI access goes to Never and when the Connection is deleted). A failed check or build keeps the last Context. The preview never fingerprints: a Context it builds has none, and the first Ask adopts the fingerprint of a recent build instead of building again.

**Tiers.** Tier 1: when every card fits the schema budget, all go in full, from a fresh snapshot. Tier 2: tables are ranked from the stored Context and the best that fit go in. Tier 3: above 150 tables (`OUTLINE_MIN_TABLES`), for models with a 32k window or more (`OUTLINE_MIN_WINDOW`), a weak tier 2 ranking sends the Context Tree outline to the model once, and the model picks at most 3 Areas and 20 tables. A name the model invents that is not in the Context is dropped.

**Saved queries** are stored masked (`mask_literals`) and sent only at level 3 and 4 (schema and query text).

**Thread memory.** Topics break by rule only (idle time, a new place or Connection, a changed subject) and each has a rule-made or model-made summary. History is sent only through the gate on the Connection's AI access. At 85% of the window (`COMPACT_AT_PERCENT`) the Assistant compacts the older turns into a summary, which the user can show and Undo. Retention is 50 threads per place and 200 messages per thread, cut in whole turns. ADR 0027 adds where each question was asked, a summary of that tab and the Recent steps to the stored question, replayed through the same gate, which then also reads the current access of every other Connection the tab spanned.

**Sample rows** are read live from the database at Ask time, 5 per table (`SAMPLE_ROWS`), each cell cut at 200 characters (`CELL_CHARS`), secret columns redacted, and never written to `app.sqlite`.

## Considered and rejected

- **A vector index.** It needs an embedding model, either a download or a call that sends schema text to a provider for indexing; names, foreign keys and FTS5 pick the tables well enough.
- **A separate `ai.sqlite`.** A second file to back up, clear and migrate for data that is derived and small; the existing store already has migrations and the Clear paths.
- **The provider writing at index time.** Cards come from the catalog; a model call to describe tables would send schema text with no Ask and no Sends line.
