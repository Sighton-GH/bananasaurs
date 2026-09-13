import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiFetch, ApiError, CSRF_HEADER, ReadonlyError, type SessionInfo } from '../api.js';
import { ReauthDialog } from '../ui/ReauthDialog.js';
import { ToastProvider, useToast } from '../ui/Toast.js';

export interface Session {
  readonly info: SessionInfo;
  /** GET. Throws `ApiError` on failure so `useResource` can render it. */
  read<T>(url: string): Promise<T>;
  /**
   * A write. Returns `undefined` after showing a toast when the instance is
   * read-only (`ReadonlyError`) or the request failed (`ApiError`), so callers
   * refresh only on success. The re-auth round trip is `apiFetch`'s.
   */
  write<T>(url: string, body: unknown, method?: 'POST' | 'PUT' | 'DELETE'): Promise<T | undefined>;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | undefined>(undefined);

/** One outstanding re-auth request at a time, resolved by the dialog below. */
type ReauthResolver = (password: string | undefined) => void;

function SessionInner({
  session,
  onLoggedOut,
  children,
}: {
  readonly session: SessionInfo;
  readonly onLoggedOut: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const toast = useToast();
  const [reauth, setReauth] = useState<ReauthResolver | undefined>(undefined);

  const requireReauth = useCallback(
    (): Promise<string | undefined> =>
      new Promise((resolve) => {
        setReauth(() => (password: string | undefined) => {
          setReauth(undefined);
          resolve(password);
        });
      }),
    [],
  );

  const value = useMemo<Session>(
    () => ({
      info: session,
      read: <T,>(url: string) => apiFetch<T>(url, session.csrfToken, requireReauth),
      write: async <T,>(url: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => {
        try {
          return await apiFetch<T>(url, session.csrfToken, requireReauth, {
            method,
            body: JSON.stringify(body),
          });
        } catch (err) {
          if (err instanceof ReadonlyError) {
            toast({ tone: 'hold', title: 'This instance is read-only', message: err.message });
            return undefined;
          }
          if (
            err instanceof ApiError &&
            err.status === 401 &&
            err.body.error === 'reauth-required'
          ) {
            toast({ tone: 'neutral', title: 'Cancelled', message: 'Nothing was changed.' });
            return undefined;
          }
          if (err instanceof ApiError && err.status === 401) {
            toast({
              tone: 'danger',
              title: 'Password not accepted',
              message: 'Nothing was changed. Try again.',
            });
            return undefined;
          }
          if (err instanceof ApiError) {
            toast({ tone: 'danger', title: 'The request failed', message: err.message });
            return undefined;
          }
          throw err;
        }
      },
      logout: async () => {
        await fetch('/api/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [CSRF_HEADER]: session.csrfToken },
        });
        onLoggedOut();
      },
    }),
    [session, requireReauth, toast, onLoggedOut],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <ReauthDialog
        open={reauth !== undefined}
        onSubmit={(password) => reauth?.(password)}
        onCancel={() => reauth?.(undefined)}
      />
    </SessionContext.Provider>
  );
}

export function SessionProvider(props: {
  readonly session: SessionInfo;
  readonly onLoggedOut: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ToastProvider>
      <SessionInner {...props} />
    </ToastProvider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
