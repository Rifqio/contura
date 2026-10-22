# Contura

Contura is a personal database client for Windows and Linux. It connects to MySQL, PostgreSQL and SQLite, and it is meant to feel like Navicat while using less memory. On Windows it is one portable exe that keeps its data beside itself; on Linux it comes as a .deb or an AppImage. It was called DB View until 2026-10-16.

## Screenshots

![Home with a Group, an open Connection and its object tree](docs/screenshots/home.png)

A Group with one open Connection and the tables of its database.

![A query tab with a JOIN query and its results](docs/screenshots/query.png)

A query tab: SQL on top, the result grid below.

![A table opened in the data grid](docs/screenshots/table-data.png)

A table opened in the data grid, with column types and the primary key marked.

![Schema Builder with DBML beside the diagram](docs/screenshots/schema-builder.png)

The Schema Builder after reverse engineering a database: DBML text on the left, the diagram on the right.

![The AI assistant panel beside a query tab](docs/screenshots/assistant.png)

The AI assistant panel on a Production Connection. The answer's SQL is labelled as a write and can be inserted into the editor, where nothing runs until you press Run. The "Sends" line lists what left the PC and says the AI Context is in step; a separate Context line appears only when the AI Context needs attention.

## What it does today

- Connections and Groups. A Group holds the Connections for one context of work. Every Connection is in one Group or in Ungrouped.
- Object tree for each Connection: databases, schemas, tables, views and routines.
- Data grid for tables and views, with paging and a WHERE filter. Edit cells, add and delete rows as Pending Edits, preview the SQL, and save them in one transaction.
- SQL editor with completion, inspections, Query History (the last 1,000 statements per Connection) and Saved Queries.
- Schema Builder. Edit a Schema Model as DBML text or on a diagram, and the two stay in step. Reverse engineer an existing database into a Schema Model. Export it as a CREATE script or as an image.
- AI assistant, in the editor and in a side panel. It gives real answers from a provider you set up yourself (OpenAI-compatible, Anthropic Claude, Groq, DeepSeek or a local model). Each Connection has an access level that decides what an Ask may send: nothing, schema only, schema and query text, or those plus sample rows. A "Sends" line shows exactly what leaves the PC, and the Core builds it. The AI Context is a local index of your schema, so a question sends only the tables it needs. Nothing the assistant writes runs on its own: you insert the SQL and press Run.
- Production and Read-only Connections. A Production Connection shows the exact SQL and asks before anything that writes. A Read-only Connection blocks every write, and the server session is opened read-only as a backstop.
- Home with Group cards and a Recent column of what you opened last.
- Two themes, Alucard (light) and Dracula (dark), or follow the system. Code and data use JetBrains Mono with ligatures.
- Passwords are kept in the OS keyring (Windows Credential Manager, the Secret Service on Linux), not in files.

## How it works

The Core is written in Rust and talks to the databases. The window is Tauri 2 with a React front end. Its settings, Groups, Connections (without passwords), Query History and Saved Queries live in one data folder, so you can copy the folder to move them. Settings, Data folder shows where it is.

- Windows: a single portable exe with no installer. The folder is `data` next to the exe.
- Linux AppImage: `data` next to the AppImage file when that folder can be written to, otherwise as for a .deb.
- Linux .deb: `$XDG_DATA_HOME/contura`, which is `~/.local/share/contura` by default.

Nothing leaves the PC except what you send to an AI provider that you set up yourself.

## What's next

- Table Designer
- Visual Query
- More diagram types

## Build from source

You need Node.js and a Rust toolchain on Windows.

```
npm install
npm run tauri dev
```

To build the exe without an installer:

```
npx tauri build --no-bundle
```

The exe is written to `target\release\contura.exe`.

To run the front end tests: `npm test`.

## License

Personal project; no license yet.
