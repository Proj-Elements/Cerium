import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "cerium-theme";
const systemQuery = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    if (isThemePreference(stored)) return stored;
  } catch {
    /* Theme selection still works when browser storage is unavailable. */
  }
  return "system";
}

export function applyTheme(
  preference: ThemePreference,
  systemDark = window.matchMedia(systemQuery).matches,
) {
  document.documentElement.classList.toggle(
    "dark",
    preference === "dark" || (preference === "system" && systemDark),
  );
  document.documentElement.dataset.theme = preference;
}

export function useThemePreference() {
  const [preference, setPreference] = useState(readThemePreference);

  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const sync = () => applyTheme(preference, media.matches);
    sync();
    if (preference !== "system") return;
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        setPreference(readThemePreference());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function changePreference(next: ThemePreference) {
    applyTheme(next);
    setPreference(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* Keep the in-memory preference even without persistent storage. */
    }
  }

  return [preference, changePreference] as const;
}
