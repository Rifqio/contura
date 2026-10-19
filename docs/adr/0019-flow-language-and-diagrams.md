# The flow language and diagrams

Step 6+ adds lineage (B2), the flow language `.flow` (A2), data flow diagrams and flowcharts (C1) and cloud architecture diagrams with packed icons (C1b), on the diagram engine of ADR 0017. The spec is `docs/superpowers/specs/2026-10-18-step6plus-diagrams-design.md`; the screens are artifact PL25Nq2VucRaN5EnF7q4nw (frames 6+.1 to 6+.6) and the motion is artifact LRYTVPCDs26ZQTbHZx7zFq. ADR 0003 (memory budget), ADR 0008 (tokens only) and ADR 0018 (the path guard) still hold.

## The language

- **One text format for three kinds.** The first line is `diagram dfd|flow|cloud "<title>"`. A node is a name with an optional `[kind, key: value, ...]`; links are `>` one way, `<>` both ways, `-` no arrow and `-->` dashed, chains allowed, a label after `:`; groups are `Name { ... }` with an optional `[icon: ...]`; `//` starts a comment. The attributes are `id`, `icon`, `color` (a theme token name) and `table` (`schema.table`).
- **Cloud adds `..>`.** A dotted "assumes" line, a permission rather than data. The text reads it one way, from the first name to the second; the canvas draws it dotted with no arrowhead, as frame 6+.5 does. Only cloud diagrams accept it, and the writer and Mermaid import never write it.
- **Quoting.** One rule for the parser and the writer: `flowModel.ts`'s `RESERVED` (brackets, braces, `:`, `>`, `<`, quotes, a backslash, `//`, a lone `-`, `--`, a line break) puts a name in double quotes with backslash escapes (P2). Line breaks in names and titles are escaped as `\n` and `\r` and read back by the parser and by the Core's scanner (P5).
- **The parser runs in the language worker** (`src/lang/flow/parse.ts`, `service.ts`). It returns the `FlowDoc`, the problems with their fixes and the last good drawing. Ranges stay in the worker: the tab asks for spans, edits and completions by text version, and a request for an old version is answered "stale" (P5, P8).
- **Edits from the canvas are text edits.** `src/lang/flow/edits.ts` returns minimal changes for add, connect, rename, delete, group join and leave, and attributes; the tab applies each list as one CodeMirror transaction, so text and canvas share one undo history. Moves write only the layout file; the `.flow` is not touched (P24).

## Files

- A diagram is `<name>.flow` plus `<name>.flow.layout.json` in `<data>\diagrams\` (answer 1B). The Core builds every path from the name: `list_diagrams`, `read_diagram`, `write_diagram`, `write_diagram_layout`, `rename_diagram`, `delete_diagram` (the Recycle Bin) and `save_diagram_copy` sit on step 7's `write_flow_files` and `PathUse::Flow`, with no second guard (P1). Step 7's own `write_flow_files` and `flow_exists` commands had no caller left and are gone; the Core functions stay (P24).
- One name rule, with the spec's text for every bad name: "Use a name without \ / : * ? " < > | and under 120 characters." It refuses separators, `..`, reserved Windows names (COM0 and LPT0 too), a trailing `.flow`, and names over 120 characters or 200 UTF-8 bytes (P1, P4).
- The `.flow` is written only after a text edit. Moves, Classic and the direction write only the layout file through `write_diagram_layout`, which goes through the same guard and refuses when the `.flow` is gone, so an edit made outside Contura while the tab is open survives them and a diagram deleted outside is never recreated (P24). A file whose every line break is CRLF is saved with CRLF after an edit; a file with mixed line breaks is saved with LF (P16).
- `read_diagram` runs off the main thread and refuses a file over 5 MB with a plain message (P24). The write and rename commands stay sync, so they run in the order sent; Replace, Rename and Delete also wait for a write already on its way (P21, P24).
- A tab's pending write is held by `flowRegistry` across close, rename, replace and delete, so a discarded tab never writes again and a failed save asks before anything is lost (P16, P17, P19, P21). A tab that closed during a held rename or delete writes its edits on the release; if that write fails, the diagram stays in the list as a failed save, so the window close guard tries again and asks (P24). Closing a diagram while its file is being moved or deleted says "Contura is still moving or deleting this file. Try again in a moment." (P24).
- Publish and "Save a copy as..." are the only ways a diagram leaves the folder.

## Lineage

- **From the catalog, never rows.** The Core's `lineage` command reads key edges with one catalog query per schema or database (MySQL `REFERENTIAL_CONSTRAINTS` and `KEY_COLUMN_USAGE`, PostgreSQL `pg_constraint` without partition copies, SQLite `pragma_foreign_key_list` once per table), then one light column read for the tables it reached. It stops at 300 tables or after 10s and says so (P6). It does not call `table_design`, which was too slow for All; a test keeps the two readers' key edges equal.
- **One table's failure is not the lineage's.** Only an error on the centre table fails the call; any other table keeps its card with the reason (P6).
- **Flows from `.flow` files.** `list_flow_table_links` scans `table:` lines without a full parse and returns the access and, for each table node, the process or step that reads or writes it. A step with a `table:` names itself; a store names the processes on its lines (P18).
- **Views.** From the catalog where the server keeps one (PostgreSQL `pg_depend`, MySQL 8.0.13+ `VIEW_TABLE_USAGE`), worded "reads"; otherwise a name match, worded "names", with a note when the catalog read failed (P14, P18).
- **"Before you delete".** The warning reads its own `usedBy` lineage, independent of the toolbar, checks every key column's nullability and defaults, and says "This list may be incomplete." with the reason when it is (P14, P15). While that read runs the block shows its title and "Checking what deleting an order does...", never nothing; Try again keeps the last result on screen while it reads again (P24).
- **No Tidy button.** Lineage's layout is computed, so Reset layout is its Tidy: every moved card glides back with the Tidy timing and the layout file is removed (P23).
- **Layout.** `<data>\diagrams\.lineage\<hash>.layout.json`, named by the first 32 hex digits of a SHA-256 of the Connection, database, schema and table, so no table name reaches the file system; at most 1 MB, through the diagrams guard (P18).

## The icon pack

- `scripts/pack-icons.mjs` reads the official packs from a local folder and writes `src-tauri/icons-pack/icons.bin`: 4,057 names, about 2.6 MB, inflated one icon at a time by the Core (`icon_index`, `icon_sets`, `icon`). The front end keeps at most 200 icons and loads only the ones a diagram shows. The licences and how each set was read are in `docs/research/2026-10-18-icon-licences.md`.
- **Icons are untrusted data.** They are downloaded outside the repo and only the pack is committed (P7). Each SVG passes an allow list, identical in Rust (`icons::unsafe_reason`) and in the script, tested against one shared fixture list: UTF-8 with no control bytes, allowed element and attribute names only, `href` only to a `#fragment`, CSS limited to a plain character set and `url(#...)`, no comment that could close early, under 256 KB (P9, P10, P13). The check runs again when an icon is served.
- **Icons are only ever images.** The UI shows an icon as an `<img>` of a `data:` URL, never as markup, and Publish embeds each one as an SVG `<image>` of the pack's own bytes (P7, P9). Icons are never recoloured, cropped or rewritten.
- **Icon credits** shows each set's licence and source as plain text. An https source is a link that the Core's `open_url` opens in the system browser: the Core checks it again (https only, no user name or password, no spaces or control characters, at most 2,048 characters) and hands it to the shell with `ShellExecuteExW` (no Windows error box; Contura shows the error). The webview never opens a window of its own.

## Canvas and motion

- Node kinds `process`, `store`, `external`, `start`, `end`, `step`, `decision`, `io`, `subprocess` and `service` join the engine with their own token pairs; Modern is the default look and Classic draws the Gane-Sarson shapes, kept per diagram in the layout file (answer 6A).
- Lines route square with 8 px corners (`src/diagram/route.ts`); labels sit on chips; arrowheads are 6 px.
- **One motion table.** Every timed move reads `src/diagram/motion.ts`, and reduced motion (the system setting or the app's own) makes each value 0. Nothing loops; typing, selection, panning, wheel zoom and the dragged node are never animated.

| Interaction | Key | ms |
|---|---|---|
| Hover a node: border to the kind colour | `hover` | 80 |
| Ports fade in | `ports` | 120 |
| A dragged node settles in its cell | `settle` | 120 |
| A drawn flow locks onto a node | `lock` | 80 |
| Add and connect menu, label box | `menu` | 120 |
| Esc pulls a drawn flow back | `pullBack` | 120 |
| A new node fades in from 96 percent | `enter` | 120 |
| A deleted node and its lines fade out | `exit` | 120 |
| Undo glides back | `undo` | 120 |
| The undo toast | `toast` | 180 |
| The selected node's text line is banded | `band` | 120 |
| Tidy glides every node | `tidy` | 240 |
| Zoom to fit, minimap jump | `fit` | 240 |
| Dragging over a group | `group` | 80 |

- A glide frame moves only the gliding nodes, through `livePositions`, never a rebuilt graph (P20).

## Publish

- Every diagram kind and lineage export through the step 6 scene and Publish dialog. The scene gained drawn nodes (with their look, second line, id, link mark and icon), group areas and `flow` lines (dashed or dotted, heads at the end, both ends, the start or none, a label chip). `src/flow/flowScene.ts` and `lineageScene` in `src/lineage/scene.ts` build them from what the canvas draws.
- The crop box snaps to node and group edges within 8 screen px, as the direction spec asks; Alt turns it off, and a kept aspect is not bent by a snap.
- The PNG path frees its canvas and image as soon as the file is encoded, and closing the dialog drops the scene.

## Memory and large diagrams

- Parsing and layout run in the language worker; over 300 nodes the canvas runs in fast mode and draws only what is visible.
- A canvas change, and the end of a glide, keep the measured size of every node that draws the same (same type, size and data), because React Flow draws every node it has not measured: before this, each edit, move or Tidy drew all 2,000 nodes of a large diagram for a frame. A node whose content changed is measured again, so its ports stay right. This holds for canvases whose node data is stable between changes (the drawn diagrams and lineage); the Schema Builder builds new card data on every change, so its cards are measured again (carried, not a regression).
- `large_flow_2000_nodes_smooth` checks fast mode, visible-only drawing and the frame time of a drag frame in jsdom; the parse, edit and glide budgets are the worker gates in `npm run test:perf` (best of three 20-run medians under 16 ms, P8).

## Rulings and their costs

The full ledger is `.superpowers/sdd/2026-10-18-step6plus-diagrams/progress.md`.

- **P1, one name rule on step 7's guard.** Cost: step 7's more specific name messages are gone.
- **P2, the parser reads every file step 7 writes**, proved by a round trip over the step 7 and Mermaid fixtures. Cost: none.
- **P3, tests never touch the user's own state.** Delete is tested through an injected trash function; the real Recycle Bin test is `#[ignore]`. Cost: the real Recycle Bin call is checked only in the deferred pass.
- **P4, the Task 1 fixes.** Checks run before any rename, a rename never adopts an orphan layout file, one unreadable entry does not fail the list, and the Recycle Bin call runs off the main thread. Cost: none.
- **P5, nesting capped at 20 and ranges kept in the worker.** The parser and writer are iterative; the posted result carries no ranges. Cost: a group may not nest deeper than 20; one more round of work.
- **P6, lineage reads the catalog once per schema, with a 10s limit.** Cost: a second catalog reader to keep in step with `table_design`.
- **P7, icon packs are untrusted.** Cost: a few icons may be left out.
- **P8, stale requests and a noise-proof perf gate.** Edits on a version with a parse waiting answer stale and flush it; the gate is the best of three medians. Cost: a parse that is slow only now and then (one run in three) can pass; a parser that is slow every time still fails.
- **P9, P10 and P13, one allow list in two twins.** Cost: 9 icons were first left out (7 of 39 Kubernetes icons, including the control plane and ConfigMap, and 2 Google Cloud icons), recorded for the user (P12), who kept them.
- **P11, the Task 5 fixes** (straight runs within 0.5 px, zoom by the motion table, the name box in fast mode, selection never animated). Cost: none.
- **P12, keep the 9 icons through three narrow exceptions** (user, 2026-10-19): `type` on feColorMatrix only, as `matrix`, `saturate`, `hueRotate` or `luminanceToAlpha`; a `-inkscape-*` style declaration whose whole value is one quoted string of `A-Z a-z 0-9 space , . -`; and `<a>` only with no `href`, `xlink:href` or `*:href` and no attribute off the list. Both twins carry them, tested by the shared fixtures with each abuse refused. Cost: the allow list is no longer purely character-level for quotes, so CSS declarations are split to check them.
- **P14 and P15, the delete warning tells the truth.** Its own read, nullability and defaults checked, incomplete lists said so. Cost: one extra lineage read when the panel opens.
- **P16 and P17, the file is the user's.** Text kept as read, CRLF kept, a worker restart reparses, closes and Discard go through the close guard. Cost: CRLF is converted on save rather than kept as CodeMirror's line separator.
- **P18, lineage rows name the process, and the layout file name is a hash.** Cost: none.
- **P19 and P21, Replace, Save a copy, Delete and Rename never lose or resurrect text.** Cost: the text is read-only while a rename runs.
- **P20, glides touch only the moving nodes**, with a perf gate on 2,000 nodes. Cost: the gate times the computation and the patch, not React Flow's adoption, so the real-app Tidy check stays.
- **P22, Task 11 minors and `open_url`.** Cost: none.
- **P23, the Task 12 fixes.** The end of a glide keeps measured sizes; lineage has no Tidy, Reset layout is its Tidy and glides (P14 and P18 superseded on this point); the lineage Publish button sits beside Reset layout; a link that opens clears the last failure; Windows shows no error box of its own; a group with a missing icon shows the swatch on the canvas as in the export; Selected nodes is off when no selected node is drawn. Cost: no Tidy button on lineage.
- **P24, the final review's fix wave.** Layout-only saves never write the `.flow` (`write_diagram_layout`); the delete warning says it is checking while its read runs; lineage Reset waits for a layout save on its way; Replace and Rename wait for a write on its way; a failed write after a hold is marked as a failed save; `read_diagram` capped at 5 MB and off the main thread; Nothing linked says it checked diagram arrows only; a Join badge's kept focus is forgotten with its canvas; the close guard says why during a hold; the unused step 7 commands removed; lineage's edge de-dupe is linear. Cost: an outside edit is still overwritten if the user then edits the text in Contura (no check of the file's time before a text save).
- **W5, the real-app checks are deferred** to the end-of-roadmap pass (the user's ruling of 2026-10-18 is newer than the rule to compare real-app shots before merging UI work), as for step 7. Cost: the items under Deferred checks are not a merge gate.
- **W4, Task 9 ran in the other worktree** while Task 6 ran here. Cost: small merge conflicts in the tab registry, resolved at the merges.

## Accepted limits

- Links to a group are valid text (Mermaid writes them) but the canvas and Publish draw lines between nodes only.
- MySQL `lower_case_table_names=2` is not handled by lineage; Aurora MySQL 3 views fall back to name matches.
- NFC and NFD forms of a name are different diagrams.
- A label is a second undo entry after the line it labels.
- The service tile's id sits beside the tile in an export; the canvas has no textbook look for flowcharts or cloud, so Classic changes only data flow.
- Publish has no pixel cap at 3x (as ADR 0017); the lineage export has no Selected nodes preset, since lineage has no selection.
- Lineage's Diagrams rows come from arrows only: a `table:` node that no arrow touches (joined only by `-` lines, or not joined) is left out, and Nothing linked says "no diagram arrow reads or writes it" rather than claiming no diagram names the table (P24).
- An edit made outside Contura to an open diagram survives moves, Classic and the direction, but a text edit in Contura afterwards saves Contura's text over it.
- Lineage tabs are outside the close guard: a card moved in the last 400 ms before closing may not be saved.
- After a zoom across a level of detail and then an edit, an off-screen node keeps the port positions measured at the old detail until it is drawn, so a line to it may end at an old port until it scrolls into view.
- Provider terms allow icons in architecture diagrams but do not name bundling in an app (Azure is the narrowest); six packed brand logos are CC-BY-SA; brand logos are trademarks. These go to the user before any release.

## Deferred checks

At the user's instruction (2026-10-18), these move to the end-of-roadmap pass and are not a merge gate:

- **Memory** with `scripts/measure-memory.ps1` on the release exe: idle under 150 MB, one 2,000-node diagram fitted and panned under 250 MB, and back near idle after closing it.
- **Real-app frame comparison**: frames 6+.1 to 6+.6 captured from the release exe and compared with the artifact (the lineage toolbar's Publish button is expected: frame 6+.1 draws no control for it, P23), plus the interactions jsdom cannot drive (the live connection line and lock ring, release on empty canvas, Esc mid-drag, minimap jump, box select, Space and middle-button pan, group join and leave highlight, Tidy on a 2,000-node diagram) against the motion artifact.
- **The real Recycle Bin** delete test (`#[ignore]`, P3), and Delete from a tab and from Home Recent.
- **An outside edit survives a move**: edit a `.flow` in another editor while its tab is open, move a node in Contura, and confirm the outside edit is still in the file (P24).
- **`open_url` in the release exe**: an Icon credits link opens the system browser, and a link with no handler shows Contura's message and no Windows box.
- **Zoom, edit, pan** on a large diagram in the real app: lines to off-screen nodes end at the right ports once drawn.

## Checks

`cargo test -j 6 --workspace --features contura-core/test-util`, the clippy gate, `cargo fmt --check`, `npx vitest run`, `npm run test:perf`, `npx tsc --noEmit` and `npm run build` on the step6plus-ui branch.
