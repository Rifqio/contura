# Rename DB View to Contura

The app is now **Contura**. "DB View" described a viewer, and the scope grew past viewing databases: it queries, designs Schema Models, applies DDL and has an AI assistant. The name is changed while the only releases are pre-releases (v0.4.0 and v0.5.0, shipped as `db-view-*.exe`). Their users keep the data folder as it is, and their saved secrets move over through the Credential Manager migration below. Later release assets are named `contura-*`, and the GitHub repo becomes `Rifqio/contura`.

## What changed

- Product name, window title, error captions, UI copy, Core messages, the generated-SQL header comment and the Postgres `application_name`.
- Names: the executable and Cargo package are `contura`, the Tauri library is `contura_lib`, the Core crate is `contura-core` (folder `crates/contura-core`), the npm package is `contura`, the Tauri identifier is `com.contura.app`.
- Credential Manager: the secrets service name is now `Contura` (accounts are unchanged: a Connection id, or `AI/<provider>`). On start, every saved Connection and AI account with a `DB View` entry and no `Contura` entry is copied across, read back and compared, and only then is the old entry deleted. If any step fails the old entry stays, a copy that did not read back equal is removed, and the app starts anyway; nothing secret is logged. The next start tries again; when both entries already match, it only deletes the old one. Only `DB View` entries for those accounts are ever touched.
- Leftovers accepted: deleting a Connection removes only its `Contura` entry, so a `DB View` entry that never migrated stays behind. After upgrading, delete the old `db-view.exe`: its identifier differs, so the single-instance guard does not stop it running beside Contura on the same `data\`, and once migrated it finds no saved passwords or AI keys.
- Environment: the data folder override is `CONTURA_DATA_DIR`; `DBVIEW_DATA_DIR` still works when the new one is unset.

## What did not change

- The data folder: `data\` next to the exe keeps its name and format, so there is no store migration (ADR 0006).
- The test servers: the `dbview_test` account, the `dbview_test_*` database prefix and the `DBVIEW_TEST_*` environment variables belong to server-side setup that needs the database admin to rename.
- Older ADRs, plans and specs keep the name they were written under.
