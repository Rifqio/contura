# Contura launch site

One public page, `index.html`: the hero, the live playground, then one section each for Query, Diagram boards, Data,
AI and Safety, and the download. Plain static files, no build step: open `index.html` from a local server
(`python3 -m http.server -d site`) to preview.

- Published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches `site/`.
- The app windows are drawn live by `kit.js` (playground), `demos.js` (data grid), `data.js` (Transfer planner) and
  `ai.js` (what the AI sees); every name and number in them is sample data. `launch.js` loads the last three only when
  their section comes near. The in-page sample database runs on sql.js from cdnjs.
- `site.js` holds the shared shell (theme, gutter, status bar, reveals); `hero.js` the hero lean and the demo growth.
- `query.html`, `model.html`, `data.html`, `ai.html` and `safety.html` are redirects to their section, kept so old links
  still land.
- The version and the download buttons (`data-download`) are updated with each release.
