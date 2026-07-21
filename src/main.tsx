import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { PrefsProvider } from "./lib/prefs";
import "./index.css";

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
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
