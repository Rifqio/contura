# Contura

A portable, open-source database client for MySQL, PostgreSQL and SQLite (Navicat-like, light on memory). One exe that keeps its data in a `data` folder beside itself. It ships for Windows and Linux. It was called DB View until 2026-10-16, so old names remain in env vars, test databases and the legacy keyring service.

## Map

- `crates/contura-core/`: the **Core**, all data access and every rule that matters. One `Dialect` trait (`src/dialect.rs`) over per-dialect crates (`mysql_async`, `tokio-postgres`, `rusqlite`; ADR 0002), `ConnectionService` (`src/connections.rs`) as the facade, the app store (`src/store.rs`, SQLite, `PRAGMA user_version`), the SQL classifier (`src/safety.rs`), the AI assistant (`src/ai/`).
- `src-tauri/`: thin `#[tauri::command]` wrappers over the Core (`src/commands.rs`, `src/job_commands.rs`, registered in `src/lib.rs`). Progress and streams go through `tauri::ipc::Channel`.
- `src/`: React 19 + TypeScript. No state library (reducers, contexts, `useSyncExternalStore` stores). Tauri calls live in `src/api/` (`types.ts` mirrors the Rust serde shapes by hand). Styles are token based (`src/styles/tokens.css`, `app.css`).
- `site/`: the public launch pages, static files published to GitHub Pages by `.github/workflows/pages.yml` (see `site/README.md`).
- Docs: `CONTEXT.md` (glossary: use its terms), `DESIGN.md` (design system), `docs/requirements.md` (requirements), `docs/adr/` (decisions), `docs/icon-licences.md` (icon licences).

## Commands

```sh
npm install
npm run tauri dev                    # the app (Vite on 1420)
npx tsc --noEmit
npx vitest run [paths]               # add --maxWorkers=2 on small machines
cargo fmt --all
cargo clippy -j 6 --workspace --all-targets --features contura-core/test-util -- -D warnings
cargo test -j 6 -p contura-core --no-fail-fast
```

- Live database tests need MySQL on 127.0.0.1:3306 and Postgres on 5432 with the user `dbview_test` / `dbview_test` (override with `DBVIEW_TEST_MYSQL_*` and `DBVIEW_TEST_PG_*`). The MySQL user needs global grants and `log_bin_trust_function_creators=1`; the Postgres user needs `CREATEDB CREATEROLE` but must not be a superuser. Tests make and drop `dbview_test_*` databases. They fail (not skip) without a server. `.github/workflows/ci.yml` shows the exact setup.
- On Linux the ~60 test binaries are large: build with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` or the disk fills.
- Run one cargo process at a time. Live AI tests are `#[ignore]` and read `CONTURA_GROQ_KEY` at run time.
- Before a commit: fmt, the clippy gate, the touched tests (all of `cargo test -p contura-core` for Core changes), `tsc`, and `vitest` for UI changes. CI runs all of them on every push to `main` and every PR.

## Rules that hold everywhere

- **The Core decides.** Data access, SQL generation, safety checks and AI egress all happen in Rust; the UI never builds SQL or calls the network (`connect-src ipc:` in the CSP).
- **Production and Read-only** (ADR 0013): every statement goes through `safety::classify`; unknown is a write. Read-only blocks writes in the Core and also opens the server session read-only. Production writes need a single-use pass bound to the exact SQL. Never add a path that runs SQL around these.
- **SQL text**: values go through `common::sql_string` (and dialect helpers), identifiers through the quoting helpers. Never format a raw value or name into SQL.
- **Egress**: only `crates/contura-core/src/ai/provider/http.rs` (AI) and `crates/contura-core/src/update/http.rs` (the update check, ADR 0026: https to GitHub's hosts only, off until the user turns it on) name `reqwest`; nothing under `update/` names a Connection, the AI or the keyring. For AI: nothing under `ai/provider/` names `ConnectionService`, `SessionHandle` or `Dialect` (`tests/ai_egress.rs`). What is sent follows the Connection's AI access level, goes through the rails (`ai/rails/`), and is shown in the Sends preview first.
- **Secrets**: passwords and API keys live only in the OS keyring (`secrets.rs`); never in the store, logs, fixtures, test output or commits. Tests use the in-memory `SecretStore`.
- No new crates or npm packages without a reason recorded in an ADR. No `aws-lc-rs` in `Cargo.lock`.

## UI copy

- Never an em dash or en dash. Never the words "cursor" or "caret" (say "where you are typing", "the current statement").
- Numbers with grouping commas (`toLocaleString("en-US")`, Rust `common::grouped`); compact units with no space (`12ms`, `0.8s`, `2.3 KB`).
- Use the glossary terms from `CONTEXT.md` (Connection, Group, Production, Read-only, Pending Edits, Schema Model, Ask, Sends, AI access, AI Context).

## Commits and decisions

- Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `ci:`). One topic per PR.
- Record a decision as an ADR in `docs/adr/`. When code changes a documented decision, update the ADR or doc in the same change.

## Platform notes

- Windows only: the Credential Manager wording in the UI, the TextScaleFactor in `window_size.rs` and `measure-memory.ps1`.
- On Linux the keyring needs a Secret Service (for example `gnome-keyring`), and `CONTURA_DATA_DIR` moves the data folder when the exe sits somewhere read-only.
- MySQL on Linux has case-sensitive table names; Windows servers fold them. Tests must pass on both.
