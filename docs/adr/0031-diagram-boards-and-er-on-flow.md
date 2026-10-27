# Diagram boards: one .flow, many frames; ER back on .flow

**Status:** accepted, 2026-10-25 (owner: ".flow in order to make it uniformed", "keeping dbml works"). Spec: `docs/superpowers/specs/2026-10-25-diagram-boards-design.md`. Plan A: `docs/superpowers/plans/2026-10-25-boards-plan-a-file-and-language.md`.

## Context

Contura's diagrams are text first: a `.flow` file in an editor beside a canvas. The owner wants people to draw without knowing a language is underneath, on one canvas that holds a flowchart, an ERD and a sequence diagram side by side, each dropped from a `+` menu and each writing its own code.

The second reason is the assistant. Someone who mixes a flowchart, an ERD and a sequence diagram in one place should be able to ask "is my flowchart for creating an order correct?" and hear "no step writes `orders.shipping_address`, which the ERD has". That needs the assistant to see every diagram at once, from one source of truth. One file, one language, every kind.

ADR 0030 had made DBML the only ERD and removed the `er` kind. The owner reversed that for boards ("keeping dbml works"): the ER kind returns on `.flow` so a board is uniform, and DBML and the Schema Builder stay for real databases.

## Decision

Plan A builds the file and the language. The canvas that draws many frames is Plan B. Decisions 1 to 13 of the plan:

1. **Frame separation.** A frame is a slice of the file. The first frame runs to the second header. Every later frame starts at a header line: column 0, `diagram`, a known kind, then a space, tab, quote, `//` or the end of the line. Braces do not matter, so a half-typed group never swallows the next frame. Blank lines between frames belong to no frame, and the writer puts exactly one between frames. A file with one diagram is one frame, byte for byte as before.
2. **A frame is named by its title.** Titles are unique on a board. A repeated title is an error that says "Rename the second one". The layout file and the assistant key frames by title, because an index moves every key when a frame is inserted.
3. **Loose sketches live in the layout file** (`<name>.flow.layout.json`), never in the `.flow` text, so the `.flow` stays a language a developer can diff and paste.
4. **Positions are slice offsets plus the frame's start.** Each frame is parsed alone from its slice, and `parseBoard` shifts problems, fixes, spans and edits at one seam. The existing parser, edits, clipboard, insert and completion code does not learn about boards.
5. **Interim tab.** Until Plan B, the diagram tab draws the first frame and canvas edits target frame 0. The text pane shows and checks the whole file. Superseded 2026-10-26 by Plan B1: the diagram tab draws every frame on one canvas (ADR 0019, Canvas and motion).
6. **Colours.** `color:` takes the six presets, any CSS colour name in any case, or a hex of 3, 4, 6 or 8 digits. The writer writes a hex quoted. A custom colour draws its outline in the colour and its fill as a light tint over the surface, with the words in the theme's text colour, so a dark colour stays readable in dark mode. Presets keep their tokens.
7. **`--` is a dotted line with no arrowhead** in data flow, flowchart, cloud, state and mind map. A class diagram keeps `--` as the UML association it already is.
8. **Fan-out.** Commas separate names at either end of an arrow: `A > B, C` is two links, `A, B > C` is two, and `A > B, C > D` makes every pair segment by segment. A label and a colour belong to every link of the last segment. One statement makes at most 100 links (`MAX_FAN_LINKS`). A node statement still reads a bare comma as part of its name, so old files read as before, and the writer quotes any name that holds a comma. A sequence message goes to one participant, so a comma there is an error.
9. **Participants take attributes.** `participant` and `actor` lines take `[icon: .., color: .., label: ..]`. Written participants come first, in the order written, then the rest by first use.
10. **ER syntax.** A table is `name [kind, icon: .., label: .., color: ..] {` with one column per line and `}` on its own line; a table with no columns may be a bare name. A column is a name, a type and the flags `pk`, `not null` and `unique`. A relationship is `orders.customer_id > customers.id`, with `>` many to one, `<` one to many, `-` one to one and `<>` many to many (DBML's operators). Either end may be a whole table. A dotted name resolves by the longest prefix that names a table (at most four dots). A group is `group Billing [icon: .., color: ..] {`.
11. **Old ER files.** An old `table.column` line or an old cardinality (`1--*`, `*--1`, `1--1`, `*--*`, `--`) marks the frame as old form. The first old problem carries the quick fix "Rewrite as table blocks", which rewrites the whole frame (`migrateOldEr`), and every edit on such a frame is refused with a note until then.
12. **Board limits.** At most 50 frames (`MAX_BOARD_FRAMES`) and 10,000 shapes across all frames (`MAX_BOARD_SHAPES`). The per-diagram text and node limits stay. Paste, Mermaid insert and Add frame refuse what would pass the shape limit.
13. **The Core lists a board and an ER diagram.** A file with a second header is listed as kind `board`, titled by its file name (`DiagramKind::Board`); an ER file is listed as `er`. The Core finds a second header by reading the file line by line up to `READ_MAX` (5 MB). The first-line read stays 4 KB.

### Four spec contradictions and how they were resolved

1. The spec's "`--` for a dotted line, so every kind has the same arrows" collides with the class kind, where `--` is the UML association. Class keeps it (decision 7). The owner may overrule.
2. The spec's code-pane chip for a sequence diagram shows `> arrow`, but a sequence message is `->` and `>` is refused there. Sequence arrows do not change; Plan B's chip should read `-> message`.
3. "A shape drawn on empty canvas is saved in the board file" against the roadmap's "loose sketches saved in the layout file". A board is the `.flow` plus its layout file, so decision 3 meets both.
4. The spec's `orders [icon: cart] { total decimal pk }` puts a column on the brace line. The language reads one column per line, as every other block in `.flow` is written (decision 10). The one-line form is shorthand in the spec, not a syntax.

## Consequences

- Old files are unchanged. A file of one diagram is a board of one frame and reads and writes byte for byte as before.
- Until Plan B, the canvas draws frame 0 only. The text pane shows the whole file.
- The Core lists `board` and `er` kinds; the diagram tab opens ER diagrams again, with table cards and crow's-foot ends, and Open as DBML (`openAsDbml`, `erFrameToDbml`) reads either form.
- DBML and the Schema Builder are unchanged. They stay the way to design a real database, to export SQL and to reach a Connection. ADR 0030's "Moves to 1.1" list stands.
- Two one-way copies join the two worlds: Open as DBML turns an ER frame into a Schema Model, and "From my database" draws a frame from a Connection's catalog. Neither writes back.
- A board is parsed per frame and reuses the parse of every frame whose text did not change; the perf and memory gates in Plan A measure it at the frame and shape limits.
- "From my database" is built (Plan B2, decision 16). It reads one schema, uses bare table names, and leaves out references that point outside that schema and counts them (`modelToErFrame`). It adds a new diagram, and a typed Title names it. The copy stays one way.

## ER editing on the board (Plan B3, 2026-10-26, amended 2026-10-27)

Plan B3 brings ER editing back onto the board's table cards. Where the plan and the build differed, this note describes what was built.

Decisions, a sentence each:

1. Restore in place: the old ER canvas, relate and scroll modules come back at their old paths with every test name kept and text assertions in block form; a restored test that no longer applies is replaced by a named one, never dropped.
2. Writes are Plan A's ops, unchanged (`addColumn`, `setColumn`, `setColumnFlag`, `addLink` with column ends and the rest); no new op. Each runs under the gesture's frame and is tracked, so a frame switch waits for it, and a refusal's note shows in the open field or the strip.
3. A column needs no table name inside braces, so every table edits its columns on the card, and a type may contain spaces (written quoted). A relationship to or from a table whose name needs quotes is refused with a note, and its ports are not drawn.
4. A drop with no arrow given writes the referring column first with `>`, two key ends write `-`, and a drag from a table onto another writes a new column and the line in one batch; a drop on a table of another frame writes nothing and says why.
5. Live is per node: the card readers gate on `isStaticId`, a static card takes no events, and a double-click on a column in a static frame selects the frame and opens that field once it is live.
6. One store per tab, `createErStore()`, read per card through `useErCard(table)` and keyed by table.
7. A card draws at most 20 rows and a window of them (`erRowWindow`, `ER_ROW_OVERSCAN`); ports show on the hovered card (`PORTS_LINGER_MS`) and the table selected alone.
8. A frame switch commits an open card field, then ends every ER mode (selected column, aim, "Add relationship to...", keyboard pick). A field the worker refuses, immediately or later, keeps its typed text and holds the switch or the tab drag.
9. Tools: Table (R), Column (C) and Relationship (A) keep their keys. Every table add opens a new-table overlay that writes only on keep; a double-click on empty canvas in a live ERD opens it, and Add here stays for other kinds. The Shelf's Table and Weak table do the same.
10. Keys with a column selected: Tab and Shift+Tab step through columns, Enter or F2 edits, K and N toggle key and not null, Ctrl+Enter or Ctrl+D duplicates, Delete deletes, Ctrl+C and Ctrl+X copy and cut, Shift+F10 or the Menu key opens the menu, and Esc goes up one level (column, table, frame, nothing).
11. A copied column is its line as it reads inside the braces (`columnLine`, no comment), and `planColumnPaste` reads only that line or the old `table.column type` form; the pasted column is selected. The menu Paste and Ctrl+V are the same act.
12. The column, table and line menus are restored, with the line menu's cardinality list and "Swap direction"; the table menu gains a keyboard route.
13. Show in the text for a column asks the worker for the row's span and selects at the column name.
14. A column or relationship written from the card, a draft row, a paste or a drop bands its new line in the pane.

Owner answers (26 Oct):

1. Card rows scroll only in the selected frame. Over an unselected frame the wheel pans or zooms the board, the card shows its first 20 rows, and lines to rows below meet the card's bottom edge.
2. A double-click on a column in an unselected frame selects the frame and opens that field at once.
3. Ctrl+C on a column copies the line as it reads inside the braces, with a spaced type quoted.
4. Column types may contain spaces.

Pre-flight owner calls (taken by autopilot, 26 Oct): an answer 2 kept and rebuilt by position because static frames are inert; the Relationship tool infers the arrow and a Shapes line pick forces it; every ER table add opens the new-table overlay and a table drag counts as a click (drawSQL, dbdiagram); in a live ERD a double-click on empty canvas opens the overlay (drawSQL).

Rulings made while building, where they differ from the plan: the row window comes from the visible pixel range (no blank strip under a scrolling card) and the "+ column" control hides by opacity so the keyboard reaches it; a table-port drag onto another table in an ERD runs the reference plan; a keyboard pick aims by name, not index, and resets when its column is gone; cut copies only the lines between the copied tables and deletes the cut table's other lines (draw.io); a status region stays mounted and changes its text; hovered ER rows use an ER-scoped tint so contrast holds. The memory and time numbers are in ADR 0019, "Memory and large diagrams", and are provisional until the release build is measured.
