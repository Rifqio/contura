<h1 align="center">Contura</h1>

<p align="center">
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Rifqio/contura?style=flat-square&label=release"></a>
  <a href="https://github.com/Rifqio/contura/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Rifqio/contura/total?style=flat-square"></a>
  <a href="https://github.com/Rifqio/contura/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Rifqio/contura/ci.yml?branch=main&style=flat-square&label=CI"></a>
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

## Why I built it

My everyday database tool felt heavy. I wanted one small app with a Rust core that does what I reach for every day (browse tables, write queries, design schemas, draw diagrams, move data) and then stays out of my way.

I also wanted an AI assistant I could trust near a real database. So in Contura the assistant writes SQL for me to read, and I press Run. It never runs anything on its own, and on a Production Connection the app asks before anything that writes.

And I wanted my data to stay mine: no account, no cloud, no telemetry. Contura is the tool I wanted for myself, and I am sharing it in case you want it too.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Contura with a query, its results and the AI assistant answering beside it" width="900">
</p>

## Download

<p align="center">
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white"></a>
  &nbsp;
  <a href="https://github.com/Rifqio/contura/releases/latest"><img alt="Download for Linux" src="https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black"></a>
</p>

| | |
|---|---|
| **Windows 10/11** | `Contura_x64_portable.exe`: no installer. Put it in any folder and run it. |
| **Ubuntu / Debian** | `Contura_amd64.deb`: `sudo apt install ./Contura_*.deb` |
| **Other Linux** | `Contura_amd64.AppImage`: `chmod +x` it and run. |

macOS is not supported yet.

## Supported databases

| Database | Versions |
|---|---|
| <img alt="MySQL" src="https://img.shields.io/badge/MySQL-4479A1?style=flat-square&logo=mysql&logoColor=white"> | 8.0 and newer. MariaDB works through the MySQL support, but I have not tested it. |
| <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white"> | 13 and newer |
| <img alt="SQLite" src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white"> | Built in, nothing to install. Open any `.sqlite` or `.db` file. |

Contura is the client: bring your own server. Local servers you can start from the app are coming in 1.1.

## A quick tour

### Write SQL that knows your database

The editor reads your schema in the background, so completion offers real tables and columns, understands aliases, and can write a whole JOIN from your Foreign Keys. Mistakes are underlined as you type, with a quick fix on `Ctrl+.`. Results load 1,000 rows at a time, and Esc cancels a running query on the server. Every statement goes into Query History, and the ones worth keeping become Saved Queries.

<img src="docs/screenshots/query.png" alt="The SQL editor with column and table suggestions open, and the last results below" width="900">

### Browse and edit data without writing SQL

Open a table and work with it like a spreadsheet: filter it in words ("status is paid"), sort, edit a cell, add or delete a row. Nothing is written straight away. Changes wait as Pending Edits until you press Save, and then go in one transaction. Discard throws them all away.

<img src="docs/screenshots/table-data.png" alt="billing.invoices filtered and sorted, with one edited cell, one new row and the Save bar" width="900">

### Build queries by dragging

Drag tables onto the Visual Query canvas and Contura joins them from their Foreign Keys. Drag one column onto another for a join of your own. Tick the columns you want, then set filters, grouping, sorting and a limit. The SQL is written as you go; open it in the editor whenever you want to take over by hand.

<img src="docs/screenshots/visual-query.png" alt="Visual Query with customers, invoices and payments joined, and the Columns panel open" width="900">

### Design schemas in DBML

Write the schema as [DBML](https://dbml.dbdiagram.io/) on the left and the diagram follows on the right. It works both ways: add a table, rename a column or draw a Foreign Key on the canvas, and only the lines that change are rewritten. Start blank, from a `.dbml` file, or from a database you already have. When it is ready, export SQL or an image, or apply it to a Connection through a Sync Script you review first. This is where entity relationship diagrams live in Contura.

<img src="docs/screenshots/schema-builder.png" alt="The billing schema written as DBML beside its diagram" width="900">

### Draw diagrams from text

A diagram is a short text file (`.flow`) that Contura draws, and edits on the canvas go back into the text. There are nine kinds: data flow, flowchart, cloud architecture, sequence, state, class, mind map, timeline and ER. One file can hold a whole board of several diagrams, each in its own frame, all on one canvas. Add opens the Shelf: pick a diagram kind, an icon or a shape on the left, or start from a template on the right, with one search over both. A new diagram lands in the middle of the view. Tap Space or press `/` and a small box opens at the pointer; Enter drops your pick there, and Tab grows it into the Shelf. Templates cover single diagrams and whole boards. "From my database" draws an ER diagram of one schema from a Connection, and "From Mermaid" brings a Mermaid diagram in as a new diagram. On Home, New diagram opens the same catalog in a dialog. With nothing selected, use the toolbar keys to draw (a selected frame shows its own kind's keys): `V` select, `H` hand, `F` a Section, `N` a note, and `R`, `O`, `D`, `A`, `L`, `P` and `T` for shapes, lines, pen and text. Hold Space and drag to pan. ER diagrams on a board are for sketching tables and relationships; to design a real database, use the Schema Builder above, which writes SQL and reaches your Connection, and Open as DBML turns an ER frame into one. In an ER diagram you edit tables where they sit on the board: rename a table or a column and change a column's type in place, add a column or paste one, and draw a relationship between two columns by dragging from one to the other, with the Relationship tool, or from the keyboard. Tables, columns and relationships each have a right-click menu. Cloud diagrams come with AWS, Azure, Google Cloud and Kubernetes icons. Publish any diagram as PNG or SVG.

The assistant can draw too: describe a change ("add a Redis cache between the API and the database"), review each proposed change, and undo the whole set with one Ctrl+Z. It only ever edits the diagram's text, never a database.

| | |
|---|---|
| <img src="docs/screenshots/diagram-cloud.png" alt="A cloud architecture diagram of a freight app on AWS" width="440"> | <img src="docs/screenshots/diagram-k8s.png" alt="A Kubernetes diagram with an ingress, services, deployments and a PostgreSQL StatefulSet" width="440"> |
| Cloud architecture on AWS | Kubernetes |
| <img src="docs/screenshots/diagram-sequence.png" alt="A sequence diagram of paying an invoice" width="440"> | <img src="docs/screenshots/diagram-flowchart.png" alt="A flowchart of order fulfilment written as text beside its drawing" width="440"> |
| Sequence: paying an invoice | Flowchart: order fulfilment |

### Ask the AI, keep the control

Bring your own provider: OpenAI-compatible, Anthropic, Groq, DeepSeek, or a local model through Ollama or LM Studio. Contura has no AI service of its own; your key talks to your provider directly. Each Connection decides what the assistant may see: nothing, the schema, your current query, or sample rows. Every answer shows the steps it took and a Sends line with exactly what left your computer. SQL from the assistant goes into the editor for you to read and run.

<img src="docs/screenshots/assistant.png" alt="The Ask panel showing each step of an answer and exactly what was sent" width="900">

### Move and compare

Import and export CSV, JSON, Excel and SQL. Back up a database to a script and restore it later. Data Transfer copies tables between Connections, even MySQL to PostgreSQL, and shows how each column type maps before anything is copied.

Schema Compare puts two databases side by side, coloured like Git: green added, red removed, amber changed. It writes a Sync Script where anything that could lose data starts unticked, and nothing runs until you have read it and confirmed.

<img src="docs/screenshots/transfer.png" alt="Data Transfer mapping MySQL types to PostgreSQL" width="900">

<img src="docs/screenshots/compare.png" alt="Schema Compare with added, removed and changed objects in colour" width="900">

## Safe by default

- **Production** Connections show the exact SQL and ask before anything that writes, including what you type yourself.
- **Read-only** Connections block every write, and the database session itself is opened read-only.
- An UPDATE or DELETE without WHERE always asks first.
- Passwords and AI keys live in the system keyring, never in files.

<img src="docs/screenshots/production.png" alt="Contura asking before an UPDATE written by the assistant runs on a Production Connection" width="900">

## Your data stays yours

No account, no cloud, no telemetry. Settings, Connections (without passwords), Query History and Saved Queries live in one data folder; copy it and you have moved everything.

| Version | Data folder |
|---|---|
| Windows portable | `data` next to the exe |
| Linux AppImage | `data` next to the AppImage, when that folder can be written to |
| Linux .deb | `~/.local/share/contura` |

Only two things ever leave your computer: what you send to an AI provider you set up yourself, and, if you turn it on, the update check.

**Updates** are off until you turn them on (Contura asks once, on first start; the switch is in Settings > Updates). When on, it asks github.com once a day for the release manifest (`latest.json`), with no cookie, no token and no version number. Update and restart downloads the one new file, checks its signature and checksum, and only then replaces the program; the data folder is not touched. On Windows and in the AppImage that is one click; the .deb shows a link to the new release.

## Light and dark

Dark and Light, one click on the moon at the right end of the status bar. Code and data are set in JetBrains Mono.

<img src="docs/screenshots/light-dark.png" alt="The same window in the Light and Dark themes" width="900">

## What I'm building next

1.1 comes through the built-in updater:

- **Redis Connections.** A key browser with values beside the key list and edits in place, a Workbench with completion and help, a CLI and profiler, a memory report, and Pub/Sub. Production and Read-only safety apply to Redis too.
- **Local servers.** Start PostgreSQL, MySQL, MariaDB or Redis on your own machine with one switch and nothing to install. A server is downloaded the first time you start it, checked against its checksum, listens on 127.0.0.1 only, and gets its Connection made for you. On Windows, Redis is Valkey, built by Contura's release pipeline.
- **MCP server.** AI tools that speak the Model Context Protocol, such as Claude Desktop or Cursor, can use your Connections through Contura to read schemas and run queries, under the same rules: Read-only stays read-only, and Production asks you before anything that writes. Off until you turn it on, and you choose which Connections it sees.

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
