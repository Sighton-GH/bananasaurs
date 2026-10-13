import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { THEME_STORAGE_KEY } from './theme-boot.js';

/**
 * Light/dark is an operator choice, not only a system one: the shell and
 * login carry a toggle that pins the scheme, persisted in localStorage.
 * A first visit is light (ADR 0142). A saved choice wins; a saved `system`
 * follows the OS. The `data-theme` attribute on <html> wins over the media
 * query (styles.css).
 */
export type Scheme = 'light' | 'dark';
export type ThemeChoice = 'system' | Scheme;

const readChoice = (): ThemeChoice => {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'system' ? stored : 'light';
  } catch {
    return 'light';
  }
};

const media = (): MediaQueryList | undefined =>
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : undefined;

const systemScheme = (): Scheme => (media()?.matches === true ? 'light' : 'dark');

interface ThemeValue {
  readonly choice: ThemeChoice;
  readonly scheme: Scheme;
  readonly setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue | undefined>(undefined);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [system, setSystem] = useState<Scheme>(systemScheme);

  useEffect(() => {
    const m = media();
    if (m === undefined) return;
    const onChange = () => setSystem(m.matches ? 'light' : 'dark');
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (choice === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', choice);
    }
  }, [choice]);

  const setChoice = (next: ThemeChoice) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setChoiceState(next);
  };

  const value = useMemo(
    () => ({ choice, scheme: choice === 'system' ? system : choice, setChoice }),
    [choice, system],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value === undefined) throw new Error('useTheme must run inside ThemeProvider');
  return value;
}
