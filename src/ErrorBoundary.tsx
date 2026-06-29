import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Faengt Render-Fehler ab, damit nie der ganze Bildschirm schwarz wird. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Sichtbar im Webview-Log, hilft beim Debuggen.
    console.error("UI-Fehler:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-lg w-full rounded-xl border border-border bg-card p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2 text-destructive">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="w-5 h-5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
            <h1 className="text-base font-semibold">Something went wrong</h1>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground max-h-64 overflow-auto rounded-lg bg-muted p-3">
            {error.message}
            {error.stack ? "\n\n" + error.stack : ""}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="self-start rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
