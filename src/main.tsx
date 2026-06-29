import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { PrefsProvider } from "./lib/prefs";
import "./index.css";

// Produktionsnaehe: Standard-Kontextmenue des WebViews unterdruecken (zu viele
// Optionen), ausser in Eingabefeldern und im Terminal, wo Rechtsklick/Paste
// gebraucht wird. Dazu DevTools-Shortcuts (F12 etc.) abfangen.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  // Rechtsklick fuer Kopieren/Einfuegen in Feldern, Code-Bloecken und im
  // Terminal zulassen (das Terminal behandelt den Rechtsklick selbst als Paste).
  if (t && t.closest("input, textarea, .xterm, pre, code, [data-selectable]")) return;
  e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "F12") {
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
