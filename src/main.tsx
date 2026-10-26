import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/export.css";
import "./styles/import.css";
import "./styles/transfer.css";
import "./styles/backup.css";
import "./styles/compare.css";
import "./styles/flow.css";
import "./styles/flow-canvas.css";
import "./styles/update.css";
import "./styles/guide.css";
import "./styles/lineage.css";
import "./styles/flow-tab.css";
import { installContextMenuGuard } from "./components/contextMenuGuard";
import { installTooltipGuard } from "./components/tooltipGuard";
import { setIconTheme } from "./flow/icons";
import { applyStoredTheme } from "./theme/theme";

// Paint the saved theme before the first render, so the window never flashes the other one.
// Icons are inked for the same theme from their first load.
setIconTheme(applyStoredTheme());
// No tooltip outlives its trigger: a click, a scroll or leaving the window hides it (P11-37).
installTooltipGuard();
// The WebView never shows its own right-click menu (its Reload restarts the app); text fields keep Cut, Copy, Paste.
installContextMenuGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
