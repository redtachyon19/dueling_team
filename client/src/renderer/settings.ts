import { useEffect, useState } from "react";

export interface AppSettings {
  /** Duel-board tilt in degrees. 0 = flat top-down, higher = more perspective. */
  boardTilt: number;
  /** Uniform zoom on the whole field, contents included. 1 = fit to the window. */
  boardScale: number;
  /** Deck-stack height multiplier. 1 = physically exact card thickness. */
  deckThickness: number;
  /** Horizontal nudge of the field, in px. 0 = centred; negative = left. */
  boardShiftX: number;
  /** Vertical nudge of the field, in px. 0 = centred; negative = up. */
  boardShiftY: number;
}

export const DEFAULTS: AppSettings = { boardTilt: 16, boardScale: 1.15, deckThickness: 1.6, boardShiftX: 0, boardShiftY: 0 };

export const LIMITS: Record<keyof AppSettings, { min: number; max: number; step: number }> = {
  boardTilt: { min: 0, max: 90, step: 1 },
  boardScale: { min: 0.7, max: 1.8, step: 0.05 },
  deckThickness: { min: 0.5, max: 3, step: 0.1 },
  boardShiftX: { min: -500, max: 500, step: 5 },
  boardShiftY: { min: -500, max: 500, step: 5 },
};

const KEY = "duelingteam.settings";
const EVENT = "duelingteam:settings";

function clampValue<K extends keyof AppSettings>(key: K, value: number): number {
  const { min, max } = LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

export function readSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const num = <K extends keyof AppSettings>(key: K, v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? clampValue(key, v) : DEFAULTS[key];
    return {
      boardTilt: num("boardTilt", parsed.boardTilt),
      boardScale: num("boardScale", parsed.boardScale),
      deckThickness: num("deckThickness", parsed.deckThickness),
      boardShiftX: num("boardShiftX", parsed.boardShiftX),
      boardShiftY: num("boardShiftY", parsed.boardShiftY),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  const next = { ...readSettings(), [key]: clampValue(key, value as number) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable — the in-memory value below still applies for this session
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

/** Live-updating settings: a change on the Settings page reaches an open duel. */
export function useSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(readSettings);
  useEffect(() => {
    const onChange = () => setSettings(readSettings());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return settings;
}
