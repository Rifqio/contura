<h1 align="center">Contura</h1>

<p align="center">
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Rifqio/contura?style=flat-square&label=release"></a>
  <a href="https://github.com/Rifqio/contura/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Rifqio/contura/total?style=flat-square"></a>
  <a href="https://github.com/Rifqio/contura/actions/workflows/checks.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Rifqio/contura/checks.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/Rifqio/contura?style=flat-square"></a>
  <img alt="Windows and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational?style=flat-square">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/banner-light.png">
    <img src="docs/banner.png" width="900" alt="Contura: a fast, light database client with an AI assistant that never runs anything on your database by itself. Connects to MySQL 8.0+, PostgreSQL 13+ and SQLite; Redis coming in 1.1. In the app: SQL editor, table data, Visual Query, DBML schemas, diagrams, AI assistant, Transfer, Compare, Backup and Restore. Coming in 1.1: Local servers and an MCP server. Windows and Linux, Rust core, Tauri 2, MIT licence.">
  </picture>
</p>

https://github.com/user-attachments/assets/76da62f5-007a-44d4-b823-575ae181bd7f

Contura is a small database client for MySQL, PostgreSQL and SQLite, with an AI assistant that writes SQL for you to read. It never runs anything on its own.

No account, no cloud, no telemetry.

## Download

<p align="center">
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white"></a>
  &nbsp;
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Download for Linux" src="https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black"></a>
</p>

| | |
|---|---|
| **Windows 10/11** | `Contura_x64_portable.exe`, no installer |
| **Ubuntu / Debian** | `Contura_amd64.deb` |
| **Other Linux** | `Contura_amd64.AppImage` |

The builds aren't code-signed yet. If Windows SmartScreen warns you, choose More info, then Run anyway.

**Databases:** MySQL 8.0+, PostgreSQL 13+ and SQLite (built in).

## What it does

**SQL editor.** Completion from your real schema, JOINs from your Foreign Keys, and errors underlined as you type.

<img src="docs/screenshots/query.png" alt="The SQL editor with suggestions open and results below" width="900">

**Table data.** Filter, sort and edit like a spreadsheet. Changes wait until you press Save, then go in one transaction.

<img src="docs/screenshots/table-data.png" alt="billing.invoices with an edited cell, a new row and the Save bar" width="900">

**Visual Query.** Drag tables in, tick columns, and read the SQL it writes.

<img src="docs/screenshots/visual-query.png" alt="Visual Query with three tables joined" width="900">

**Schemas and diagrams.** Design schemas in DBML. Draw ER, flowchart, sequence, state, class and cloud diagrams side by side on one board.

| | |
|---|---|
| <img src="docs/screenshots/schema-builder.png" alt="A schema written as DBML beside its diagram" width="440"> | <img src="docs/screenshots/diagram-cloud.png" alt="A cloud architecture diagram on AWS" width="440"> |
| <img src="docs/screenshots/diagram-sequence.png" alt="A sequence diagram of paying an invoice" width="440"> | <img src="docs/screenshots/diagram-flowchart.png" alt="A flowchart written as text beside its drawing" width="440"> |

**AI assistant.** Bring your own provider: Anthropic, OpenAI-compatible, Groq, DeepSeek or a local model. Each Connection decides what it may see, and every answer keeps a full log of what was sent.

<img src="docs/screenshots/assistant.png" alt="The Ask panel showing an answer and what was sent" width="900">

**Move data.** Import, export, backup, restore, Data Transfer between databases, and Schema Compare.

## Safe by default

- **Production** Connections show the exact SQL and ask before any write.
- **Read-only** Connections block every write.
- An UPDATE or DELETE without WHERE always asks first.
- Passwords and AI keys stay in the system keyring.

<img src="docs/screenshots/production.png" alt="Contura asking before an UPDATE runs on Production" width="900">

## Coming in 1.1

Redis, local database servers you start with one switch, and an MCP server.

## Build from source

You need Node.js 22 and a stable Rust toolchain. On Linux, also the Tauri 2 system libraries (WebKitGTK 4.1, GTK 3).

```sh
npm install
npm run tauri dev            # run it
npx tauri build              # Linux: .deb and AppImage
npx tauri build --no-bundle  # Windows: the portable exe in target/release
npm test                     # front-end tests
cargo test --workspace       # core tests
```

Contura is a Tauri 2 app: a Rust core talks to the databases, and a React front end draws the window.

## Star history

<a href="https://star-history.com/#Rifqio/contura&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Rifqio/contura&type=Date&theme=dark">
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=Rifqio/contura&type=Date" width="600">
  </picture>
</a>

## License

[MIT](LICENSE). Made by [Rifqio](https://github.com/Rifqio). If Contura helps you, a star tells me it was worth sharing.
