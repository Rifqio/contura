# Contura launch site

The public pages for Contura: `index.html` (home) and one page each for Query, Model, Data, AI and Safety. Plain static
files, no build step: open `index.html` from a local server (`python3 -m http.server -d site`) to preview.

- Published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches `site/`.
- The app windows on the pages are drawn live by `kit.js`, `demos.js` and the `frames-*.json` design frames; every name
  and number in them is sample data. The in-page sample database runs on sql.js from cdnjs.
- `site.js` holds the shared shell; `playback.js` plays each demo when it scrolls into view.
- The version and the download buttons (`data-download`) are updated with each release.
