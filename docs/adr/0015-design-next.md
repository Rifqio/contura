# DESIGN.md is the design source; themes are `data-theme` token blocks

`DESIGN.md` is the source for how Contura looks. It replaced an earlier design, which is retired. The look is Alucard (light) and Dracula (dark), JetBrains Mono for code and data, Segoe UI for the interface, 28 px density, and colour only where it means something.

This extends ADR 0008 (themes are token sets). Components still use only tokens, now the DN roles (`--c-*`, `--db-*`, `--syn-*`, `--group`) plus scale and component tokens. A theme is a block of those tokens in `src/styles/tokens.css`, chosen by a `data-theme` attribute on `<html>`:

- `:root, .theme-light` holds Alucard, `:root[data-theme="dark"]` holds Dracula, and the Dracula values repeat inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, so no attribute means "follow Windows".
- Dracula is the default: nothing saved paints Dracula.
- The old `--color-*` names were kept as aliases while screens moved one at a time, then deleted with every `--color-dark-*` token. Only `--color-scrim` remains, set per theme. A test (`src/styles/appCss.test.ts`) keeps old names and literal hex colours out of `app.css` and every component.

The 18 alternate Themes of ADR 0008 are still future work; they will be further token blocks under the same rule.

## The theme choice is a Core setting

The choice (System, Alucard or Dracula) is `UiPrefs { theme }` in the Core, saved with the other settings in the `data` folder beside the exe (commands `ui_prefs` and `save_ui_prefs`), not in WebView storage, so it travels with the folder like every other setting. To avoid a flash of the wrong theme, `main.tsx` applies a mirrored copy from `localStorage` (`contura.theme`) before the first render; once the Core answers, its choice wins and rewrites the mirror. The switch sits in Settings, Appearance, and in the status bar.

## Rulings taken in the restyle

- **R1, faint text:** `--c-text-faint` is 3.88:1 on the Alucard surface and 3.41:1 on the panel, so it is used only for line numbers, placeholders, disabled text, closed database marks, the row-number gutter, NULL, empty-state icons and tree guides. Old faint text moved to `--c-text-subtle` (4.5:1 or better). `appCss.test.ts` enforces the list.
- **R2, status bar:** one window-level `footer.app-status` (24 px). A query tab renders its database, rows, time and `Ln, Col` into it through a portal. The data grid's own `.status-bar` stays the grid footer.
- **R3, server version:** opening a Connection returns the server version, shown in the status bar.
- **R4, custom title bar:** the window has no native decorations. Contura draws the Minimize, Maximize and Close buttons (46 x 40) and the strip drags the window. Close goes through the window's close request, so the Pending Edits guard still asks. Windows 11 snap layouts on hovering Maximize may be lost; accepted.
- **R5, column resize:** a 4 px handle on each grid header's right edge. Leftover width is shared out up to a cap, a column is never narrower than its header, and a resized column keeps its width until the result changes.
- **R6, Recent store:** the last 50 opened queries, tables and Schema Models, with Connection and time, are one JSON value under the settings key `recent_items` (commands `recent_items` and `record_recent`). No store schema change, so an older build still opens the data folder. A Recent open that is still waiting for its Connection is dropped if you go elsewhere meanwhile.
- **R7, export colours:** exports read computed token values from a hidden `.theme-light` element, so an image or SVG uses Alucard whatever the window theme.
- **R8, visible and spoken Production:** chips show `PROD`; accessible names keep the word, such as "Query 1, Production" and "Run on Production".

## Group colours

Groups now pick one of eight slots: teal, indigo, green, gold, lime, sky, violet, pink. The Core reads the nine old names through serde aliases and writes the new slot on the next save, so every saved Group still loads: red and rose become indigo, orange and amber become gold, blue becomes sky, slate becomes pink; green, teal and violet stay.

## Production is a wash plus a hazard

The 2 px amber outline around a grid with Pending Edits is gone. Every editor and result pane of a Production Connection gets the `--c-prod-wash` background, and only a statement that writes gets the hazard: the `--c-prod-subtle` band, a 3 px gutter bar and the note "Writes on <name> (Production)". Run and Save turn into "Run on PROD" and "Save on PROD". Both still open the Production confirm dialog (ADR 0013), which decides nothing new.

## Checks

- Memory (`scripts/measure-memory.ps1`, release exe, one Connection open): 111.8 MB private working set on 2026-10-17 (v0.7.0 was 104.4 MB), under the 150 MB budget.
- Memory after the design parity work (same script, release exe on a fresh data folder, one PostgreSQL Connection open, no table open, 30 s idle): 123.4 MB private working set on 2026-10-18; after the parity fix batches (7b9055c), 105.2 MB. Both under the 150 MB budget. The WebView2 remote debugging port was on for the captures, which adds a little.
- The bundled fonts are four JetBrains Mono faces (about 377 KB); `OFL.txt` ships beside them and in the release folder. Settings, Appearance lists the licences: JetBrains Mono (SIL OFL 1.1), Lucide (ISC), Simple Icons (CC0 1.0).
