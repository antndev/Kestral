import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TERMINAL_THEMES, DEFAULT_TERM_THEME, termThemeOf, type TermThemeId } from "./terminal-themes";

// Zentrale, lokal gespeicherte Benutzereinstellungen. Ein einziger Provider haelt
// Theme, Animationsgeschwindigkeit, Terminal-Farbschema und die AI-Standarddauer,
// wendet die Seiteneffekte an (dark-Klasse, data-anim, --term-bg) und stellt
// alles ueber usePrefs() bereit.

export type Theme = "system" | "light" | "dark";

// Animationsgeschwindigkeit als stufenloser Faktor. 1 = normal, 0 = aus.
export const ANIM_MIN = 0;
export const ANIM_MAX = 1.5;
export const ANIM_DEFAULT = 1;

const THEME_KEY = "helmsman-theme";
const ANIM_KEY = "helmsman-anim";
const TERM_KEY = "helmsman-term-theme";
const AI_MIN_KEY = "helmsman-ai-minutes";
const SFTP_HIDDEN_KEY = "helmsman-sftp-hidden";
const SFTP_AUTOREFRESH_KEY = "helmsman-sftp-autorefresh";
const TERM_COLORS_KEY = "helmsman-term-colors";

export const THEMES: Theme[] = ["system", "light", "dark"];

function readAnimScale(): number {
  const v = localStorage.getItem(ANIM_KEY);
  if (v === "off") return 0;
  if (v === "fast") return 0.6;
  if (v === "normal" || v === null) return ANIM_DEFAULT;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(ANIM_MAX, Math.max(ANIM_MIN, n)) : ANIM_DEFAULT;
}

async function applyTheme(t: Theme) {
  const win = getCurrentWindow();
  // Bei "system" das Fenster dem OS folgen lassen (null). Nur so spiegelt
  // prefers-color-scheme wieder das echte OS und nicht ein vorher gesetztes Theme.
  try {
    await win.setTheme(t === "light" ? "light" : t === "dark" ? "dark" : null);
  } catch {
    /* nicht im Tauri-Kontext */
  }
  let dark: boolean;
  if (t === "light") dark = false;
  else if (t === "dark") dark = true;
  else {
    // Effektives OS-Theme bevorzugt ueber Tauri abfragen, sonst Media Query.
    let resolved: string | null = null;
    try {
      resolved = await win.theme();
    } catch {
      /* ignore */
    }
    dark = resolved ? resolved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  document.documentElement.classList.toggle("dark", dark);
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = localStorage.getItem(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

type Prefs = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  termTheme: TermThemeId;
  setTermTheme: (id: TermThemeId) => void;
  termColors: boolean;
  setTermColors: (v: boolean) => void;
  animScale: number;
  setAnimScale: (v: number) => void;
  aiMinutes: number;
  setAiMinutes: (m: number) => void;
  sftpShowHidden: boolean;
  setSftpShowHidden: (v: boolean) => void;
  sftpAutoRefresh: boolean;
  setSftpAutoRefresh: (v: boolean) => void;
};

const PrefsCtx = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const c = useContext(PrefsCtx);
  if (!c) throw new Error("usePrefs must be used within PrefsProvider");
  return c;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readEnum(THEME_KEY, THEMES, "system"));
  const [animScale, setAnimScaleState] = useState<number>(() => readAnimScale());
  const [termTheme, setTermThemeState] = useState<TermThemeId>(() => {
    const v = localStorage.getItem(TERM_KEY);
    return v && TERMINAL_THEMES[v] ? v : DEFAULT_TERM_THEME;
  });
  const [aiMinutes, setAiMinutesState] = useState<number>(() => {
    const v = Number(localStorage.getItem(AI_MIN_KEY));
    return Number.isFinite(v) && v > 0 ? v : 30;
  });
  // Standard: versteckte Dateien zeigen und automatisch aktualisieren (an).
  const [sftpShowHidden, setSftpShowHiddenState] = useState<boolean>(
    () => localStorage.getItem(SFTP_HIDDEN_KEY) !== "false",
  );
  const [sftpAutoRefresh, setSftpAutoRefreshState] = useState<boolean>(
    () => localStorage.getItem(SFTP_AUTOREFRESH_KEY) !== "false",
  );
  const [termColors, setTermColorsState] = useState<boolean>(
    () => localStorage.getItem(TERM_COLORS_KEY) !== "false",
  );

  useEffect(() => {
    void applyTheme(theme);
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") void applyTheme("system");
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--anim-scale", String(animScale));
    // Globaler Override nur wenn vom Normalwert abweichend, sonst behalten die
    // Komponenten ihre eigens abgestimmten Dauern.
    root.toggleAttribute("data-anim-scaled", Math.abs(animScale - 1) > 0.001);
  }, [animScale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--term-bg", termThemeOf(termTheme).theme.background ?? "#1e1e1e");
  }, [termTheme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  };
  const setAnimScale = (v: number) => {
    const clamped = Math.min(ANIM_MAX, Math.max(ANIM_MIN, v));
    localStorage.setItem(ANIM_KEY, String(clamped));
    setAnimScaleState(clamped);
  };
  const setTermTheme = (id: TermThemeId) => {
    localStorage.setItem(TERM_KEY, id);
    setTermThemeState(id);
  };
  const setAiMinutes = (m: number) => {
    localStorage.setItem(AI_MIN_KEY, String(m));
    setAiMinutesState(m);
  };
  const setSftpShowHidden = (v: boolean) => {
    localStorage.setItem(SFTP_HIDDEN_KEY, String(v));
    setSftpShowHiddenState(v);
  };
  const setSftpAutoRefresh = (v: boolean) => {
    localStorage.setItem(SFTP_AUTOREFRESH_KEY, String(v));
    setSftpAutoRefreshState(v);
  };
  const setTermColors = (v: boolean) => {
    localStorage.setItem(TERM_COLORS_KEY, String(v));
    setTermColorsState(v);
  };

  return (
    <PrefsCtx.Provider
      value={{
        theme,
        setTheme,
        animScale,
        setAnimScale,
        termTheme,
        setTermTheme,
        termColors,
        setTermColors,
        aiMinutes,
        setAiMinutes,
        sftpShowHidden,
        setSftpShowHidden,
        sftpAutoRefresh,
        setSftpAutoRefresh,
      }}
    >
      <MotionConfig reducedMotion={animScale < 0.05 ? "always" : "user"}>{children}</MotionConfig>
    </PrefsCtx.Provider>
  );
}
