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
import "./styles/lineage.css";
import "./styles/flow-tab.css";
import { applyStoredTheme } from "./theme/theme";

// Paint the saved theme before the first render, so the window never flashes the other one.
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
