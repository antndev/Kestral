import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText as clipReadText, writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, CircleAlert, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usePrefs } from "./lib/prefs";
import { terminalTheme } from "./lib/terminal-themes";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

type Stage = "connecting" | "authenticating" | "opening-shell" | "connected" | "error" | "closed";
interface Status {
  stage: Stage;
  detail: string;
}

const STAGE_TEXT: Record<Stage, string> = {
  connecting: "Connecting",
  authenticating: "Authenticating",
  "opening-shell": "Opening shell",
  connected: "Connected",
  error: "Connection failed",
  closed: "Disconnected",
};

const PW_PROMPT = /(password|passphrase|passcode|verification code)[^\n]{0,40}:\s*$/i;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function SshTerminal({ hostId }: { hostId: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>({ stage: "connecting", detail: "" });
  const [gen, setGen] = useState(0);

  const { termTheme, termColors } = usePrefs();
  const termThemeRef = useRef(termTheme);
  termThemeRef.current = termTheme;
  const colorsRef = useRef(termColors);
  colorsRef.current = termColors;
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let disposed = false;
    const sessionId = crypto.randomUUID();
    setStatus({ stage: "connecting", detail: "" });

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: terminalTheme(termThemeRef.current, colorsRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) void openUrl(uri);
      }),
    );
    term.open(el);

    const paste = async () => {
      try {
        const txt = await clipReadText();
        if (!disposed && txt) term.paste(txt);
      } catch {
      }
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && k === "c") {
        const sel = term.getSelection();
        if (sel) clipWriteText(sel).catch(() => {});
        return false;
      }
      if (e.ctrlKey && e.shiftKey && k === "v") {
        e.preventDefault();
        void paste();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && k === "c") {
        const sel = term.getSelection();
        if (sel) {
          clipWriteText(sel).catch(() => {});
          term.clearSelection();
          return false;
        }
        return true;
      }
      if (e.ctrlKey && !e.shiftKey && k === "v") {
        e.preventDefault();
        void paste();
        return false;
      }
      return true;
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void paste();
    };
    el.addEventListener("contextmenu", onContextMenu);

    const decoder = new TextDecoder();
    let outTail = "";
    const onOutput = new Channel<ArrayBuffer>();
    onOutput.onmessage = (buf) => {
      if (disposed) return;
      const bytes = new Uint8Array(buf);
      term.write(bytes);
      try {
        outTail = (outTail + decoder.decode(bytes, { stream: true })).slice(-400);
      } catch {
      }
    };

    let lineBuf = "";
    let lineSecret = false;
    const feed = (text: string) => {
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          const cmd = lineBuf.trim();
          const secret = lineSecret;
          lineBuf = "";
          lineSecret = false;
          if (cmd && !secret) void invoke("audit_user_command", { hostId, command: cmd });
        } else if (ch === "\x7f" || ch === "\b") {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch === "\x03" || ch === "\x15") {
          lineBuf = "";
          lineSecret = false;
        } else if (ch >= " ") {
          if (lineBuf === "") {
            const lastLine = (outTail.split(/[\r\n]/).pop() ?? "").replace(ANSI, "");
            lineSecret = PW_PROMPT.test(lastLine);
          }
          lineBuf += ch;
        }
      }
    };
    const dataSub = term.onData((data) => {
      void invoke("ssh_write", { id: sessionId, data });
      if (data.startsWith("\x1b")) {
        const m = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
        if (m) feed(m[1]);
        return;
      }
      feed(data);
    });

    const statusSub = listen<{ id: string; stage: Stage; detail: string }>("session-status", (e) => {
      if (!disposed && e.payload.id === sessionId) {
        setStatus({ stage: e.payload.stage, detail: e.payload.detail });
      }
    });
    const closeSub = listen<string>("session-closed", (e) => {
      if (!disposed && e.payload === sessionId) {
        term.write("\r\n\x1b[33m[Verbindung getrennt]\x1b[0m\r\n");
        setStatus({ stage: "closed", detail: "" });
      }
    });

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
      }
      if (disposed) return;
      void invoke("ssh_open_shell", {
        id: sessionId,
        hostId,
        cols: term.cols,
        rows: term.rows,
        onOutput,
      })
        .then(() => {
          if (disposed) void invoke("ssh_close", { id: sessionId });
        })
        .catch((err) => {
          if (!disposed) setStatus({ stage: "error", detail: String(err) });
        });
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
        }
        void invoke("ssh_resize", { id: sessionId, cols: term.cols, rows: term.rows });
      });
    });
    ro.observe(el);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub.dispose();
      statusSub.then((f) => f());
      closeSub.then((f) => f());
      el.removeEventListener("contextmenu", onContextMenu);
      void invoke("ssh_close", { id: sessionId });
      term.dispose();
      termRef.current = null;
    };
  }, [hostId, gen]);

  useEffect(() => {
    const t = termRef.current;
    if (t) {
      t.options.theme = terminalTheme(termTheme, termColors);
      t.refresh(0, t.rows - 1);
    }
  }, [termTheme, termColors]);

  const STEPS: Stage[] = ["connecting", "authenticating", "opening-shell"];
  const connecting = STEPS.includes(status.stage);
  const curIdx = STEPS.indexOf(status.stage);
  const reconnect = () => setGen((g) => g + 1);

  return (
    <div className="relative h-full w-full bg-[var(--term-bg)] p-3">
      <div ref={wrapRef} className="h-full w-full" />

      {status.stage !== "connected" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-[1px] animate-in fade-in-0 duration-150">
          <div className="flex flex-col items-center gap-5 text-center px-6">
            {connecting ? (
              <div className="flex flex-col gap-3 text-left">
                {STEPS.map((s, i) => {
                  const done = i < curIdx;
                  const activeStep = i === curIdx;
                  return (
                    <div key={s} className="flex items-center gap-3">
                      <div
                        className={
                          "size-7 rounded-full flex items-center justify-center shrink-0 border " +
                          (done
                            ? "bg-white/15 border-transparent text-white"
                            : activeStep
                              ? "border-white/60 text-white"
                              : "border-white/15 text-white/30")
                        }
                      >
                        {done ? (
                          <Check className="size-4" />
                        ) : activeStep ? (
                          <Spinner className="size-4" />
                        ) : (
                          <span className="text-xs">{i + 1}</span>
                        )}
                      </div>
                      <span className={activeStep ? "text-sm text-white/90 font-medium" : done ? "text-sm text-white/60" : "text-sm text-white/30"}>
                        {STAGE_TEXT[s]}
                        {activeStep && status.detail ? ` · ${status.detail}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <div
                  className={
                    "size-12 rounded-full flex items-center justify-center " +
                    (status.stage === "error" ? "bg-destructive/20 text-destructive" : "bg-white/10 text-white/70")
                  }
                >
                  {status.stage === "error" ? <CircleAlert className="size-6" /> : <PlugZap className="size-6" />}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="text-sm text-white/90 font-medium">{STAGE_TEXT[status.stage]}</div>
                  {status.detail && <div className="text-xs text-white/50 max-w-xs break-words">{status.detail}</div>}
                </div>
                <Button size="sm" variant="secondary" onClick={reconnect}>Reconnect</Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
