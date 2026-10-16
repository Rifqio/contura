# A query session per query tab, holding its open result

Each query tab gets its own database connection, a **Query Session**, opened when the tab has an open Connection and closed with the tab. It is not taken from the browsing pool, so a long query never blocks the object tree or a table grid. A background task owns the connection and handles one command at a time: run a statement, fetch more rows, close the result, close the session. Because the connection lasts, a typed `BEGIN` ... `COMMIT`, a `SET`, or a temporary table works across the tab's statements; otherwise each statement commits on success. Closing a session rolls back a transaction left open. That also happens, for now without a prompt, when the tab's Connection or database changes, the Group changes or the Connection is edited; asking first needs each Dialect to report whether a transaction is open.

Results come a page at a time (1,000 rows, ADR 0003). The first page returns with the statement; **the rest stay on the server** in the same open result, and Fetch next 1,000 reads the next page from it. Only the newest result of a session can fetch more: running anything else, closing the result tab or closing the session abandons it, never by reading it into memory. Rows the server has already sent are drained for up to 250 ms; only a result still being produced after that is cancelled, because a Postgres cancel that arrives after the result ends would stop the next statement instead. Cancel and the Connection's timeout use the Dialect's own cancel, from outside the busy session:

- Postgres: the client's cancel token, over a new connection with the same TLS choice.
- MySQL: `KILL QUERY <id>` from a pool connection. A killed `SLEEP` or `BENCHMARK` ends with an ordinary row, so a row result after a requested cancel is reported as cancelled.
- SQLite: the connection's interrupt handle.

Rows travel as the text the server sends (Postgres simple protocol, MySQL text protocol), so every type shows as the server formats it, with column types from a prepare (Postgres) or the result's column metadata. Long values are cut to the 1 KB preview; an ad-hoc result has no row key, so its full value opens from the table view.

## Considered and rejected

- **Re-running the statement with `LIMIT`/`OFFSET` for each page.** It repeats the whole cost of the query per page, gives a different page when the data or the plan changes, and does not work for statements that are not plain SELECTs.
- **Reading the whole result.** It breaks the memory budget (ADR 0003) on any large table.
- **Running queries on the browsing connection.** A long query would block the tree and grids, and a typed transaction would leak into browsing.
