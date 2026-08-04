import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { usePrefs } from "./lib/prefs";
import { terminalTheme } from "./lib/terminal-themes";

// Read-only xterm view for command output. Split into its own module (with
// SshTerminal) so xterm loads only when output is shown, not at app startup.
export function TerminalOutput({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { termTheme, termColors } = usePrefs();
  const rows = Math.min(24, Math.max(3, text.split(String.fromCharCode(10)).length));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      theme: terminalTheme(termTheme, termColors),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    term.write(text);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* detached */
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, [text, termTheme, termColors]);

  return <div ref={ref} className="overflow-hidden rounded" style={{ height: rows * 16 + 8 }} />;
}
