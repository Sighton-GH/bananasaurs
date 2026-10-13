/**
 * Runs before React mounts (imported first in main.tsx), so a first visit on
 * a dark-OS machine does not flash dark before turning light (ADR 0142
 * decision 2). A module, not an inline script, so the CSP stays as it is.
 */
export const THEME_STORAGE_KEY = 'bananasaurs-theme';

/** The slice of `HTMLElement` this needs; the root typecheck program has no DOM lib. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export const bootTheme = (
  storage: { getItem(key: string): string | null },
  root: ThemeRoot,
): void => {
  let saved: string | null = null;
  try {
    saved = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: fall through to the light default.
  }
  if (saved === 'system') {
    root.removeAttribute('data-theme');
    return;
  }
  root.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');
};
