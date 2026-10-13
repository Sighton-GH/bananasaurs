import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Open/closed state for the jump palette, its global Ctrl/Cmd-K key, and the
 * one place focus is restored. The callbacks are stable across renders.
 */
export interface PaletteState {
  readonly isOpen: boolean;
  /** Increments on every open, so a consumer can tell one open from the next. */
  readonly openCount: number;
  readonly open: () => void;
  readonly close: () => void;
  /** Close after navigating: the shell's main-focus contract wins, no restore. */
  readonly closeForNavigation: () => void;
  /** Called from the dialog's close-autofocus: restores the opener at most once per open. */
  readonly restoreFocus: () => void;
}

const PaletteContext = createContext<PaletteState | undefined>(undefined);

export function PaletteProvider({ children }: { readonly children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const openRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const skipRestoreRef = useRef(false);

  const open = useCallback(() => {
    if (openRef.current) return;
    openRef.current = true;
    skipRestoreRef.current = false;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setOpenCount((n) => n + 1);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
  }, []);

  const closeForNavigation = useCallback(() => {
    if (!openRef.current) return;
    skipRestoreRef.current = true;
    openRef.current = false;
    setOpen(false);
  }, []);

  const restoreFocus = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (skipRestoreRef.current) {
      skipRestoreRef.current = false;
      return;
    }
    if (opener?.isConnected === true) opener.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k') return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (event.repeat) return;
      if (openRef.current) close();
      else open();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  const value = useMemo<PaletteState>(
    () => ({ isOpen, openCount, open, close, closeForNavigation, restoreFocus }),
    [isOpen, openCount, open, close, closeForNavigation, restoreFocus],
  );
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalette(): PaletteState {
  const value = useContext(PaletteContext);
  if (value === undefined) throw new Error('usePalette must be used inside PaletteProvider');
  return value;
}
