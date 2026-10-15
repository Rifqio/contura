# Per-Dialect database crates instead of sqlx

The Core talks to each Dialect through its own crate (`tokio-postgres`, `mysql_async`, `rusqlite`) behind a shared `Dialect` trait, not through `sqlx`. DB View shows arbitrary query results whose column types are only known at runtime. The native crates handle that more completely than `sqlx`, which is built around compile-time-checked types. They also let SQLite run without an async runtime and keep only the drivers we use. The cost is writing type mapping and introspection three times.
