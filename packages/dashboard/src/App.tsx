import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Router } from 'wouter';
import { getSession, type SessionInfo } from './api.js';
import { SessionProvider } from './app/session.js';
import { Shell } from './app/Shell.js';
import { ThemeProvider } from './app/theme.js';
import { BootstrapForm, LoginForm } from './pages/login.js';

// --- top-level session state machine ----------------------------------------

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anon' }
  | { readonly kind: 'bootstrap'; readonly token: string }
  | { readonly kind: 'authed'; readonly session: SessionInfo };

const bootstrapToken = (): string | undefined => {
  if (window.location.pathname !== '/bootstrap') return undefined;
  return new URLSearchParams(window.location.search).get('token') ?? undefined;
};

/**
 * Login and first-run setup render *instead of* the shell, not inside it, so
 * they are not routes (ADR 0043 D3). Once authed, `wouter` owns the path.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const check = useCallback(() => {
    void getSession().then((result) => {
      if (result.authenticated) {
        setPhase({ kind: 'authed', session: result });
        return;
      }
      const token = bootstrapToken();
      setPhase(token !== undefined ? { kind: 'bootstrap', token } : { kind: 'anon' });
    });
  }, []);

  useEffect(check, [check]);

  let body: ReactNode;
  if (phase.kind === 'loading') {
    body = (
      <p role="status" className="p-6 text-sm text-ink-muted">
        Loading…
      </p>
    );
  } else if (phase.kind === 'anon') {
    body = <LoginForm onSignedIn={check} />;
  } else if (phase.kind === 'bootstrap') {
    body = <BootstrapForm token={phase.token} onSignedIn={check} />;
  } else {
    body = (
      <SessionProvider session={phase.session} onLoggedOut={check}>
        <Router>
          <Shell />
        </Router>
      </SessionProvider>
    );
  }
  // The provider wraps login and bootstrap too: the toggle must be reachable
  // before a session exists.
  return <ThemeProvider>{body}</ThemeProvider>;
}
