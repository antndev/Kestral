import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { TERMINAL_THEMES, DEFAULT_TERM_THEME, termThemeOf, type TermThemeId } from "./terminal-themes";

// Zentrale, lokal gespeicherte Benutzereinstellungen. Ein einziger Provider haelt
// Theme, Animationsgeschwindigkeit, Terminal-Farbschema und die AI-Standarddauer,
// wendet die Seiteneffekte an (dark-Klasse, data-anim, --term-bg) und stellt
// alles ueber usePrefs() bereit.

export type Theme = "system" | "light" | "dark";
export type AnimSpeed = "normal" | "fast" | "off";

const THEME_KEY = "helmsman-theme";
const ANIM_KEY = "helmsman-anim";
const TERM_KEY = "helmsman-term-theme";
const AI_MIN_KEY = "helmsman-ai-minutes";

export const THEMES: Theme[] = ["system", "light", "dark"];
export const ANIM_SPEEDS: AnimSpeed[] = ["normal", "fast", "off"];

function applyTheme(t: Theme) {
  const dark =
    t === "dark" ||
    (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = localStorage.getItem(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

type Prefs = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  anim: AnimSpeed;
  setAnim: (a: AnimSpeed) => void;
  termTheme: TermThemeId;
  setTermTheme: (id: TermThemeId) => void;
  aiMinutes: number;
  setAiMinutes: (m: number) => void;
};

const PrefsCtx = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const c = useContext(PrefsCtx);
  if (!c) throw new Error("usePrefs must be used within PrefsProvider");
  return c;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readEnum(THEME_KEY, THEMES, "system"));
  const [anim, setAnimState] = useState<AnimSpeed>(() => readEnum(ANIM_KEY, ANIM_SPEEDS, "normal"));
  const [termTheme, setTermThemeState] = useState<TermThemeId>(() => {
    const v = localStorage.getItem(TERM_KEY);
    return v && TERMINAL_THEMES[v] ? v : DEFAULT_TERM_THEME;
  });
  const [aiMinutes, setAiMinutesState] = useState<number>(() => {
    const v = Number(localStorage.getItem(AI_MIN_KEY));
    return Number.isFinite(v) && v > 0 ? v : 30;
  });

  useEffect(() => {
    applyTheme(theme);
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") applyTheme("system");
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.anim = anim;
  }, [anim]);

  useEffect(() => {
    document.documentElement.style.setProperty("--term-bg", termThemeOf(termTheme).theme.background ?? "#1e1e1e");
  }, [termTheme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  };
  const setAnim = (a: AnimSpeed) => {
    localStorage.setItem(ANIM_KEY, a);
    setAnimState(a);
  };
  const setTermTheme = (id: TermThemeId) => {
    localStorage.setItem(TERM_KEY, id);
    setTermThemeState(id);
  };
  const setAiMinutes = (m: number) => {
    localStorage.setItem(AI_MIN_KEY, String(m));
    setAiMinutesState(m);
  };

  return (
    <PrefsCtx.Provider value={{ theme, setTheme, anim, setAnim, termTheme, setTermTheme, aiMinutes, setAiMinutes }}>
      <MotionConfig reducedMotion={anim === "off" ? "always" : "user"}>{children}</MotionConfig>
    </PrefsCtx.Provider>
  );
}
