---
version: alpha
name: DB View
description: A calm, light-first Windows database client where colour only ever means something.
colors:
  primary: "#0E7C86"
  primary-hover: "#0B6971"
  primary-soft: "#DFF0F1"
  on-primary: "#FFFFFF"
  on-primary-soft: "#0A5960"
  surface: "#FFFFFF"
  surface-chrome: "#F2F4F5"
  surface-panel: "#F8F9FA"
  line: "#DFE3E7"
  line-soft: "#EEF1F3"
  ink: "#1B1F23"
  ink-muted: "#56616B"
  ink-faint: "#6B7680"
  highlighter: "#FFF2A8"
  highlighter-edge: "#B38F00"
  highlighter-ink: "#6E5800"
  added-soft: "#E3F4EA"
  added-ink: "#1D6B3F"
  deleted-soft: "#FBE4E2"
  deleted-ink: "#A1322B"
  production: "#B76E00"
  production-soft: "#FCEFD9"
  production-ink: "#7A4500"
  danger: "#B3362E"
  syntax-keyword: "#2F5FC4"
  syntax-string: "#1D7A45"
  syntax-number: "#B4451F"
  syntax-comment: "#6B7680"
  group-red: "#D23A2E"
  group-orange: "#B4510F"
  group-amber: "#8F6700"
  group-green: "#26804E"
  group-teal: "#17808A"
  group-blue: "#2F6FDB"
  group-violet: "#7556CF"
  group-rose: "#C2417A"
  group-slate: "#5C6B7A"
  dark-surface: "#14181B"
  dark-surface-chrome: "#0F1215"
  dark-surface-panel: "#171B1F"
  dark-line: "#2A3036"
  dark-line-soft: "#20252A"
  dark-ink: "#E4E8EB"
  dark-ink-muted: "#A0AAB3"
  dark-ink-faint: "#8A949D"
  dark-primary: "#3FB8C2"
  dark-on-primary: "#06272A"
  dark-primary-soft: "#15363B"
  dark-highlighter: "#3D3510"
  dark-highlighter-edge: "#E0B400"
  dark-production: "#E8A33A"
  dark-primary-hover: "#5CC6CF"
  dark-on-primary-soft: "#8FDDE3"
  dark-highlighter-ink: "#F0D466"
  dark-deleted-soft: "#3A1D1B"
  dark-deleted-ink: "#F28B83"
  dark-production-soft: "#3A2A12"
  dark-production-ink: "#F3C27A"
  dark-danger: "#F28B83"
typography:
  display:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 34px
  headline:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 22px
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  body-strong:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
  mono:
    fontFamily: "Cascadia Mono, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  mono-small:
    fontFamily: "Cascadia Mono, Consolas, monospace"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 14px
  code-editor:
    fontFamily: "Cascadia Code, Cascadia Mono, Consolas, monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
    fontFeature: "\"calt\" 1, \"liga\" 1"
rounded:
  none: 0px
  xs: 3px
  sm: 4px
  md: 6px
  full: 999px
spacing:
  2xs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: 6px 12px
    height: 32px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 6px 12px
    height: 32px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 0px 8px
    height: 32px
  title-bar:
    backgroundColor: "{colors.surface-chrome}"
    textColor: "{colors.ink-muted}"
    height: 40px
  tab:
    backgroundColor: "{colors.surface-chrome}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 0px 10px
    height: 34px
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  group-badge:
    backgroundColor: "{colors.group-red}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    size: 22px
  tree-row:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 0px 8px
    height: 28px
  tree-row-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.on-primary-soft}"
  grid-header:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    padding: 0px 10px
    height: 44px
  grid-cell:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 0px 10px
    height: 40px
  grid-cell-edited:
    backgroundColor: "{colors.highlighter}"
    textColor: "{colors.ink}"
  grid-cell-null:
    textColor: "{colors.ink-faint}"
  type-hint:
    textColor: "{colors.ink-muted}"
    typography: "{typography.mono-small}"
  kbd:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.mono-small}"
    rounded: "{rounded.xs}"
    padding: 1px 5px
  tag-production:
    backgroundColor: "{colors.production-soft}"
    textColor: "{colors.production-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
  group-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: 16px
  status-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    height: 44px
---

<!-- SEED: written from the theme survey (2026-10-15) before any UI code exists. Re-run `/impeccable document` once the first screens are built, to check these tokens against the real build and generate the .impeccable/design.json sidecar. -->

# Design System: DB View

## Overview

**Creative North Star: "The Marked Ledger"**

DB View is a working ledger: quiet, ruled, exact, and marked only where something needs your attention. The base is Flat minimal, with white work surfaces, cool-grey chrome, hairline rules and a single teal accent. Every other colour carries a meaning. A Group's colour tells you whose databases you are in. Highlighter yellow marks a change you haven't saved, the way you would mark a paper ledger. Amber means Production. Nothing is coloured for decoration.

The interface reads as a native Windows tool. It uses Segoe UI and Windows caption buttons, and puts tabs in the title bar like a browser. The design gets out of the way of dense data. Density is comfortable (40 px grid rows), because sessions are long and rows must be easy to track across a wide grid. The visual references that set this direction are the cansaas ERD and console, the light employee table, the Hexora DBML builder and Drizzle Studio's typed headers and row counts.

The look is one **Theme** among several (ADR 0008). Every value below is a token, and alternate Themes swap the values, never the components.

**Key Characteristics:**
- White work surfaces, cool-grey chrome, 1 px hairline rules, no resting shadows.
- One teal accent, used for the primary action, focus and selection only.
- Meaning-only colour: Group colour, highlighter for Pending Edits, green and red for added and deleted rows, amber for Production.
- Segoe UI for everything, plus Cascadia Mono for SQL, types and shortcuts.
- Soft 4 to 6 px corners, regular-weight outlined icons, motion of 150 ms or less.

## Colors

A restrained palette: cool neutrals and one teal, with every other hue reserved for a single meaning.

### Primary
- **Harbor Teal** (`primary`): the Save button, the Run button, the focus ring, the selected tree row's text and the active tab's underline. It is the one colour that means "act here" or "you are here".
- **Teal Wash** (`primary-soft`): the background of the selected tree row, rail item and segmented-control option.

### Secondary
- **Ledger Highlighter** (`highlighter`, edge `highlighter-edge`): every Pending Edit. An edited cell gets the highlighter fill and a 2 px edge, and its row number takes the edge colour. This is the Paper-notebook flavour the user chose for pending changes.

### Tertiary
- **Production Amber** (`production`, `production-soft`, `production-ink`): the Production tag, and the 2 px outline around a grid that has Pending Edits on a Production Connection.

### Neutral
- **Paper White** (`surface`): the grid, the editor and dialogs, where data lives.
- **Cool Chrome** (`surface-chrome`): the title bar, tabs strip and icon rail.
- **Panel Grey** (`surface-panel`): the object tree and grid headers.
- **Hairline** (`line`) and **Faint Rule** (`line-soft`): panel borders, and cell and row dividers.
- **Ink** (`ink`), **Muted Ink** (`ink-muted`) and **Faint Ink** (`ink-faint`): text, secondary text and type hints, and NULL values. Faint Ink still meets 4.5:1 on white, because NULL is data, not decoration.

### Group colours
Nine fixed colours (`group-red` to `group-slate`), each picked to carry white text at 4.5:1 or better. A Group's colour appears in exactly one place: its initial square beside the Group name in the title bar and on its Home card.

### State colours
`added-soft` / `added-ink` for new rows and `deleted-soft` / `deleted-ink` (with strikethrough) for deleted rows. `danger` is only for destructive buttons and errors.

### Dark variants
The `dark-*` tokens mirror the light roles one for one, for the dark variant of the default Theme. Teal lightens to `dark-primary` to keep contrast, and the highlighter becomes a deep olive with a bright edge, so a Pending Edit stays obvious without glaring.

### Named Rules
**The Meaning-Only Rule.** Every non-neutral colour on screen must answer "what does this mean?" with a state, an identity or an action. Decorative colour is not allowed.

**The One Teal Rule.** Teal marks the primary action, focus and selection, and nothing else. It never appears on icons, borders or illustrations.

**The Group Owns One Square Rule.** A Group's colour appears only in its initial square. It never tints buttons, data or the window frame, so it can never be confused with a state colour.

## Typography

**Display Font:** Segoe UI Variable Display (with Segoe UI, system-ui)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui)
**Label/Mono Font:** Cascadia Mono, bundled with the app (with Consolas)
**Code Editor Font:** Cascadia Code, bundled, with ligatures on (`code-editor`)

**Character:** Windows-native and invisible. Segoe UI makes DB View feel like part of the OS and costs nothing to load. Cascadia Mono is the voice of the database itself: SQL, column types, row counts, timings and shortcuts.

### Hierarchy
- **Display** (600, 28 px, 34 px line): the Home heading only.
- **Headline** (600, 20 px, 28 px): dialog titles and Group names on Home cards.
- **Title** (600, 16 px, 22 px): panel and section titles, such as "Review SQL" and the Connection name.
- **Body** (400, 14 px, 20 px): grid cells, tree rows, menus and forms. Body-strong (600) is for grid header names and primary buttons.
- **Label** (600, 12 px, 16 px): tree section labels ("Tables 6"), tags and the Group initial. Sentence case, never tracked uppercase.
- **Mono** (400, 13 px, 20 px): the SQL editor and query results metadata. Mono-small (11 px) is for type hints under column names, row counts and keyboard shortcuts.

### Named Rules
**The Database Speaks Mono Rule.** Text that comes from or goes to the database (SQL, types like `DECIMAL(12,2)`, counts, timings) is set in Cascadia Mono. Everything that is the app's own voice is Segoe UI.

**The Ligatures Stay In The Editor Rule.** Only the SQL editor uses Cascadia Code with ligatures (14 px, 22 px line), to type like VS Code. Grid cells, results and type hints stay in Cascadia Mono without ligatures, so a value such as `!=` or `>=` is always shown exactly as stored.

**The No-Shouting Rule.** No uppercase labels with wide letter-spacing. Hierarchy comes from weight and size.

## Layout

A fixed application shell on a 4 px spacing scale:
- **Title bar** (40 px): the Group switcher (initial square, name, chevron), the tabs, then the Windows caption buttons.
- **Icon rail** (48 px): Home, Connections, SQL, Schema Builder, History, then Settings at the bottom.
- **Object tree** (240 px, resizable from 200 to 400 px).
- **Work area:** toolbar (44 px), content, status bar (44 px).
- **Data grid:** 40 px rows and a 44 px two-line header (name, then type hint). Row numbers sit in a 40 px column. Numbers align right. Wide grids scroll horizontally inside the work area, never the window.
- **Home:** a grid of equal Group cards, `repeat(auto-fill, minmax(240px, 1fr))` with 16 px gaps, followed by the Ungrouped Connections as a list.
- **Spacing rhythm:** 8 px inside controls, 12 px between related controls, 16 px panel padding, 24 to 32 px between Home sections.

The window is resizable down to 960 × 600. Below 1100 px wide, the object tree collapses to an overlay opened from the rail.

## Elevation & Depth

Flat at rest. Depth comes from the three neutral surfaces (chrome, panel, paper) and hairline rules, not shadows.

### Shadow Vocabulary
- **Menu** (`box-shadow: 0 8px 24px rgba(16,24,32,.12), 0 1px 2px rgba(16,24,32,.08)`): context menus, dropdowns, autocomplete.
- **Dialog** (`box-shadow: 0 24px 64px rgba(16,24,32,.24)`): Review SQL, Connection form, confirmations.
- **Toast** (`box-shadow: 0 6px 16px rgba(16,24,32,.14)`): "Saved 1 change to orders" and similar.

### Named Rules
**The Flat-By-Default Rule.** Nothing on the page casts a shadow unless it floats above the page: menus, dialogs, toasts. Panels and cards never do.

## Shapes

Soft and consistent. Kbd hints and type chips use 3 px. Tabs, tree rows and tags use 4 px. Buttons, inputs, cards, menus and dialogs use 6 px. The Group initial square is a 22 px square with 4 px corners, not a circle, so it reads as a label rather than an avatar. The only full circles are status dots (the pending-edit dot). Borders are 1 px hairlines. The 2 px exceptions are the edited-cell edge, the Production outline and the focus ring.

## Components

### Buttons
- **Shape:** gently rounded (6 px), 32 px tall.
- **Primary:** Harbor Teal with white text, semibold. One per view at most (Save, Run, Connect).
- **Hover / Focus:** hover darkens to `primary-hover` in 90 ms. Focus shows a 2 px teal ring offset 2 px, always visible on keyboard focus.
- **Secondary:** white with a hairline border and ink text (Review SQL, Discard, Cancel).
- **Destructive:** secondary shape with `danger` text, and filled `danger` only inside a confirmation dialog.

### Tabs (title bar)
- **Style:** 34 px, 4 px top corners, an icon by kind (table, query, schema), the name, then a close button that appears on hover or when the tab is active.
- **Active:** paper-white background joined to the work area, ink text.
- **Overflow:** tabs shrink to a 96 px minimum, then scroll, with a list menu at the end.

### Group badge and switcher
- **Style:** a 22 px initial square in the Group colour with a white initial, followed by the Group name and a chevron.
- **Behaviour:** opens a menu of Groups, plus Home.

### Object tree
- **Rows:** 28 px, with an outlined icon by object kind, the name, and the row count in mono-small at the right.
- **Selected:** Teal Wash background with teal-ink text.
- **Sections:** "Tables 6", "Views 1" and "Routines 1" as Label text with a count.

### Data grid
- **Header:** two lines, the column name (body-strong) with a type icon, and the type hint (mono-small). The primary key shows a key icon.
- **Cells:** body text, 40 px rows, faint row rules. NULL is shown as italic Faint Ink "NULL".
- **Editing in place:** double-click, Enter or F2 turns the cell into an editor without moving the value by a pixel. Column widths are pinned while editing, the editor has no border or padding of its own, and only a 2 px teal inset ring fades in (90 ms). The user flagged the earlier version, which swapped in a bordered input box, as "teleporting".
- **Pending Edit:** highlighter fill, a 2 px highlighter edge and a highlighter-coloured row number. Added rows use `added-soft`. Deleted rows use `deleted-soft` with strikethrough.
- **Production:** while the grid has Pending Edits on a Production Connection, a 2 px Production Amber outline surrounds the grid.

### Status bar
- A pending-edit dot and count, then Review SQL, Discard and Save with a `Ctrl S` hint. The pager sits on the right.

### Inputs / Fields
- **Style:** a 32 px white field with a hairline border and 6 px corners.
- **Focus:** the border turns teal, plus the teal focus ring.
- **Error:** `danger` border, with a message below that says what is wrong and how to fix it.

### Home Group card
- **Style:** a white card with a hairline border and 6 px corners. It shows the initial square, the Group name (Headline), the number of Connections, and the last opened time in mono-small.
- **Hover:** the border darkens to `ink-faint` in 90 ms. Never a lift or a shadow.

### Motion
Subtle, and only to explain a change of state:
- **Timing:** 90 ms for hover and press, 120 ms for fades, tab switches and menus, 150 ms for dialogs and panel slides.
- **Easing:** `cubic-bezier(0.2, 0, 0, 1)` on enter and `cubic-bezier(0.4, 0, 1, 1)` on exit. Exits are faster than enters.
- **Signature:** the highlighter sweeps left to right across an edited cell (150 ms) and clears cell by cell on Save (120 ms each, 30 ms apart). Then a toast rises in the bottom right (150 ms).
- **No layout motion:** state changes never move content. Rings, fills and fades change, but text and columns stay put.
- **Reference:** the Motion Lab artifact plays every motion: https://claude.ai/artifact/3C2JXw3yrXsNkGs8YyRh5q
- **Reduced motion:** when Windows reduce-motion is on, everything is instant.

## Do's and Don'ts

### Do:
- **Do** style every component through tokens, so any Theme can replace the values (ADR 0008).
- **Do** keep teal for the primary action, focus and selection only (The One Teal Rule).
- **Do** mark every Pending Edit with the highlighter fill, edge and row-number colour together.
- **Do** set SQL, column types, counts, timings and shortcuts in Cascadia Mono.
- **Do** show a visible 2 px teal focus ring on every keyboard-focusable control.
- **Do** keep NULL legible (Faint Ink, 4.5:1), because it is data.

### Don't:
- **Don't** use a Group's colour anywhere except its initial square, including no window strip and no tinted sidebar.
- **Don't** put shadows on panels, cards or the grid. Shadows are only for menus, dialogs and toasts.
- **Don't** use uppercase, wide-tracked labels.
- **Don't** animate anything for longer than 150 ms, or loop any animation.
- **Don't** use the Blueprint, Neumorphism, Raw brutalism or Aurora gradient looks. The user rejected them in the theme survey.
- **Don't** use red for Production. Red means delete or error, and Production is amber.
