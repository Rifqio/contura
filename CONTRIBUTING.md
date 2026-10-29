# Contributing

## Prerequisites

- Node 22 and stable Rust.
- On Linux, the Tauri 2 libraries: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

## Run the app

```sh
npm install
npm run tauri dev
```

## Live database tests

The Core tests run against real servers: MySQL 8.4 on 127.0.0.1:3306 and Postgres on 5432, with the user `dbview_test` / `dbview_test`. The exact setup (grants and server settings) is in `.github/workflows/checks.yml`. The tests fail, not skip, without a server.

## Before a pull request

```sh
cargo fmt --all
cargo clippy --workspace --all-targets --features contura-core/test-util -- -D warnings
cargo test -p contura-core --no-fail-fast
npx tsc --noEmit
npx vitest run
```

One topic per PR, with a conventional prefix (`feat:`, `fix:`, `docs:`). The rules that hold everywhere are in [AGENTS.md](AGENTS.md).
