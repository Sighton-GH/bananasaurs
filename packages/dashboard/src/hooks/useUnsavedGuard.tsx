import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation } from 'wouter';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';

/** A blocked anchor can ask its owning navigation surface to yield before the
 * confirmation mounts. Only that surface supplies a stable return-focus target;
 * ordinary page anchors keep ConfirmDialog's existing focus behavior. */
export const UNSAVED_NAVIGATION_EVENT = 'dashboard:unsaved-navigation';
export interface UnsavedNavigationHandoff {
  returnFocus: (() => HTMLElement | null) | null;
}

/** Guards in-app path anchors and browser unload, not programmatic navigation or Back. */
export function useUnsavedGuard(dirty: boolean): ReactElement | null {
  const [, navigate] = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const returnFocusRef = useRef<(() => HTMLElement | null) | null>(null);
  const leavingRef = useRef(false);

  useEffect(() => {
    pendingRef.current = null;
    setPending(null);
    if (!dirty) return undefined;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    const intercept = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      const element =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const anchor = element?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute('href');
      const context = anchor.getAttribute('target');
      if (
        href === null ||
        !href.startsWith('/') ||
        href.startsWith('//') ||
        anchor.hasAttribute('download') ||
        (context !== null && context !== '' && context.toLowerCase() !== '_self')
      )
        return;
      const destination = new URL(href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      // Wouter's Link click handler would navigate during bubbling. Stop it
      // here, before any React handler sees the click, including repeated clicks.
      event.preventDefault();
      event.stopPropagation();
      if (pendingRef.current !== null) return;
      const handoff: UnsavedNavigationHandoff = { returnFocus: null };
      anchor.dispatchEvent(
        new CustomEvent<UnsavedNavigationHandoff>(UNSAVED_NAVIGATION_EVENT, {
          bubbles: true,
          detail: handoff,
        }),
      );
      returnFocusRef.current = handoff.returnFocus;
      leavingRef.current = false;
      pendingRef.current = destination.pathname + destination.search + destination.hash;
      setPending(pendingRef.current);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', intercept, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', intercept, true);
      pendingRef.current = null;
    };
  }, [dirty]);

  if (!dirty || pending === null) return null;
  const stay = (): void => {
    pendingRef.current = null;
    setPending(null);
  };
  const leave = (): void => {
    const destination = pendingRef.current;
    leavingRef.current = true;
    stay();
    if (destination !== null) navigate(destination);
  };
  return (
    <ConfirmDialog
      open
      title="Leave without saving?"
      scope="Your changes on this page will be lost."
      cancelLabel="Stay"
      confirmLabel="Leave"
      onCancel={stay}
      onConfirm={leave}
      {...(returnFocusRef.current === null
        ? {}
        : {
            returnFocus: () =>
              leavingRef.current
                ? document.getElementById('main')
                : (returnFocusRef.current?.() ?? null),
          })}
    />
  );
}
