// Runs from <head> before any CSS or module loads: sets data-theme from the same
// mirror src/theme/theme.ts reads, and paints the window background of that theme
// so the first frame is not white. A file, not inline, and the background goes
// through the CSSOM, not a <style> tag: at release build Tauri adds a nonce to
// style-src for any inline <style>, which turns off 'unsafe-inline' and blocks the
// <style> tags CodeMirror inserts. The colours are tokens.css --c-bg-app (Alucard,
// Dracula); a var() cannot work before the CSS does. bootBackground.test.ts keeps
// them equal.
(function () {
  var root = document.documentElement;
  var v = "dark";
  try {
    var stored = localStorage.getItem("contura.theme");
    if (stored === "light" || stored === "dark" || stored === "system") v = stored;
  } catch (e) {
    // No storage: Dracula, as readMirror does.
  }
  if (v === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", v);

  var dark = v === "dark";
  if (v === "system") {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      dark = true;
    }
  }
  root.style.backgroundColor = dark ? "#191a21" : "#ece9df";
})();
