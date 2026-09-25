import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiFetch, ApiError, CSRF_HEADER, ReadonlyError, type SessionInfo } from '../api.js';
import { accountErrorText } from '../api/ops.js';
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
  write<T>(
    url: string,
    body: unknown,
    method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  ): Promise<T | undefined>;
  /**
   * The same write, but status 400 and 409 propagate to the caller instead
   * of becoming a toast. Forms that render the server's answer inline (the
   * new-rule form's `invalid-config` detail, the mode dialog's
   * `not-eligible` refusal) use this; everything else uses `write`. Any
   * other failure is handled itself (toast shown; `onLoggedOut()` called
   * for an expired session) and resolves `undefined`.
   *
   * A caller that renders one more status inline (Try-it's 429
   * `rate-limited`) lists it in `rethrowStatuses`; every other caller keeps
   * the default and is unaffected.
   */
  writeOrThrow<T>(
    url: string,
    body: unknown,
    method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    rethrowStatuses?: readonly number[],
  ): Promise<T | undefined>;
  /**
   * Moves this session to another reachable guild without logging out
   * (S13-D7). Refreshes the session from the server on success — the cookie
   * is unchanged, so re-reading `/api/session` is what re-scopes the shell.
   */
  switchGuild(guildId: string): Promise<void>;
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

  /**
   * Prompts for the password one at a time. Two writes that both hit 401
   * `reauth-required` chain on the same promise rather than each installing
   * their own resolver — without this the second overwrote the first and its
   * write hung (Slice 7 whole-branch review). The chain is re-armed with a
   * guarded continuation so a rejection can never wedge later prompts.
   */
  const chain = useRef<Promise<void>>(Promise.resolve());

  const requireReauth = useCallback((): Promise<string | undefined> => {
    const next = chain.current.then(
      () =>
        new Promise<string | undefined>((resolve) => {
          setReauth(() => (password: string | undefined) => {
            setReauth(undefined);
            resolve(password);
          });
        }),
    );
    chain.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);

  const value = useMemo<Session>(() => {
    const handleWriteError = (err: unknown): boolean => {
      if (err instanceof ReadonlyError) {
        toast({ tone: 'hold', title: 'This instance is read-only', message: err.message });
        return true;
      }
      if (err instanceof ApiError && err.status === 401 && err.body.error === 'reauth-required') {
        toast({ tone: 'neutral', title: 'Cancelled', message: 'Nothing was changed.' });
        return true;
      }
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        err.body.error === 'invalid-credentials'
      ) {
        toast({
          tone: 'danger',
          title: 'Password not accepted',
          message: 'Nothing was changed. Try again.',
        });
        return true;
      }
      if (err instanceof ApiError && err.status === 401 && err.body.error === 'unauthenticated') {
        toast({
          tone: 'danger',
          title: 'Signed out',
          message: 'Your session has expired. Sign in again.',
        });
        onLoggedOut();
        return true;
      }
      if (err instanceof ApiError) {
        // A refusal body carries `{ error: code }` with no `message`, so
        // `err.message` would be the raw code — map known codes to their
        // plain sentence first, keeping the raw code only as the fallback.
        toast({
          tone: 'danger',
          title: 'The request failed',
          message: accountErrorText(err.body.error) ?? err.message,
        });
        return true;
      }
      return false;
    };
    const writeOrThrow = async <T,>(
      url: string,
      body: unknown,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
      rethrowStatuses: readonly number[] = [],
    ): Promise<T | undefined> => {
      try {
        return await apiFetch<T>(url, session.csrfToken, requireReauth, {
          method,
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 400 || err.status === 409 || rethrowStatuses.includes(err.status))
        )
          throw err;
        if (err instanceof ApiError) {
          handleWriteError(err);
          return undefined;
        }
        throw err;
      }
    };
    const write = async <T,>(
      url: string,
      body: unknown,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
    ): Promise<T | undefined> => {
      try {
        return await writeOrThrow<T>(url, body, method);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
          toast({
            tone: 'danger',
            title: 'The request failed',
            message: accountErrorText(err.body.error) ?? err.message,
          });
          return undefined;
        }
        throw err;
      }
    };
    return {
      info: session,
      read: <T,>(url: string) => apiFetch<T>(url, session.csrfToken, requireReauth),
      writeOrThrow,
      write,
      switchGuild: async (guildId: string): Promise<void> => {
        const updated = await write<{ guildId: string }>('/api/session/guild', { guildId });
        // `write` already toasted the failure and resolved undefined; only a
        // success re-reads the session, which is what re-scopes the shell.
        if (updated !== undefined) onLoggedOut();
      },
      logout: async () => {
        await fetch('/api/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [CSRF_HEADER]: session.csrfToken },
        });
        onLoggedOut();
      },
    };
  }, [session, requireReauth, toast, onLoggedOut]);

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
