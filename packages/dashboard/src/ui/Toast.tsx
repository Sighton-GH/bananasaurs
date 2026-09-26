import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from 'react';
import { Button } from './Button.js';

export type ToastTone = 'neutral' | 'hold' | 'danger' | 'ok';

export interface ToastInput {
  readonly tone: ToastTone;
  readonly title: string;
  readonly message?: string;
  /** A small muted line under the message: `code · HTTP n · request id`. */
  readonly detail?: string;
}

interface Toast extends ToastInput {
  readonly id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | undefined>(undefined);

/** Neutral and ok toasts leave on their own; hold and danger stay until dismissed, because they carry something the operator must read. */
const AUTO_DISMISS_MS = 6000;

const TONE: Record<ToastTone, string> = {
  neutral: 'border-line bg-panel',
  hold: 'border-hold bg-hold text-hold-ink',
  danger: 'border-danger bg-panel',
  ok: 'border-ok bg-panel',
};

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { ...input, id }]);
      if (input.tone === 'neutral' || input.tone === 'ok') {
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 flex w-80 flex-col gap-2"
      >
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-sm border px-3 py-2 text-sm ${TONE[t.tone]}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{t.title}</p>
              <Button
                className="px-1.5 py-0 text-xs"
                onClick={() => dismiss(t.id)}
                aria-label={`Dismiss: ${t.title}`}
              >
                ×
              </Button>
            </div>
            {t.message !== undefined && <p className="mt-1">{t.message}</p>}
            {t.detail !== undefined && (
              <p className="mt-1 text-xs text-ink-muted">{t.detail}</p>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext);
  if (push === undefined) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}
