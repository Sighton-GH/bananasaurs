import * as Radix from '@radix-ui/react-tooltip';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from 'react';
import { Button } from './Button.js';
import { TooltipProvider } from './Tooltip.js';
import {
  Icon,
  IconClose,
  IconError,
  IconInfo,
  IconSuccess,
  IconWarning,
  type LucideIcon,
} from './icons.js';

export type ToastTone = 'neutral' | 'hold' | 'danger' | 'ok';

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastInput {
  readonly tone: ToastTone;
  readonly title: string;
  readonly message?: string;
  /** A small muted line under the message: `code · HTTP n · request id`. */
  readonly detail?: string;
  /** One action, such as Undo. Clicking it runs onClick and dismisses the toast. */
  readonly action?: ToastAction;
}

interface Toast extends ToastInput {
  readonly id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | undefined>(undefined);

/** Neutral and ok toasts leave on their own; an ok toast with an action stays longer so there is time to press it. */
const AUTO_DISMISS_MS = 6000;
const AUTO_DISMISS_WITH_ACTION_MS = 10000;

/**
 * Errors are announced assertively, success politely (ADR 0142): hold and
 * danger toasts render into a `role="alert"` region and stay until dismissed;
 * neutral and ok render into a polite `role="status"` region.
 */
const ASSERTIVE: ReadonlySet<ToastTone> = new Set(['hold', 'danger']);

const BORDER: Record<ToastTone, string> = {
  neutral: 'border-line',
  hold: 'border-tone-hold',
  danger: 'border-tone-danger',
  ok: 'border-tone-ok',
};

const ICON: Record<ToastTone, LucideIcon> = {
  neutral: IconInfo,
  hold: IconWarning,
  danger: IconError,
  ok: IconSuccess,
};

/**
 * COUPLING (explicit): the stack keeps clear of the app's sticky mobile header
 * by measuring the first `<header>` element at runtime. The Shell is not edited
 * and no height is hardcoded. With no header, or a hidden one (zero height, as
 * at lg), the inset is 0 and the stack falls back to the viewport cap.
 */
function measureHeaderInset(): number {
  if (typeof document === 'undefined') return 0;
  const header = document.querySelector('header');
  if (header === null) return 0;
  const bottom = header.getBoundingClientRect().bottom;
  return Number.isFinite(bottom) && bottom > 0 ? Math.ceil(bottom) : 0;
}

function useHeaderInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const update = (): void => setInset(measureHeaderInset());
    update();
    window.addEventListener('resize', update);
    const header = document.querySelector('header');
    const observer =
      header !== null && typeof ResizeObserver === 'function'
        ? new ResizeObserver(update)
        : undefined;
    if (header !== null) observer?.observe(header);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [active]);
  return active ? inset : 0;
}

/** Narrow cards put the icon and Dismiss on their own rows; the tooltip opens to the left, over empty row space, never over the title. */
function useNarrow(): boolean {
  const query = '(min-width: 640px)';
  // No window during server rendering: assume wide, the tooltip is portalled and closed anyway.
  const [wide, setWide] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const on = (): void => setWide(media.matches);
    on();
    media.addEventListener?.('change', on);
    return () => media.removeEventListener?.('change', on);
  }, []);
  return !wide;
}

const MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

function modalIsOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector(MODAL) !== null;
}

/**
 * The Dismiss tooltip sits on the tooltip layer (z-50) so it clears the sticky
 * header, but a dialog without a z-layer (ConfirmDialog) would then be painted
 * under it. While any open dialog exists the tooltip is therefore closed and
 * cannot open; Radix's own modal already blocks hover and traps focus, so no
 * focus handling is added here.
 */
function DismissTooltip(props: { narrow: boolean; children: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const observer = new MutationObserver(() => {
      if (modalIsOpen()) setOpen(false);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [open]);
  return (
    <Radix.Root open={open} onOpenChange={(next) => setOpen(next && !modalIsOpen())}>
      <Radix.Trigger asChild>{props.children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={props.narrow ? 'left' : 'top'}
          sideOffset={4}
          className="z-50 max-w-xs rounded-control border border-line bg-panel px-2 py-1 text-caption text-ink shadow-float"
        >
          Dismiss
          <Radix.Arrow className="fill-panel" />
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}

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
      if (!ASSERTIVE.has(input.tone)) {
        const ms =
          input.tone === 'ok' && input.action !== undefined
            ? AUTO_DISMISS_WITH_ACTION_MS
            : AUTO_DISMISS_MS;
        setTimeout(() => dismiss(id), ms);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  const narrow = useNarrow();
  const inset = useHeaderInset(toasts.length > 0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  // Keep half the space below the measured header free for page actions.
  // Persistent notices scroll inside their half; page focus is revealed in
  // the other half without moving focus or dismissing the refusal.
  const hasToasts = toasts.length > 0;
  useEffect(() => {
    const stack = stackRef.current;
    if (!hasToasts || stack === null) return undefined;
    const root = document.documentElement;
    const previousScrollPadding = root.style.scrollPaddingBottom;
    const previousBodyPadding = document.body.style.paddingBottom;
    let frame = 0;
    const reveal = (): void => {
      frame = 0;
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        stack.contains(active) ||
        modalIsOpen()
      )
        return;
      const rect = active.getBoundingClientRect();
      const top = measureHeaderInset() + 8;
      const bottom = stack.getBoundingClientRect().top - 8;
      if (bottom <= top) return;
      // Tall controls align their start to the safe corridor rather than
      // alternating between opposing edges on successive measurements.
      const delta =
        rect.height > bottom - top || rect.top < top
          ? rect.top - top
          : rect.bottom > bottom
            ? rect.bottom - bottom
            : 0;
      if (delta !== 0) window.scrollBy({ top: delta, behavior: 'instant' });
    };
    const scheduleReveal = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const apply = (): void => {
      const h = Math.ceil(stack.getBoundingClientRect().height) + 24;
      root.style.scrollPaddingBottom = `${h}px`;
      // Add to, rather than discard, any existing page padding.
      document.body.style.paddingBottom = `calc(${previousBodyPadding || '0px'} + ${h}px)`;
      scheduleReveal();
    };
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : undefined;
    observer?.observe(stack);
    const header = document.querySelector('header');
    if (header !== null) observer?.observe(header);
    window.addEventListener('resize', apply);
    document.addEventListener('focusin', scheduleReveal);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', apply);
      document.removeEventListener('focusin', scheduleReveal);
      cancelAnimationFrame(frame);
      root.style.scrollPaddingBottom = previousScrollPadding;
      document.body.style.paddingBottom = previousBodyPadding;
    };
  }, [hasToasts]);
  const assertive = toasts.filter((t) => ASSERTIVE.has(t.tone));
  const polite = toasts.filter((t) => !ASSERTIVE.has(t.tone));

  const renderToast = (t: Toast): ReactElement => {
    const action = t.action;
    return (
      <div
        key={t.id}
        className={`min-w-0 shrink-0 rounded-panel border bg-panel px-3 py-2 text-sm shadow-float ${BORDER[t.tone]}`}
      >
        <div className="flex flex-col items-stretch gap-1 sm:flex-row sm:items-start sm:gap-2">
          <Icon icon={ICON[t.tone]} className="shrink-0 self-start sm:mt-0.5" />
          <div className="min-w-0 [overflow-wrap:anywhere] sm:flex-1">
            <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-start">
              <p className="min-w-0 flex-1 font-medium">{t.title}</p>
              <DismissTooltip narrow={narrow}>
                <Button
                  className="shrink-0 self-end px-1.5 py-0 text-xs sm:self-auto"
                  onClick={() => dismiss(t.id)}
                  aria-label={`Dismiss: ${t.title}`}
                >
                  <Icon icon={IconClose} />
                </Button>
              </DismissTooltip>
            </div>
            {t.message !== undefined && <p className="mt-1">{t.message}</p>}
            {t.detail !== undefined && <p className="mt-1 text-xs text-ink-muted">{t.detail}</p>}
            {action !== undefined && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  action.onClick();
                  dismiss(t.id);
                }}
              >
                {action.label}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <TooltipProvider>
        <div
          data-toast-stack=""
          ref={stackRef}
          style={{ maxHeight: `calc((100dvh - ${inset}px - 2rem) / 2)` }}
          className="fixed right-4 bottom-4 flex max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100%-2rem)] flex-col gap-2 overflow-y-auto overscroll-contain"
        >
          {/* Only mounted while an assertive toast exists, so an empty toast
            region never collides with an inline error's role="alert". */}
          {assertive.length > 0 && (
            <div role="alert" className="flex shrink-0 flex-col gap-2">
              {assertive.map(renderToast)}
            </div>
          )}
          <div role="status" aria-live="polite" className="flex shrink-0 flex-col gap-2">
            {polite.map(renderToast)}
          </div>
        </div>
      </TooltipProvider>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext);
  if (push === undefined) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}
