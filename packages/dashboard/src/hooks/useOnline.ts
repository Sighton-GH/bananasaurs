import { useSyncExternalStore } from 'react';

/**
 * The slice of `window` and `navigator` this hook needs. `tsconfig.all.json`
 * type-checks `*.ts` without the DOM lib, so the hook reads them through
 * narrow structural types, the same way `useLiveResource` reads `document`.
 */
interface OnlineSource {
  readonly navigator?: { readonly onLine: boolean };
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

const source = (): OnlineSource | undefined =>
  (globalThis as { readonly window?: OnlineSource }).window;

function subscribe(listener: () => void): () => void {
  const target = source();
  if (target === undefined) return () => undefined;
  target.addEventListener('online', listener);
  target.addEventListener('offline', listener);
  return () => {
    target.removeEventListener('online', listener);
    target.removeEventListener('offline', listener);
  };
}

const snapshot = (): boolean => source()?.navigator?.onLine ?? true;
const serverSnapshot = (): boolean => true;

/** True while the browser believes it has a network; follows `online` / `offline`. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
