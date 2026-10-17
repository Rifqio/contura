# Contura design system (next)

Status: approved direction, 2026-10-17. It sits beside `DESIGN.md`, which stays the source for the app as it ships today, until a migration adopts this file.
Look: **Alucard** (light) and **Dracula** (dark), one colour family, with **JetBrains Mono** for code and **Segoe UI** for the interface.
Reference build: the "Contura Next Screens" artifact, version 8 (Home, Query workspace on a Production Connection, Schema Builder, AI assistant panel, Flow diagram, Publish image), https://claude.ai/artifact/HQaEgpnALncQp9TdU677MM. Everything below is written so the app can be built without opening it.

Contents
1. Principles
2. Don't list
3. Colour tokens
4. Typography
5. Spacing, density, radii
6. Borders, elevation, layers
7. Focus, selection, states
8. Motion
9. Iconography
10. Components
11. Production and Read-only treatment
12. Accessibility
13. Copy rules
14. Mapping from DESIGN.md
15. Implementation notes

---

## 1. Principles

1. **One family, two lights.** Light is Alucard, dark is Dracula. They share hue roles (pink keywords, green functions, cyan types, purple numbers and accent, orange reserved for Production), so switching theme never changes what a colour means.
2. **Code looks like an IDE.** JetBrains Mono with its ligatures on, everywhere code, data or identifiers appear: editors, DBML and `.flow` text, grid values, hosts, type hints, key hints.
3. **Calm chrome, loud only for meaning.** Chrome is neutral surfaces and 1 px lines. A colour appears only when it answers "what does this mean?": the accent (you are here, act here), a Group's identity square, a Connection's database mark, a semantic state, or Production.
4. **No decoration.** No dots, no coloured stripes or top bars, no tinted card headers, no gradients, no glows, no pill clusters, no emoji, no watermark words. If an element only makes the screen look "designed", remove it.
5. **State is shown by the thing itself, plus words.** A Connection's open state is its database icon in full colour (muted when closed) and the word "Open" where there is room. Colour is never the only signal: a word, an icon or a tooltip label always goes with it.
6. **Hazard where it matters.** Production is felt everywhere through a faint warm wash and named by tags, but the hazard colour itself appears only on the thing that would change Production: a writing statement, Run on PROD, Save on PROD, the confirm dialog.
7. **Dense, aligned, scannable.** 28 px tree and grid rows, 13 px UI text, a 4 px grid, right-aligned tabular numbers, one primary line per list item.
8. **The SQL is the truth.** Anything that writes shows the statement first, in editor styling, with the Connection named above it.

## 2. Don't list

These were rejected by the user and must not come back.

| Don't | Why | Do instead |
|---|---|---|
| Coloured top bar on Home cards (3 px Group stripe) | Read as AI decoration | Neutral card; the Group shows only as the 20 px initial square |
| Tinted card headers (Group tint behind the card title) | Decoration, competes with data | Plain header on `--c-bg-surface` with a 1 px `--c-border-subtle` rule |
| Coloured dot before a Group name (tree, title bar, cards, status bar, diagram areas) | "AI slop" | 16 px initial square in the tree and switcher, 20 px on Home cards |
| Green "connected" dot at the end of a Connection row | "AI slop" | Database icon in full colour when open, muted when closed; "Open" text on Home |
| Hazard bands (striped orange bars) on pane borders, 3 px orange top edge on Production tabs | "Banner on each border is not the right fit" | Data-source wash plus hazard only where a statement or save writes |
| Letter tags `PG` / `MY` / `SQ` as the database mark in lists | Not recognisable | MySQL dolphin, PostgreSQL elephant, SQLite feather (Simple Icons) |
| "Grouped list" Home variant | User prefers cards | Group cards plus the Recent column |
| Flat Recent list with repeated kind words and no dividers | "Too many text, no divider or spacing" | Day sections, 48 px rows, inset hairlines, kind in the tooltip |
| IntelliJ Light as the light theme | "Very regular, been around since the beginning of age" | Alucard |
| Unsaved dot on tabs | Dot | `*` after the tab title |
| Watermark word "PRODUCTION" in the editor | Hidden when the editor is full, reads as decoration | Wash plus write hazard |
| Gradients, glows, glass, coloured `border-left` accents above 1 px, uppercase tracked overlines on cards | Generic AI look | Weight, size and spacing carry hierarchy |

Allowed exceptions: the 2 px by 16 px accent bar marking the selected row (a selection signal, not decoration), the 2 px accent bar beside the current statement, the 3 px Production bar beside a writing statement, uppercase `PROD` and `PRODUCTION` labels (the only uppercase in the app).

## 3. Colour tokens

Names are CSS custom properties, set on `:root` (light) and `:root[data-theme="dark"]`, and repeated inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` for "follow Windows". Components reference roles only, never hex. The two blocks below are the complete sets; the build of the reference screens reads them from this file.

### 3.1 Roles

| Token | Job |
|---|---|
| `--c-bg-app` | Window background behind the islands, title bar, status bar |
| `--c-bg-panel` | Side panes: object tree, Recent column, AI panel, grid header row |
| `--c-bg-surface` | Work surfaces: editor, grid body, Home main area, cards, dialogs |
| `--c-bg-raised` | Menus, popovers, autocomplete, toasts, minimap |
| `--c-bg-canvas` | Diagram canvas (the snap grid sits on it) |
| `--c-bg-hover` / `--c-bg-active` | Neutral hover; pressed and neutral selected (question bubble, neutral chip) |
| `--c-border-subtle` / `--c-border` / `--c-border-strong` | Rules inside panes and row dividers / control and card edges / input bottom edge, radio and switch rings, empty Group square (3:1) |
| `--c-text` / `-muted` / `-subtle` / `-faint` | Primary / secondary labels / tertiary (timestamps, counts, hosts, column types) / line numbers, placeholders, muted icons (3:1, never the only carrier of meaning) |
| `--c-accent` / `-hover` / `-pressed` | Fills under `--on-accent` text: primary button, checked controls, slider |
| `--c-accent-text` | Links and accent-coloured words ("Show exactly") |
| `--c-accent-subtle` | Selection: selected rows and cells, current-statement band (at 50 percent), selected tree row, segmented control "on" |
| `--c-focus` | Keyboard focus ring |
| `--c-{success,warning,danger,info}-text` / `-solid` / `-subtle` | Semantic text, fill and tint |
| `--c-prod-solid` | Production hazard: the writing-statement gutter bar, the Run on PROD and Save on PROD outline, confirm button fill (with `--c-ink` text) |
| `--c-prod-text` / `--c-prod-subtle` | `PROD` and `PRODUCTION` labels (text on tint); writing-statement band |
| `--c-prod-wash` | Data-source wash behind every editor and result pane tied to a Production Connection |
| `--c-group-{slot}` / `-tint` | Group initial-square fill; tint is reserved for user-coloured diagram areas and nodes |
| `--c-gmk-ink` | The initial letter on a Group square |
| `--c-node-{kind}-stroke` / `-fill` | Diagram node kinds |
| `--c-syn-*`, `--syn-kw-weight`, `--syn-type-style` | Syntax highlighting |
| `--c-tree-guide` / `--c-tree-guide-strong` | Tree indent guides; the strong one marks the level holding the selection |
| `--db-mysql` / `--db-pg` / `--db-sqlite` | Database brand marks (open state) |
| `--c-ink` | `#16181a`, dark text on Production and warning fills, in both themes |
| `--on-accent` | Text on `--c-accent` (white in Alucard, `#191a21` on Dracula purple) |
| `--win-close` / `--win-close-ink` | Windows close button hover fill and glyph |

### 3.2 Light: Alucard

Sources: the Dracula spec (draculatheme.com/spec), Alucard Classic: background `#FFFBEB`, foreground `#1F1F1F`, selection `#CFCFDE`, comment `#6C664B`, line highlight `#E2DECA`, UI levels `#EFEDDC` (floating), `#ECE9DF` (lighter), `#DEDCCF` (light), `#CECCC0` (dark), `#BCBAB3` (darker); accents red `#CB3A2A`, orange `#A34D14`, yellow `#846E15`, green `#14710A`, cyan `#036A96`, purple `#644AC9`, pink `#A3144D`. Values not in the spec (muted, faint, tints, wash, Production fill, extra Group slots, tree guides) are derived to the contrast targets in 3.5.

```css
:root {
  --c-ink: #16181a;
  --on-accent: #ffffff;
  --c-bg-app: #ece9df;
  --c-bg-panel: #efeddc;
  --c-bg-surface: #fffbeb;
  --c-bg-raised: #fffbeb;
  --c-bg-canvas: #f8f4e3;
  --c-bg-hover: #e2deca;
  --c-bg-active: #dedccf;
  --c-border-subtle: #e2deca;
  --c-border: #cecbc0;
  --c-border-strong: #8f8a73;
  --c-text: #1f1f1f;
  --c-text-muted: #48432f;
  --c-text-subtle: #6c664b;
  --c-text-faint: #857f66;
  --c-accent: #644ac9;
  --c-accent-hover: #5840b5;
  --c-accent-pressed: #4d37a0;
  --c-accent-text: #5a41bf;
  --c-accent-subtle: #cfcfde;
  --c-focus: #644ac9;
  --c-success-subtle: #e1ecc9;
  --c-success-text: #14710a;
  --c-success-solid: #14710a;
  --c-warning-subtle: #faf4da;
  --c-warning-text: #846e15;
  --c-warning-solid: #c9a227;
  --c-danger-subtle: #fdf1eb;
  --c-danger-text: #cb3a2a;
  --c-danger-solid: #cb3a2a;
  --c-info-subtle: #dbe8ec;
  --c-info-text: #036a96;
  --c-info-solid: #036a96;
  --c-prod-solid: #d06a14;
  --c-prod-subtle: #f8e1c9;
  --c-prod-text: #a34d14;
  --c-prod-wash: #fdf2dd;
  --c-gmk-ink: #ffffff;
  --c-group-teal: #036a96;
  --c-group-teal-tint: #dbe8ec;
  --c-group-indigo: #a3144d;
  --c-group-indigo-tint: #f2d9e1;
  --c-group-green: #14710a;
  --c-group-green-tint: #e1ecc9;
  --c-group-gold: #846e15;
  --c-group-gold-tint: #f3eac2;
  --c-group-lime: #4d6b0f;
  --c-group-lime-tint: #e6edcc;
  --c-group-sky: #2a5db0;
  --c-group-sky-tint: #dde6f5;
  --c-group-violet: #8b2f86;
  --c-group-violet-tint: #f0dcef;
  --c-group-pink: #5a6072;
  --c-group-pink-tint: #e3e4e8;
  --c-node-table-stroke: #478cc4;
  --c-node-table-fill: #eaf5ff;
  --c-node-view-stroke: #8a7abc;
  --c-node-view-fill: #f4f1ff;
  --c-node-enum-stroke: #b07a20;
  --c-node-enum-fill: #fff1df;
  --c-node-note-stroke: #95864c;
  --c-node-note-fill: #faf4dd;
  --c-node-service-stroke: #489a68;
  --c-node-service-fill: #e5faeb;
  --c-node-datastore-stroke: #2695ac;
  --c-node-datastore-fill: #e0f9ff;
  --c-node-queue-stroke: #b26b9b;
  --c-node-queue-fill: #ffeef8;
  --c-node-external-stroke: #868686;
  --c-node-external-fill: #f1f4f6;
  --c-syn-keyword: #a3144d;
  --c-syn-function: #14710a;
  --c-syn-string: #846e15;
  --c-syn-number: #644ac9;
  --c-syn-type: #036a96;
  --c-syn-identifier: #1f1f1f;
  --c-syn-comment: #6c664b;
  --c-syn-operator: #a3144d;
  --c-syn-punctuation: #1f1f1f;
  --c-syn-error: #cb3a2a;
  --c-syn-ref: #644ac9;
  --syn-kw-weight: 400;
  --syn-type-style: italic;
  --c-tree-guide: #c9c6b6;
  --c-tree-guide-strong: #8f8a73;
  --db-mysql: #00758f;
  --db-pg: #336791;
  --db-sqlite: #0f80cc;
  --win-close: #c42b1c;
  --win-close-ink: #ffffff;
}
```

### 3.3 Dark: Dracula

Sources: the official Dracula palette: background `#282A36`, current line `#44475A`, foreground `#F8F8F2`, comment `#6272A4`, cyan `#8BE9FD`, green `#50FA7B`, orange `#FFB86C`, pink `#FF79C6`, purple `#BD93F9`, red `#FF5555`, yellow `#F1FA8C`; chrome one and two steps darker (`#21222C`, `#191A21`) as in Dracula for JetBrains. Diagram node tokens are carried over from the earlier Harbor palette and still pass 3:1 on both canvases (see 3.5).

```css
:root[data-theme="dark"] {
  --c-ink: #16181a;
  --on-accent: #191a21;
  --c-bg-app: #191a21;
  --c-bg-panel: #21222c;
  --c-bg-surface: #282a36;
  --c-bg-raised: #343746;
  --c-bg-canvas: #21222c;
  --c-bg-hover: #343746;
  --c-bg-active: #3c3f52;
  --c-border-subtle: #191a21;
  --c-border: #3b3d4f;
  --c-border-strong: #6272a4;
  --c-text: #f8f8f2;
  --c-text-muted: #c7c8d3;
  --c-text-subtle: #a0a3ba;
  --c-text-faint: #6272a4;
  --c-accent: #bd93f9;
  --c-accent-hover: #caa8fa;
  --c-accent-pressed: #a87bf0;
  --c-accent-text: #c9a6ff;
  --c-accent-subtle: #44475a;
  --c-focus: #bd93f9;
  --c-success-subtle: #233b2c;
  --c-success-text: #50fa7b;
  --c-success-solid: #50fa7b;
  --c-warning-subtle: #3a3b2c;
  --c-warning-text: #f1fa8c;
  --c-warning-solid: #f1fa8c;
  --c-danger-subtle: #43272e;
  --c-danger-text: #ff6e6e;
  --c-danger-solid: #ff5555;
  --c-info-subtle: #24384a;
  --c-info-text: #8be9fd;
  --c-info-solid: #8be9fd;
  --c-prod-solid: #ffb86c;
  --c-prod-subtle: #45372b;
  --c-prod-text: #ffb86c;
  --c-prod-wash: #3b3438;
  --c-gmk-ink: #16181a;
  --c-group-teal: #8be9fd;
  --c-group-teal-tint: #24384a;
  --c-group-indigo: #ff79c6;
  --c-group-indigo-tint: #43293d;
  --c-group-green: #7ddc94;
  --c-group-green-tint: #233b2c;
  --c-group-gold: #e9d98b;
  --c-group-gold-tint: #3a3829;
  --c-group-lime: #c3e88d;
  --c-group-lime-tint: #2f3a29;
  --c-group-sky: #7fb8ff;
  --c-group-sky-tint: #253552;
  --c-group-violet: #e3a8f2;
  --c-group-violet-tint: #3d2c45;
  --c-group-pink: #a9b1d6;
  --c-group-pink-tint: #2f3243;
  --c-node-table-stroke: #599fd8;
  --c-node-table-fill: #152839;
  --c-node-view-stroke: #9d8cd0;
  --c-node-view-fill: #282238;
  --c-node-enum-stroke: #c38c37;
  --c-node-enum-fill: #32230e;
  --c-node-note-stroke: #a8985e;
  --c-node-note-fill: #2d260e;
  --c-node-service-stroke: #5bac7a;
  --c-node-service-fill: #152c1e;
  --c-node-datastore-stroke: #3fa8bf;
  --c-node-datastore-fill: #0a2b33;
  --c-node-queue-stroke: #c57dae;
  --c-node-queue-fill: #341f2d;
  --c-node-external-stroke: #989898;
  --c-node-external-fill: #252728;
  --c-syn-keyword: #ff79c6;
  --c-syn-function: #50fa7b;
  --c-syn-string: #f1fa8c;
  --c-syn-number: #bd93f9;
  --c-syn-type: #8be9fd;
  --c-syn-identifier: #f8f8f2;
  --c-syn-comment: #6272a4;
  --c-syn-operator: #ff79c6;
  --c-syn-punctuation: #f8f8f2;
  --c-syn-error: #ff5555;
  --c-syn-ref: #bd93f9;
  --syn-kw-weight: 400;
  --syn-type-style: italic;
  --c-tree-guide: #3c3f52;
  --c-tree-guide-strong: #6272a4;
  --db-mysql: #5fb6cc;
  --db-pg: #8fb3e3;
  --db-sqlite: #63b4ec;
  --win-close: #c42b1c;
  --win-close-ink: #ffffff;
}
```

### 3.4 Hue rules

- **Orange is Production only.** No Group slot, node kind, syntax role or icon may be orange in either theme. Numbers are purple (not the Alucard spec's orange) for this reason; the MySQL mark is teal, never its brand orange.
- **Purple is the accent only** among UI colours. No Group slot is purple; the closest slot (`violet`) is a magenta plum, hue apart from the accent.
- **Red is danger only.** No Group slot is red.
- **Group slots** keep the Harbor names so existing data maps over; in this family the hues are:

| Slot | Alucard hue | Dracula hue | Note |
|---|---|---|---|
| `teal` | cyan `#036A96` | cyan `#8BE9FD` | Kestrel Foods in the samples |
| `indigo` | rose `#A3144D` | pink `#FF79C6` | Slot name is historical; the hue is rose/pink. Orbit Freight in the samples |
| `green` | green `#14710A` | green `#7DDC94` | Pinecone Labs in the samples; softer than success green `#50FA7B` in dark |
| `gold` | gold `#846E15` | sand `#E9D98B` | Also the primary-key icon colour |
| `lime` | olive `#4D6B0F` | lime `#C3E88D` | |
| `sky` | blue `#2A5DB0` | sky `#7FB8FF` | |
| `violet` | plum `#8B2F86` | orchid `#E3A8F2` | |
| `pink` | slate `#5A6072` | lavender grey `#A9B1D6` | Slot name is historical; the hue is a neutral slate |

Ninth and later Groups reuse slots in order; the initial letter tells them apart. A Group with no colour (Ungrouped, No Group) is an empty square with a 1 px `--c-border-strong` ring.

### 3.5 Measured contrast (WCAG 2.x ratio)

Targets: body text 7:1 where possible and never below 4.5:1; secondary text 4.5:1; UI boundaries, icons and graphics 3:1; `--c-text-faint` 3:1 and never the only carrier of meaning.

| Pair | Light (Alucard) | Dark (Dracula) |
|---|---|---|
| `text` on `bg-surface` | 15.89 | 13.36 |
| `text` on `bg-panel` | 13.98 | 14.81 |
| `text` on `bg-app` | 13.57 | 16.27 |
| `text` on `bg-raised` | 15.89 | 11.06 |
| `text` on `bg-hover` | 12.19 | 11.06 |
| `text` on `accent-subtle` | 10.70 | 8.59 |
| `text-muted` on `bg-surface` | 9.55 | 8.57 |
| `text-muted` on `bg-panel` | 8.41 | 9.50 |
| `text-muted` on `bg-app` | 8.16 | 10.43 |
| `text-subtle` on `bg-surface` | 5.56 | 5.73 |
| `text-subtle` on `bg-panel` | 4.90 | 6.35 |
| `text-subtle` on `bg-hover` | 4.27 | 4.74 |
| `text-faint` on `bg-surface` | 3.88 | 3.03 |
| `text-faint` on `bg-panel` | 3.41 | 3.36 |
| `border-strong` on `bg-surface` | 3.35 | 3.03 |
| `on-accent` on `accent` | 6.24 | 7.19 |
| `on-accent` on `accent-hover` | 7.46 | 8.66 |
| `accent-text` on `bg-surface` | 6.88 | 7.04 |
| `accent-text` on `bg-panel` | 6.05 | 7.81 |
| `focus` on `bg-surface` | 6.02 | 5.90 |
| `focus` on `bg-panel` | 5.30 | 6.55 |
| `focus` on `bg-app` | 5.14 | 7.19 |
| `success-text` on `bg-surface` | 5.96 | 10.38 |
| `success-text` on `success-subtle` | 5.02 | 8.83 |
| `warning-text` on `bg-surface` | 4.80 | 12.74 |
| `warning-text` on `warning-subtle` | 4.50 | 10.20 |
| `danger-text` on `bg-surface` | 4.85 | 5.23 |
| `danger-text` on `danger-subtle` | 4.54 | 4.91 |
| `info-text` on `bg-surface` | 5.78 | 10.29 |
| `info-text` on `info-subtle` | 4.78 | 8.72 |
| `prod-text` on `bg-surface` | 5.58 | 8.36 |
| `prod-text` on `prod-subtle` | 4.58 | 6.72 |
| `prod-text` on `bg-app` | 4.76 | 10.18 |
| `prod-solid` on `bg-surface` | 3.52 | 8.36 |
| `ink` on `prod-solid` | 4.88 | 10.45 |
| `text` on `prod-wash` | 14.85 | 11.36 |
| `text` on `prod-subtle` | 13.03 | 10.74 |
| `syn-comment` on `prod-wash` | 5.20 | 2.57 |
| `text-muted` on `bg-active` | 7.19 | 6.24 |
| `tree-guide` on `bg-panel` | 1.46 | 1.52 |
| `tree-guide-strong` on `bg-panel` | 2.94 | 3.36 |
| `syn-keyword` on `bg-surface` | 7.33 | 5.97 |
| `syn-function` on `bg-surface` | 5.96 | 10.38 |
| `syn-string` on `bg-surface` | 4.80 | 12.74 |
| `syn-number` on `bg-surface` | 6.02 | 5.90 |
| `syn-type` on `bg-surface` | 5.78 | 10.29 |
| `syn-identifier` on `bg-surface` | 15.89 | 13.36 |
| `syn-comment` on `bg-surface` | 5.56 | 3.03 |
| `syn-operator` on `bg-surface` | 7.33 | 5.97 |
| `syn-punctuation` on `bg-surface` | 15.89 | 13.36 |
| `syn-error` on `bg-surface` | 4.85 | 4.53 |
| `syn-ref` on `bg-surface` | 6.02 | 5.90 |
| `group-teal` on `bg-surface` | 5.78 | 10.29 |
| `group-indigo` on `bg-surface` | 7.33 | 5.97 |
| `group-green` on `bg-surface` | 5.96 | 8.50 |
| `group-gold` on `bg-surface` | 4.80 | 10.01 |
| `group-lime` on `bg-surface` | 5.91 | 10.34 |
| `group-sky` on `bg-surface` | 6.15 | 6.92 |
| `group-violet` on `bg-surface` | 7.11 | 7.56 |
| `group-pink` on `bg-surface` | 6.04 | 6.75 |
| `gmk-ink` on `group-teal` | 5.99 | 12.86 |
| `gmk-ink` on `group-indigo` | 7.60 | 7.46 |
| `gmk-ink` on `group-green` | 6.18 | 10.63 |
| `gmk-ink` on `group-gold` | 4.97 | 12.51 |
| `gmk-ink` on `group-lime` | 6.13 | 12.93 |
| `gmk-ink` on `group-sky` | 6.38 | 8.65 |
| `gmk-ink` on `group-violet` | 7.37 | 9.45 |
| `gmk-ink` on `group-pink` | 6.27 | 8.43 |
| `node-table-stroke` on `bg-canvas` | 3.27 | 5.55 |
| `node-view-stroke` on `bg-canvas` | 3.41 | 5.34 |
| `node-enum-stroke` on `bg-canvas` | 3.37 | 5.36 |
| `node-note-stroke` on `bg-canvas` | 3.29 | 5.50 |
| `node-service-stroke` on `bg-canvas` | 3.12 | 5.74 |
| `node-datastore-stroke` on `bg-canvas` | 3.19 | 5.69 |
| `node-queue-stroke` on `bg-canvas` | 3.48 | 5.20 |
| `node-external-stroke` on `bg-canvas` | 3.30 | 5.47 |
| `text` on `node-table-fill` | 14.92 | 14.13 |
| `text` on `node-service-fill` | 15.07 | 13.96 |
| `text` on `node-datastore-fill` | 15.04 | 14.01 |
| `text` on `node-external-fill` | 14.92 | 14.08 |
| `db-mysql` icon on `bg-surface` | 5.14 | 6.14 |
| `db-pg` icon on `bg-surface` | 5.80 | 6.59 |
| `db-sqlite` icon on `bg-surface` | 4.07 | 6.29 |

Known exceptions, accepted on purpose:
- **Dracula comments** (`#6272A4`) are 3.03:1 on the editor and 2.57:1 on the Production wash. This is the official Dracula comment colour, which the user chose; comments are never the only carrier of meaning. Offer a setting "Brighter comments" that swaps in `#939FCB` (5.47:1 on the editor, 4.65:1 on the Production wash).
- **Tree guides** are 1.5:1 on purpose (structure aid, not a boundary); the strong guide is about 3:1.
- **Alucard string, warning and danger text** sit at 4.5 to 4.85:1, the floor; do not lighten their tints further.
- **Dracula danger text on danger tint** is 4.91:1; keep the tint at `#43272e` or darker.

### 3.6 Syntax mapping

| Token | SQL | DBML | `.flow` | Alucard | Dracula | Style |
|---|---|---|---|---|---|---|
| `--c-syn-keyword` | SELECT, JOIN, WHERE, AND, interval, NULL is not a keyword | Table, Ref, Enum, Project, indexes, Note | `diagram` | pink `#A3144D` | pink `#FF79C6` | weight `--syn-kw-weight` (400 in both) |
| `--c-syn-function` | count(), sum(), now(), make_interval() | `note:` key | | green `#14710A` | green `#50FA7B` | |
| `--c-syn-string` | `'overdue'` literals | `'pending'`, defaults | labels after `:` and quoted titles | yellow `#846E15` | yellow `#F1FA8C` | |
| `--c-syn-number` | numbers, `true`, `false`, `NULL` | numbers, `increment`, `true` | ids like `1.0` | purple `#644AC9` | purple `#BD93F9` | |
| `--c-syn-type` | int, varchar, numeric, timestamptz | column types | node kinds `entity`, `process`, `store` | cyan `#036A96` | cyan `#8BE9FD` | italic (`--syn-type-style`) |
| `--c-syn-identifier` | tables, columns, aliases | names | node names | `#1F1F1F` | `#F8F8F2` | |
| `--c-syn-ref` | schema prefix (`billing.`), `$1`, `:var` | `>` `<` `-` ref arrows | edge arrows `>` `<>` `-->` | purple | purple | |
| `--c-syn-operator` | `= <> != >= <= -> ->> => + - * /` | `pk`, `not null`, `unique`, `default`, `:` `,` | `id`, `table` attribute keys, `:` `,` | pink | pink | |
| `--c-syn-punctuation` | `, ; ( ) .` | `{ } [ ]` | `{ } [ ]` | foreground | foreground | |
| `--c-syn-comment` | `--` and `/* */` | `//` | `//` | `#6C664B` | `#6272A4` | italic |
| `--c-syn-error` | wavy underline, 4 px offset, skip-ink off | same | same | `#CB3A2A` | `#FF5555` | |

Grid values: booleans `true`/`false` use `--c-syn-keyword`; `NULL` uses `--c-text-faint` at 12 px; numbers right-aligned in `--c-text`.

## 4. Typography

### 4.1 Families

| Role | Stack |
|---|---|
| Interface | `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif` |
| Display (titles, headings) | `"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif` |
| Code | `"JetBrains Mono", "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace` |

JetBrains Mono is bundled with the app (SIL Open Font License 1.1), weights 400, 600, 700 and 400 italic. The reference page loads it from Google Fonts; the app must not depend on a network font.

**Ligatures are on everywhere JetBrains Mono is used** (editor, grid, hosts, key hints, types):

```css
font-variant-ligatures: contextual;
font-feature-settings: "calt" 1, "liga" 1;
```

Apply these after any `font` shorthand, because the shorthand resets both. Sample SQL in docs and demos should include `!=`, `>=`, `<=`, `->`, `->>` and `=>` so the ligatures show. The status bar and confirm dialogs still print the statement exactly as typed; ligatures change only the drawing of the characters, not the text that is sent or copied.

### 4.2 Scale

| Style | Family | Size / line | Weight | Used for |
|---|---|---|---|---|
| Heading | Display | 20 / 28 | 600 | Home title "Home" only |
| Title | Display | 15 / 20 | 600 | Pane titles ("Recent", "Ask", "Publish image"), empty-state title, dialog titles |
| Subtitle | Display | 14 / 20 | 600 | Section titles inside dialogs and the reference page |
| UI | Interface | 13 / 18 | 400 | All chrome, tree rows, menu items, buttons, Recent titles (13 / 20 in Recent) |
| UI strong | Interface | 13 / 18 | 600 | Tree Group rows, Connection names on cards, active tab, Group names on cards |
| UI small | Interface | 12 / 16 | 400 | Status bar, chips, counts, timestamps, secondary lines, day labels (600) |
| UI micro | Interface | 10 / 14 | 600, +0.04em | `PROD` tag inside Recent rows only |
| Initial | Interface | 11 / 20 (20 px square), 10 / 16 (16 px square) | 600 | Group initial |
| Code | Mono | 13 / 20 | 400 | SQL, DBML and `.flow` editors |
| Code small | Mono | 12 / 16 to 12 / 20 | 400 | Grid cells (12 at 28 px rows), hosts and database names on cards, table and model titles in Recent, AI answer SQL (12 / 18), diagram column types |
| Code micro | Mono | 11 / 16 | 400 | Key hints (`Ctrl+Enter`), grid header type hints, flow node ids |

Rules:
- Every number that is data or a measurement (grid, counts, row ranges, durations, times, sizes, line and column) uses `font-variant-numeric: tabular-nums`. Durations carry units: `48 ms`, `2.4 s`.
- Letter-spacing is 0 except the uppercase `PROD` / `PRODUCTION` labels (+0.02em, +0.04em at 10 px).
- Keywords are not bold in either theme (bold shifts mono alignment); types are italic; comments are italic.
- Truncate with an ellipsis, never wrap, in rows: tree names, tab titles (max 220 px), card hosts, Recent titles and Connection names.

## 5. Spacing, density, radii

**Base unit 4 px.** Steps: 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32.

### 5.1 Fixed heights

| Element | Height |
|---|---|
| Title bar | 40 px (window buttons 46 x 40) |
| Tab | 32 px, max 220 px wide |
| Pane strip (editor header) | 32 px; 36 px for result toolbar and diagram toolbar |
| Grid header row / grid row | 28 / 28 px (compact 24) |
| Grid footer | 32 px |
| Tree row | 28 px (compact 24) |
| Home card header / Connection row | 40 px / 2 lines (about 50 px: 7 px top, 20 + 2 + 16, 8 px bottom) |
| Recent row | 48 px exactly (5 px padding, 20 px primary line, 2 px gap, 16 px secondary line, 5 px) |
| Recent day label | 16 px text, 18 px above (10 px for the first), 6 px below |
| Status bar | 24 px, 6 px above it |
| Buttons and inputs | 28 px; 24 px inside toolbars and on small "Add" buttons |
| Chips | 20 px; 18 px in tabs; 16 px in grid and Recent meta lines; 14 px `PROD` in Recent |
| Key hint | 18 px |
| Suggested Connection row | 40 px |
| Write note under a statement | 24 px |

### 5.2 Layout

- Islands: panes are rounded rectangles separated by 6 px gaps of `--c-bg-app`, with 6 px outer padding below the title bar.
- Object tree pane: 288 px in the query workspace, 264 px beside the AI panel (min 220, resizable, 4 px hit area on a 1 px line).
- AI panel 360 px (min 300). DBML and `.flow` text panes 420 px.
- Home: main area padding 24 px 28 px, 16 px between header, cards and hint; cards in a 2-column grid with 12 px gaps (`repeat(2, minmax(0, 1fr))`, `align-items: start`); Recent column 320 px, padding 20 px 12 px 12 px.
- Tree indent: **20 px per level** on an 8 px base (row padding-left = 8 + 20 x level). Chevron 14 px, 6 px gaps between chevron, icon and name. Counts right-aligned with 10 px right padding.
- Grid cell padding 0 8 px; row-number gutter 48 px.
- Editor gutter 48 px, line number right padding 16 px.

### 5.3 Radii

| Radius | Used for |
|---|---|
| 3 px | Small `PROD` tag in Recent, 16 px Group square, segmented inner options, editor key hints |
| 4 px | Buttons, inputs, chips, key hints, list and Recent rows, focused grid cell, 20 px Group square |
| 6 px | Cards, tabs (top corners), diagram nodes, Suggested Connections box, SQL blocks in the AI panel, segmented control |
| 8 px | Islands (panes), menus, popovers, dialogs, toasts, minimap, question bubble |
| 10 px | Diagram areas (groups of nodes) |
| 999 px | Switch track and thumb, slider thumb, radio, edge-label pills on diagrams. Never a status dot |

## 6. Borders, elevation, layers

- **Lines, not shadows, inside the window.** Islands: 1 px `--c-border-subtle`. Cards, inputs, segmented controls: 1 px `--c-border`. Input bottom edge 1 px `--c-border-strong`. Row dividers: 1 px `--c-border-subtle` (grid), 1 px `--c-border` inset hairline (Recent, from 34 px to 8 px from the right edge).
- **Elevation**
  - Level 0, flat: panes, cards, grid, editor.
  - Level 1, raised: menus, popovers, autocomplete, toasts, floating zoom and minimap. `--c-bg-raised`, 1 px `--c-border`, shadow `0 4px 12px rgb(0 0 0 / .10), 0 1px 2px rgb(0 0 0 / .06)`; dark `0 4px 12px rgb(0 0 0 / .40), 0 1px 2px rgb(0 0 0 / .30)`.
  - Level 2, overlay: dialogs, command palette. Shadow `0 16px 40px rgb(0 0 0 / .18), 0 2px 6px rgb(0 0 0 / .08)`; dark `0 16px 40px rgb(0 0 0 / .55), 0 2px 6px rgb(0 0 0 / .35)`; scrim `rgb(0 0 0 / .32)`, dark `rgb(0 0 0 / .5)`.
  - Crop scrim in the Publish dialog: `rgb(0 0 0 / .45)` outside the crop box.
- **Z-order** (low to high): canvas and panes 0; sticky grid header 1; canvas overlays (zoom, minimap, inset) 10; tab drag ghost 20; menus and popovers 100; toasts 200; dialog scrim 300; dialog 310; tooltip 400.
- Dark theme gets height from lighter surfaces (`--c-bg-raised` is lighter than the editor), so shadows stay soft.

## 7. Focus, selection, states

| State | Treatment |
|---|---|
| Keyboard focus | `:focus-visible` only: 2 px `--c-focus` outline, 1 px offset; inside rows and lists (Recent, tree, cards) the outline is inset (offset -2 px) so it never overlaps neighbours. Grid cell: 2 px inset ring with 4 px radius |
| Hover | `--c-bg-hover` fill; on Recent rows the hairlines above and below the hovered row hide |
| Selected row | `--c-accent-subtle` fill plus a 2 x 16 px `--c-accent` bar, 2 px radius, at the left edge, vertically centred |
| Current statement (editor) | Band `--c-accent-subtle` at 50 percent behind its lines, plus a 2 px `--c-accent` bar in the gutter, 6 px from the gutter's right edge; current line number in `--c-text` |
| Writing statement on Production | Band `--c-prod-subtle`, 3 px `--c-prod-solid` gutter bar, and the write note (section 11) |
| Pending Edit cell | `--c-warning-subtle` fill and a 2 px `--c-warning-solid` inset left edge; with focus, both the edge and the focus ring |
| New row / deleted row | `--c-success-subtle` with `+` in the row gutter / `--c-danger-subtle`, strike-through, `-` in the gutter |
| Disabled | `--c-text-faint` text, no hover; stays focusable when a tooltip says why |
| Unsaved document | `*` after the tab title in `--c-text-muted` 600, labelled "Unsaved changes" |
| Connection open / closed / failed | Database icon in brand colour / in `--c-text-faint` / plus a warning icon and the word "Failed" (section 9.3) |

## 8. Motion

- Durations: 80 ms hover and press; 120 ms menus, tooltips, chips, tab switch; 180 ms dialogs, panel slides, toasts; 240 ms canvas zoom-to-fit and minimap jump. Nothing longer, nothing looping.
- Easing: enter `cubic-bezier(.2, 0, 0, 1)`, exit `cubic-bezier(.4, 0, 1, 1)`; exits are faster than enters. Menus fade and move 4 px; dialogs fade and scale from .98.
- Never animate the data grid (rows, scroll, sort), typing, or the Production wash.
- Running: a 2 px indeterminate bar at the top of the result pane plus elapsed time ticking in the status bar; never a spinner over data.
- `prefers-reduced-motion: reduce` (and Windows "Animation effects" off): all transitions become instant opacity changes; canvas zoom jumps; the running bar becomes a static "Running..." label with elapsed time.

## 9. Iconography

### 9.1 Interface icons

- One set: **Lucide** (ISC licence). Stroke 1.5 at 16 px, 1.75 at 14 px, round caps and joins, `currentColor`.
- Sizes: 14 px in the tree, grid header, chips, status bar and Recent meta lines; 16 px in toolbars, tabs, menus and list rows; 20 px only in empty states and dialog titles.
- Default colour `--c-text-muted`; tree and Recent type icons `--c-text-subtle`; `--c-text` on hover.
- Object and file-type icons: table (table grid), view (eye), function (square f), folder, schema (layers), database (cylinder), query (file with lines), Schema Model `.dbml` (layers), flow diagram `.flow` (two linked squares), key (primary key, `--c-group-gold`), link (foreign key, `--c-text-subtle`), lock (Read-only), alert triangle (warnings and failures), history (Query History), plug (no Connections).

### 9.2 Database brand marks

| Database | Mark | Source path | Alucard | Dracula |
|---|---|---|---|---|
| MySQL | Dolphin only (the wordmark is cropped: `viewBox="13.1 -0.3 11.2 13.05"` on the Simple Icons path) | Simple Icons `mysql` | `#00758F` | `#5FB6CC` |
| PostgreSQL | Elephant | Simple Icons `postgresql` | `#336791` | `#8FB3E3` |
| SQLite | Feather | Simple Icons `sqlite` | `#0F80CC` | `#63B4EC` |

- Size 16 px in rows and headers, 14 px in meta lines and the status bar. Filled with `currentColor`.
- The dolphin and the elephant are thin-line drawings: add a hairline stroke in the same colour so they hold up at 14 to 16 px (`stroke-width: .5` on the dolphin, `.35` on the elephant, round joins). The feather needs none.
- Never orange (orange is Production), even though MySQL's brand dolphin is orange-and-blue.
- Licence: Simple Icons paths are CC0 1.0. The marks are trademarks of their owners and are used only to identify the database; never alter their shape beyond cropping and the hairline, never use them as decoration or in marketing.
- Accessible name: `role="img"` with the database name (`aria-label="PostgreSQL"`) when the icon is the only place the database is named.

### 9.3 Connection state rule

| State | Icon | Words | Label and tooltip |
|---|---|---|---|
| Open | brand colour | Home cards: "Open" in `--c-success-text` 600 12 px | "freight-prod, open" |
| Closed | `--c-text-faint` | none | "freight-stg, closed" |
| Failed (last connect failed) | `--c-text-faint` plus a 14 px alert icon in `--c-danger-text` | Home cards: "Failed" in `--c-danger-text` 600 12 px | "pinecone-api, last connect failed" |
| Connecting | `--c-text-faint` | "Connecting..." in `--c-text-subtle` | "kestrel-pos, connecting" |

The same rule applies in the tree, the Home cards, the Recent list (by the item's Connection), the editor header and the status bar. Not-yet-added suggestions (Laragon) keep the brand colour because they are not Connections.

## 10. Components

### 10.1 Title bar and Group switcher
- 40 px on `--c-bg-app`. Left to right: app glyph in a 44 px cell, Group switcher, tab strip, window buttons.
- Group switcher: 16 px Group square, Group name in UI strong, 14 px chevron in `--c-text-subtle`; 8 px gaps, 4 px radius hover `--c-bg-hover`. Opens a menu of Groups and Home. "No Group" shows the empty square.
- Window buttons 46 x 40, glyphs `--c-text-muted`; hover `--c-bg-hover`; close hover `--win-close` with `--win-close-ink` glyph, as Windows does.

### 10.2 Tabs
- 32 px, top corners 6 px, 12 px left and 8 px right padding, 6 px gaps; title truncates; close button 14 px shown on hover and on the active tab.
- Content: kind icon (query, table, `.dbml`, `.flow`; query tabs currently show a 14 px database letter tag, to be replaced by the 14 px database mark), optional `PROD` chip (18 px), title, `*` when unsaved, close.
- Active: `--c-bg-surface`, `--c-text` 600, joined to the pane below, 2 px inset underline in the Connection's Group hue (`box-shadow: inset 0 -2px 0 var(--group)`). No Production top edge.
- Overflow: shrink to 120 px, then scroll with a list button at the end. Middle-click closes; Ctrl+Tab cycles in recent order.

### 10.3 Object tree
- Rows 28 px on `--c-bg-panel`, padding-left 8 + 20 x level, chevron 14 px (`chevron-right` collapsed, `chevron-down` expanded; leaves get a 14 px spacer).
- **Indent guides**: for every ancestor level k of a row, a 1 px vertical line at x = 8 + 20k + 7 (centred under that level's chevron), full row height, `--c-tree-guide`, `pointer-events: none`. Lines join across rows, so a guide runs from an expanded parent down through its last descendant. The guide at the level that contains the selected row (parent level of the selection, across the selection's sibling block) is `--c-tree-guide-strong`.
- Group rows: UI strong, 16 px Group square, name, count of Connections right-aligned (UI small, `--c-text-subtle`, tabular).
- Connection rows: database mark (state rule 9.3), name, then `PROD` chip and lock icon as they apply. `title` and `aria-label` "name, open|closed".
- Object rows: 14 px kind icon, name, optional count (row counts for tables, item counts for folders).
- Names truncate with an ellipsis (`min-width: 0; overflow: hidden; text-overflow: ellipsis`); icons, chips and counts never shrink.
- Selected: section 7. Type-to-filter field at the top (Filter objects, Ctrl+Shift+F); matched characters get `--c-accent-subtle`.
- Group marker decision: the 16 px square is recommended and shown in the tree; the alternative (no marker in the tree, Group only in the switcher) was drawn and declined because the tree shows several Groups at once.

### 10.4 Home
**Header**: "Home" (Heading) with "9 Connections in 3 Groups, 1 Ungrouped" below (UI small, `--c-text-subtle`); right side: Filter Connections input (260 px) with `Ctrl+Shift+F` key hint, New Group (secondary, folder icon), New Connection (primary, plus icon, `Ctrl+N`).

**Group cards** (primary content):
- Card: `--c-bg-surface`, 1 px `--c-border`, 6 px radius, no shadow, no tint, no stripe.
- Header 40 px: 20 px Group square (11 px initial, `--c-gmk-ink` on the Group hue, 4 px radius), Group name UI strong, "3 Connections" UI small `--c-text-subtle`, spacer, 24 px "Group actions" icon button (more). Bottom rule 1 px `--c-border-subtle`. Ungrouped uses the empty square.
- Connection row (grid `16px 1fr auto`, column gap 8, padding 7 12 8): line 1 database mark (state rule), name UI strong, tags (`PROD`, lock + `Read-only`), then right-aligned state word ("Open" / "Failed" with alert icon) and last-opened time (UI small, `--c-text-subtle`, tabular: "12 min ago", "Today 09:41", "Yesterday 16:12", "Oct 9"). Line 2 host and database in Code small `--c-text-subtle`: `db.kestrelfoods.internal:5432 · kestrel` (SQLite shows the file path). Rows separated by 1 px `--c-border-subtle`; hover `--c-bg-hover`; tooltip and label "name, state".
- Home keeps the "Open" and "Failed" words (the icon colour alone is not enough, and with most icons grey the words scan faster).
- Hint under the cards: "Drag a Connection onto another card to move it to that Group." (UI small, `--c-text-subtle`).

**Recent column** (320 px, `--c-bg-panel`, 1 px `--c-border-subtle` left edge):
- Header 28 px: "Recent" (Title) and a 24 px subtle "Clear" button.
- Day sections in this order: **Today**, **Yesterday**, **Earlier this week**, then **Earlier** (older than the current week). Label: UI small 600 `--c-text-subtle`, 18 px above, 6 px below (10 px above for the first).
- Row (a real `<button>`, 48 px): grid `16px 1fr auto`, rows `20px 16px`, gaps 2 px by 10 px, padding 5 px 8 px, radius 4. Line 1: kind icon (`--c-text-subtle`), title (query name in UI 13 / 20; tables and models in Code 12 / 20, schema-qualified, for example `billing.invoices`, `kestrel_orders.dbml`), time right-aligned. Line 2 (subordinate): 14 px database mark (state rule), Connection name in UI small `--c-text-subtle`, `PROD` micro tag when it applies.
- No kind word on the row; it lives in the tooltip and label: "Query on freight-prod. Select to reopen it." (kinds: Query, Table, Schema model, Flow diagram).
- Time formats (tabular, `--c-text-subtle`, right-aligned): Today "12 min", "2 h" (no "ago"; "now" under 1 minute); Yesterday the clock time "16:12"; Earlier this week and Earlier the date "Oct 14"; a different year "2025-12-03".
- Dividers: 1 px `--c-border` hairline at the top of every row but the first in a section, inset from 34 px to 8 px from the right; hidden on the hovered or focused row and the row after it.
- Hover `--c-bg-hover`; focus inset ring; Enter or click reopens the item where it was (same Connection, same scroll and selection).
- Footer: "Show all history" subtle button with the history icon, pinned to the bottom.

**Empty state** (no Connections): centred, max 360 px: 20 px plug icon in `--c-text-faint`, "No Connections yet" (Title), "Add a Connection to browse, query and change a database." (`--c-text-subtle`), primary New Connection `Ctrl+N`; 28 px below, a 440 px Suggested Connections box: header row (12 px, `--c-text-muted`, search icon) "Found on this PC in Laragon. Nothing is saved until you add it."; 40 px rows: brand mark, name UI strong ("MySQL 8.0.30", "PostgreSQL 17.0"), host in Code small (`localhost:3306`, `localhost:5432`), secondary "Add" button 24 px. Status bar reads "No Connections"; the switcher reads "No Group".

### 10.5 Query workspace
- **Editor header strip** (32 px): Connection button (database mark, name UI strong, chevron), `PRODUCTION` label when it applies, database picker, divider, Run (primary 24 px, play icon, `Ctrl+Enter`; "Run on PROD" outline when the current statement writes on Production), Run all, Explain, Format, spacer, AI access chip (info variant, "AI: Schema only"), history icon button.
- **Editor**: section 4 (Code 13 / 20), gutter 48 px, line numbers `--c-text-faint`, current line number `--c-text`, current statement per section 7, errors wavy `--c-syn-error`.
- **Result toolbar** (36 px): result tabs ("Result 1", "Result 2"; active `--c-text` 600 with a 2 px accent underline inset 8 px), divider, "200 rows in 48 ms" UI small tabular, spacer, Pending Edits chip (warning, "1 Pending Edit"), Discard (subtle), Save (primary, `Ctrl+S`; "Save on PROD" outline on Production), divider, filter, columns, export icon buttons.
- **Grid**: header 28 px on `--c-bg-panel`, sticky: key icon (PK) or link icon (FK), name UI small 600, type in Code micro `--c-text-subtle`; numeric columns right-aligned. Cells Code small 12 px, 28 px rows, 1 px `--c-border-subtle` row lines, no zebra, row-number gutter 48 px `--c-text-faint`. Values: section 3.6. Selected row `--c-accent-subtle`.
- **Grid footer** (32 px): "1 to 12 of 200" left; right a reason line, for example "Saving runs on Production and asks you to confirm the SQL first."
- **Status bar** (24 px, UI small, 16 px gaps, tabular): Production segment (section 11) or Connection (mark + name), server version ("PostgreSQL 16.4"), "200 rows", "48 ms", "Ln 13, Col 27", spacer, "UTF-8", Theme switch.

### 10.6 Schema Builder
- Left pane (420 px): strip "DBML" title, dialect chip ("PostgreSQL"), "Saved" state, more menu; DBML editor (section 4); footer "No problems" with check icon and "6 tables, 5 refs".
- Toolbar (36 px): Select (pressed: `--c-accent-subtle` fill), Add table, Arrange, divider, selection summary ("orders selected"), spacer, Publish, Apply to Connection... (secondary).
- Canvas `--c-bg-canvas` with the snap grid: dots 1 px every 16 px in `--c-border`, every 80 px in `--c-border-strong` at 50 percent; hidden below 40 percent zoom. The dot grid is the snap grid, not decoration.
- Table card: 216 px wide (200 to 360 by content), 1 px `--c-node-table-stroke`, 6 px radius, header 32 px on `--c-node-table-fill` with table icon, name UI strong, schema `--c-text-subtle`, column count right; rows 24 px (grid `14px 1fr auto 8px`): key or link icon, column name, type Code small `--c-syn-type`, `?` for nullable in `--c-text-faint`. Highlighted row (linked to text) `--c-accent-subtle`.
- Edges 1.5 px `--c-text-subtle`, orthogonal with 8 px corners, crow's-foot and bar markers.
- Selection: 2 px `--c-accent` outline 5 px outside the card (9 px radius) with four 8 px square handles on `--c-bg-surface` with 1 px accent border. Selecting on the canvas bands the matching DBML block with `--c-accent-subtle`.
- Zoomed-out cards (below 45 percent): 100 x 48 cards with the name (16 / 20 600) and "5 columns"; below 15 percent areas only.
- Floating controls (level 1): zoom (minus, percent 48 px min width tabular, plus, fit) bottom right; minimap 200 x 140 with nodes as 80 percent stroke-colour blocks and the viewport as a 1 px accent rectangle on a 30 percent accent-subtle fill.

### 10.7 AI assistant panel
- 360 px on `--c-bg-panel`. Header: "Ask" (Title), access chip (info variant, "Schema and query text"), history and close icon buttons.
- Access levels and chip variants: Nothing (neutral, input disabled with the reason), Schema only (info), Schema and query text (info), Plus sample rows (warning).
- Thread (12 px padding, 14 px gaps): the question as a right-aligned bubble (`--c-bg-active`, 8 px radius, 8 x 10 px padding, max 88 percent); the answer as text with table names in UI strong; SQL in a block (1 px `--c-border`, 6 px radius, Code 12 / 18 on `--c-bg-surface`, no line numbers) with an action bar on `--c-bg-panel`: "Insert into the editor", "Run", copy. Result line: check icon and "Inserted into the editor and run, 8 rows" (UI small, `--c-text-subtle`).
- Sends line above the input (UI small, `--c-text-muted`): "Sends" then icon-and-word items ("your question", "schema of 6 tables", "the current statement") and the link "Show exactly" in `--c-accent-text` 600.
- Composer: textarea min 64 px, 1 px `--c-border` with a 2 px `--c-accent` bottom edge when focused, placeholder "Ask about kestrel-main"; bottom row "No sample rows are sent", `Enter` key hint, 24 px primary send icon button.
- Run from an answer on a Production Connection goes through the write-confirm dialog. The panel has no colour of its own: no gradient, no sparkle, no accent glow.

### 10.8 Flow diagram (`.flow`, Gane-Sarson)
- Text pane 420 px: strip "Flow", notation chip "Gane-Sarson", "Unsaved", more; editor; Problems block (UI small 600 "Problems" + count chip; each problem in `--c-danger-text` with an alert icon, naming the line, the problem and the fix: "Line 27: refunds is not defined. Add `refunds [store, id: D4]` or send the flow to orders, products or invoices.").
- `.flow` syntax is line based: header `diagram dfd "Order fulfilment"`; nodes `Customer [entity]`, `Take order [process, id: 1.0]`, `orders [store, id: D1, table: orders]`; groups `Kestrel Foods order system { ... }`; edges `A > B: label`, `A <> B: label`, `A --> B`. Highlighting per 3.6; an undefined name gets the error squiggle, is listed in Problems, and its edge is left off the canvas.
- Shapes: process 128 x 96, 6 px radius, `--c-node-service-*`, a 24 px id band on top in Code micro (`1.0`); data store 150 x 36, open on the right, 36 px id cell (`D1`); external entity 48 px high, `--c-node-external-*`, heavy top-left edge (`box-shadow: inset 3px 3px 0` in the stroke colour).
- Area (group of nodes): 10 px radius, 1 px dashed `--group` stroke, fill `--group-tint` at 70 percent, label top-left: 16 px Group square and the name in UI small 600.
- Edges 1.5 px `--c-text-subtle` with 6 px filled arrows; labels on a `--c-bg-canvas` pill, UI small `--c-text-muted`.
- Toolbar: Select, + Process, Store, Entity, divider, selection summary ("3.0 Bill customer selected"), Publish.

### 10.9 Publish image dialog
- 760 px dialog (level 2). Header 52 px: image icon 20 px, "Publish image" (Title), file name UI small, close (`Esc`).
- Body grid `1fr 240px`, 16 px gap. Left: segmented preset (Whole diagram, What's on screen, Selected nodes); preview 308 px tall on `--c-bg-canvas`, 6 px radius; crop box 1 px `--c-accent` with eight 8 px handles, outside dimmed by the crop scrim, size readout "864 x 488" bottom right on `--c-bg-raised`; hint "Drag the handles to crop. Hold Shift to keep the shape." and aspect segmented control (Free, 16:9, 4:3, 1:1).
- Right column: Format (PNG, SVG), Scale (1x, 2x, 3x), Background (radio Theme with Light / Dark, radio Transparent), Padding slider with "32 px", switch "Made with Contura mark", output box ("Output", "1,728 x 976 px", "PNG, about 210 KB").
- Footer 56 px: note "Uses Light theme colours. Hover and selection are left out.", Copy (secondary, `Ctrl+C`), Save as... (primary, `Ctrl+S`). Export reads computed token values and never includes hover or selection states.

### 10.10 Controls

| Control | Spec |
|---|---|
| Primary button | 28 px (24 in toolbars), 0 12 px padding (0 10 px at 24), 4 px radius, `--c-accent` fill, `--on-accent` text, hover `--c-accent-hover`, pressed `--c-accent-pressed`. One per view. Key hint inside on a transparent chip with a 45 percent on-accent border |
| Secondary | `--c-bg-surface`, 1 px `--c-border`, `--c-text`; hover `--c-bg-hover` |
| Subtle (toolbar) | transparent, `--c-text-muted`, 0 8 px padding; hover `--c-bg-hover` and `--c-text` |
| Icon button | 28 x 28 (24 x 24 in headers), tooltip with the shortcut |
| Production outline ("Run on PROD", "Save on PROD") | `--c-bg-surface`, 1 px `--c-prod-solid` border, `--c-prod-text` 600; hover `--c-prod-subtle` |
| Danger | `--c-danger-solid` fill, white text |
| Input | 28 px, `--c-bg-surface`, 1 px `--c-border`, 1 px `--c-border-strong` bottom; focus 2 px `--c-accent` bottom plus focus ring for keyboard; placeholder `--c-text-faint`; label above UI small `--c-text-muted`; error below in `--c-danger-text` with icon and the bottom edge in danger |
| Segmented control | 1 px `--c-border`, 4 to 6 px radius, 2 px inner padding on `--c-bg-panel`; options 24 px; on: `--c-accent-subtle`, `--c-text` 600, 1 px inset accent ring |
| Radio | 16 px circle, 1 px `--c-border-strong`; checked 5 px `--c-accent` ring |
| Switch | track 40 x 20, 1 px `--c-border-strong`, thumb 12 px `--c-text-muted` off; on: `--c-accent` track, `--on-accent` thumb moved right; `role="switch"`, `aria-checked` |
| Slider | 4 px rail `--c-border`, fill `--c-accent`, 16 px thumb with a 3 px accent inner ring; value label tabular |
| Key hint | Code micro, 18 px, 0 5 px, 1 px `--c-border`, 4 px radius, `--c-bg-surface`, `--c-text-muted` |

### 10.11 Chips and tags

| Variant | Look | Example |
|---|---|---|
| Neutral | `--c-bg-active`, `--c-text-muted` | "Read-only", "Gane-Sarson", "PostgreSQL", counts |
| Info | `--c-info-subtle`, `--c-info-text` | "AI: Schema only" |
| Warning | `--c-warning-subtle`, `--c-warning-text` | "1 Pending Edit" |
| Success | `--c-success-subtle`, `--c-success-text` | "Recommended" (reference page only) |
| Accent | `--c-accent-subtle`, `--c-accent-text` | rarely; filters on |
| Production | `--c-prod-subtle`, `--c-prod-text`, 600, uppercase, +0.02em | `PROD` (20, 18 in tabs, 14 at 10 px in Recent) |
| `PRODUCTION` label | same colours, 20 px, 0 6 px, 4 px radius | editor header, status bar segment |

All chips: 20 px default, 0 6 px, 4 px radius, UI small, never shrink, never stacked as decoration.

### 10.12 Menus, tooltips, toasts, dialogs, empty states
- Menus and popovers: level 1, 8 px radius, 4 px outer padding, 28 px items (24 compact) with 12 px padding, icon 16, label, shortcut right in Code micro `--c-text-subtle`; separators 1 px `--c-border-subtle` with 4 px margin; destructive items in `--c-danger-text`.
- Tooltips: `--c-bg-raised`, 1 px `--c-border`, 4 px radius, UI small, max 280 px, 500 ms delay, include the shortcut.
- Toasts: bottom right, 360 px, level 1, icon + one line + optional action + close; info 4 s, success 3 s, errors stay. Never used to confirm writes.
- Dialogs: widths 420 (confirm), 560 (form), 760 (SQL preview, Publish); max 80 vh with inner scroll; header 52 px, body 16 px padding, footer 56 px with buttons right-aligned and the primary rightmost; `Esc` closes; Enter triggers the primary only outside multi-line fields.
- Empty states: centred, max 360 px, 20 px icon in `--c-text-faint`, Title line, one `--c-text-subtle` line, one primary action with its key hint. Examples: "No Connections yet"; "Run a query to see results" + `Ctrl+Enter`.

## 11. Production and Read-only treatment

### 11.1 Production: A plus B
Four options were drawn (A data-source wash, B hazard where you write, C watermark, D hazard gutter); **A plus B** is the rule.

**A. Data-source wash (always on, quiet)**
- Every editor and result pane tied to a Production Connection gets `--c-prod-wash` as its background (`#FDF2DD` Alucard, `#3B3438` Dracula). Body text stays at 14.85:1 and 11.36:1.
- Names, not borders, say which Connection it is: `PROD` chip on the tab and on the tree row, `PRODUCTION` label in the editor header, and a status bar segment on `--c-prod-subtle` (`margin-left: -10px`, 0 10 px padding, right corners 4 px) holding `PRODUCTION`, the Connection (mark + name) and the server version.
- No pane borders, no stripes, no tab top edge, no watermark.

**B. Hazard where you write (only on writes)**
- Reading looks normal. A statement that writes (INSERT, UPDATE, DELETE, MERGE, DDL, CALL of a non-read-only routine) on a Production Connection gets: band `--c-prod-subtle` behind its lines; a 3 px `--c-prod-solid` gutter bar; a 24 px note row under its last line, indented to the text (48 px), alert icon 14 px and the words "Writes on freight-prod (Production)" in `--c-prod-text` UI small 600.
- While the current statement writes, Run becomes "Run on PROD" (Production outline button). Grid saves on Production read "Save on PROD" (same style). Both still open the confirm dialog.
- **Confirm dialog** (420 to 760 px), as built in step 5a (spec `docs/superpowers/specs/2026-10-17-step5a-production-readonly-design.md`): title "Run on **freight-prod** · shop" (or "Save on freight-prod · shop" for Pending Edits), with the database mark, `PROD` chip and Group square beside it; the count line "2 of 3 statements write."; the exact SQL in a read-only editor block with a "writes" or "reads" label per statement; the hint "Enter runs only when Run on freight-prod has focus. Press Tab to reach it, or click it."; buttons Cancel and "Run on freight-prod" (accent primary; danger fill when a statement has an UPDATE or DELETE without WHERE). There is no typed confirmation: the user chose one dialog with the exact SQL. An UPDATE or DELETE without WHERE adds its warning at the top of the same dialog with an "Add WHERE" button, so there is still only one confirmation. Focus starts on the SQL block; Escape cancels.
- Production orange never appears in Group slots, node kinds, syntax or icons.

### 11.2 Read-only
- Lock icon (14 px, `--c-text-subtle`) after the name, plus a neutral `Read-only` chip on cards and in the grid toolbar.
- Grid cells never enter edit mode; editing keys show one toast: "kestrel-reporting is Read-only. Changes are not allowed."
- Grid footer explains why when edits are impossible for another reason: "Read-only: grouped rows cannot be edited".
- If a Connection is both Production and Read-only, show both, `PROD` first.

## 12. Accessibility

- Contrast: section 3.5. Body text is 11.1 to 16.3:1 on every surface; nothing that carries meaning is below 4.5:1, except the documented Dracula comment colour.
- Colour is never the only signal: Connection state has the word or the label; Production has `PROD` and `PRODUCTION` words; Group squares carry the initial and the name; Pending Edits have the chip count; errors have icons and text.
- Focus order follows reading order: title bar (switcher, tabs), tree, editor header, editor, results toolbar, grid, status bar; on Home: header actions, cards left to right then top to bottom, Recent top to bottom, Show all history. Each pane is one Tab stop with arrow keys inside (roving tabindex) for the tree, grid, tab strip and Recent list.
- Keyboard: Ctrl+N New Connection; Ctrl+Shift+F filter (tree or Home); Ctrl+Enter run current statement; Shift+Ctrl+Enter run all; Ctrl+S save Pending Edits; Ctrl+Tab next tab; Ctrl+W close tab; Esc closes dialogs and menus; F2 or Enter edits a cell; arrow keys move in tree and grid; Right and Left expand and collapse tree nodes; Home and End in lists.
- ARIA patterns: tree `role="tree"` / `treeitem` with `aria-level`, `aria-expanded`, `aria-selected`; tab strip `tablist` / `tab` with `aria-selected`; grid `role="grid"` with `aria-rowcount`; Recent as a list of buttons inside a `section` per day with `aria-label` the day name; switches `role="switch"` + `aria-checked`; dialogs `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, focus trapped and returned; status bar `role="status"` (polite) for row counts and timings; toasts `role="status"`, errors `role="alert"`; decorative icons and Group squares `aria-hidden="true"`; database marks `role="img"` with a name when they are the only label.
- Hit targets: 28 px minimum in the desktop app; 44 px on touch or under 640 px wide surfaces (the reference page's controls).
- Reduced motion: section 8. High contrast (Windows contrast themes, `forced-colors: active`): use system colours, keep focus rings, draw the Group square border, never rely on the wash.

## 13. Copy rules

- Never write "cursor" or "caret". Say "where you are typing", "the current statement", "into the editor".
- No em dashes anywhere (UI, docs, commits). Use a comma, a colon, parentheses or two sentences.
- Sentence case for every label and title. Uppercase only for `PROD` and `PRODUCTION`.
- Product name: **Contura**.
- Capitalised domain terms: **Connection**, **Group**, **Ungrouped**, **Schema Model**, **Schema Builder**, **Saved Queries**, **Query History**, **Pending Edit(s)**, **Production**, **Read-only**, **Home**.
- Buttons name their action: "New Connection", "Run on PROD", "Save on PROD", "Insert into the editor", "Apply to Connection...", "Show all history". Ellipsis (...) only when the action opens a dialog that asks for more.
- Errors name the problem and the fix ("Line 27: refunds is not defined. Add ... or send the flow to ...").
- Numbers with units and tabular figures: "200 rows in 48 ms", "1 to 12 of 200", "1,728 x 976 px".
- Sample data in docs and demos is made up (Kestrel Foods, Orbit Freight, Pinecone Labs) and says so.

## 14. Mapping from DESIGN.md

| Area | DESIGN.md (current app) | DESIGN-NEXT (this file) |
|---|---|---|
| Palette | Cool neutrals, Harbor Teal `#0E7C86` accent, custom dark | Alucard light, Dracula dark; accent purple `#644AC9` / `#BD93F9` |
| Focus ring | 2 px teal, offset 2 | 2 px `--c-focus` (accent purple), offset 1, inset in rows |
| Selection | Teal Wash, teal text | `--c-accent-subtle` (`#CFCFDE` / `#44475A`) plus 2 x 16 px accent bar, text unchanged |
| Code font | Cascadia Code in the editor with ligatures; Cascadia Mono elsewhere without | JetBrains Mono everywhere code or data appears, ligatures on everywhere |
| UI size | Body 14 / 20 | UI 13 / 18, small 12 / 16 |
| Grid density | 40 px rows, 44 px two-line header | 28 px rows (24 compact), 28 px header with inline type hint |
| Toolbar / status bar | 44 px / 44 px | 32 to 36 px strips / 24 px status bar |
| Icon rail | 48 px rail | Not used in these screens; navigation is Home tab plus title bar switcher (keep the rail decision open) |
| Group mark | 22 px initial square, white initial, only in switcher and Home card | 20 px square on Home cards, 16 px in tree, switcher and diagram areas; initial ink per theme; plus the 2 px tab underline in the Group hue |
| Group colours | Nine (red, orange, amber, ...) | Eight slots, no red, no orange, no purple (3.4) |
| Production | Amber `#B76E00`, 2 px outline around a grid with Pending Edits | Orange `#D06A14` / `#FFB86C`: wash on panes, `PROD`/`PRODUCTION` labels, hazard only on writes, Run/Save on PROD, confirm dialog |
| Pending Edits | Highlighter yellow fill, 2 px edge, coloured row number, sweep animation | `--c-warning-subtle` fill and 2 px `--c-warning-solid` edge; keep the row-number colour and the 150 ms sweep from DESIGN.md if wanted (not drawn here) |
| NULL | Italic faint "NULL", 4.5:1 | "NULL" upright Code 12 in `--c-text-faint` (3.9:1 Alucard); raise to `--c-text-subtle` if NULL must meet 4.5:1 |
| Database marks | Not specified | Simple Icons dolphin, elephant, feather; colour means open |
| Status dots | Pending-edit dot allowed | No dots anywhere |
| Radii | 3 / 4 / 6 px | 3 / 4 / 6 / 8 / 10 px (islands and overlays 8) |
| Shadows | Menu, dialog, toast shadows | Same roles, values in section 6 |
| Motion | 90 / 120 / 150 ms max | 80 / 120 / 180 / 240 ms max; same easing |
| Home | Equal Group cards then Ungrouped list | Two-column Group cards (Ungrouped is a card) plus Recent column |
| Tree indent | not specified (16 px in the earlier draft) | 20 px per level with indent guides |

Migration order suggestion: tokens (section 3) and fonts first, then the tree and tabs, then Home, then the Production treatment, then diagrams.

## 15. Implementation notes

- Tokens live in one stylesheet; components use only `--c-*`, `--db-*`, `--syn-*` and `--group` roles. A Connection's container sets `--group: var(--c-group-<slot>)` and `--group-tint: var(--c-group-<slot>-tint)`; components read `--group`.
- Theme: `data-theme` on `<html>` (`light`, `dark`, absent = follow Windows).
- Ligature settings must come after any `font` shorthand (section 4.1).
- Tree guides are drawn per row (absolutely positioned 1 px elements per ancestor level), so virtualised rows still draw them; recompute the strong level when the selection changes.
- Recent dividers are a `::before` on every row after the first in a section; hide it on `:hover` and `:focus-visible` and on the following row.
- Exports read computed token values at export time.
- The reference screens are built from `screens/tpl.html` by `screens/assemble.py`, which reads the two token blocks in section 3 of this file and then `screens/theme-jetbrains.css` (Alucard written by `screens/light_palettes.py`, which also prints the contrast checks). Keep the three in step when a value changes.
