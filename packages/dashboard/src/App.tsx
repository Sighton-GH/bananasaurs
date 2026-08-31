import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getSession, ReadonlyError, type SessionInfo } from './api.js';

// --- login / bootstrap -------------------------------------------------------

function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string };
        setError(
          body.error === 'locked-out'
            ? 'This account is temporarily locked after too many failed attempts.'
            : body.error === 'read-only'
              ? ((body as { message?: string }).message ?? 'This instance is read-only.')
              : 'Wrong username or password.',
        );
        return;
      }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="panel">
      <h1>Bananasaurs</h1>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error !== undefined && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}

function BootstrapForm({ token, onSignedIn }: { token: string; onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/bootstrap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, username, password }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string; issues?: string[] };
        setError(body.issues?.join('; ') ?? body.error);
        return;
      }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="panel">
      <h1>First-run setup</h1>
      <p>Create the owner account. This link works once.</p>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </label>
      <label>
        Password (at least 12 characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error !== undefined && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        Create owner account
      </button>
    </form>
  );
}

// --- re-authentication prompt (ADR 0029) ------------------------------------

/**
 * One outstanding reauth request at a time, resolved by the modal below.
 * `apiFetch` awaits this to get a password, or `undefined` if the user
 * cancels — in which case the original write is abandoned, not retried.
 */
type ReauthResolver = (password: string | undefined) => void;

function ReauthModal({ onSubmit }: { onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  return (
    <div className="modal-backdrop">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(password);
        }}
      >
        <h2>Confirm your password</h2>
        <p>This action needs a recent password entry.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button type="submit">Confirm</button>
      </form>
    </div>
  );
}

// --- the dashboard itself ----------------------------------------------------

interface HealthInfo {
  gateway: { connected: boolean; pingMs: number | undefined; guildCount: number };
  safety: { killswitch: boolean; dryRun: boolean; breakerOpen: boolean } | undefined;
  jobCounts: Record<string, number>;
  oldestDueJobAtMs: number | undefined;
}

interface LogRoute {
  eventKind: string;
  channelId: string;
  enabled: boolean;
  includeContent: boolean;
}

interface PanelSummary {
  panelId: string;
  kind: string;
  component: string;
  behaviour: string;
  status: string;
  messageId: string | undefined;
  optionCount: number;
}

interface AuditRow {
  auditId: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorUnixUserClaimed: string | null;
  via: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  dryRun: boolean;
}

function Dashboard({ session, onLoggedOut }: { session: SessionInfo; onLoggedOut: () => void }) {
  const [csrfToken] = useState(session.csrfToken);
  const [reauth, setReauth] = useState<ReauthResolver | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

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

  const call = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<T | undefined> => {
      try {
        return await apiFetch<T>(url, csrfToken, requireReauth, init);
      } catch (err) {
        if (err instanceof ReadonlyError) {
          setNotice(err.message);
          return undefined;
        }
        throw err;
      }
    },
    [csrfToken, requireReauth],
  );

  const [health, setHealth] = useState<HealthInfo | undefined>(undefined);
  const [routes, setRoutes] = useState<LogRoute[] | undefined>(undefined);
  const [panels, setPanels] = useState<PanelSummary[] | undefined>(undefined);
  const [audit, setAudit] = useState<AuditRow[] | undefined>(undefined);

  const refresh = useCallback(() => {
    void call<HealthInfo>('/api/health').then(setHealth);
    void call<{ routes: LogRoute[] }>('/api/log-routes').then((r) => setRoutes(r?.routes));
    void call<PanelSummary[]>('/api/panels').then(setPanels);
    void call<AuditRow[]>('/api/audit?limit=50').then(setAudit);
  }, [call]);

  useEffect(refresh, [refresh]);

  const toggleKillswitch = async (on: boolean) => {
    const result = await call<{ ok: boolean; killswitch: boolean }>('/api/killswitch', {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
    if (result !== undefined) refresh();
  };

  const setLogRoute = async (eventKind: string, channelId: string, includeContent: boolean) => {
    const result = await call<{ ok: boolean }>('/api/log-routes', {
      method: 'POST',
      body: JSON.stringify({ eventKind, channelId, includeContent }),
    });
    if (result !== undefined) refresh();
  };

  const logout = async () => {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-bananasaurs-csrf': csrfToken },
    });
    onLoggedOut();
  };

  return (
    <div>
      <header>
        <h1>Bananasaurs</h1>
        <button onClick={() => void logout()}>Sign out</button>
      </header>

      {notice !== undefined && <p className="notice">{notice}</p>}
      {reauth !== undefined && <ReauthModal onSubmit={reauth} />}

      <section className="panel">
        <h2>Health</h2>
        {health === undefined ? (
          <p>Loading…</p>
        ) : (
          <ul>
            <li>Gateway: {health.gateway.connected ? 'connected' : 'disconnected'}</li>
            <li>Dry run: {health.safety?.dryRun ? 'ON' : 'off'}</li>
            <li>Kill switch: {health.safety?.killswitch ? 'ON' : 'off'}</li>
            <li>Circuit breaker: {health.safety?.breakerOpen ? 'OPEN' : 'closed'}</li>
            <li>
              Jobs:{' '}
              {Object.entries(health.jobCounts)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ')}
            </li>
            {health.oldestDueJobAtMs !== undefined && (
              <li>Scheduler lag since {new Date(health.oldestDueJobAtMs).toLocaleString()}</li>
            )}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Kill switch</h2>
        <p>Stops every Discord side effect for this guild. Events are still received and logged.</p>
        <button onClick={() => void toggleKillswitch(true)}>Turn ON</button>
        <button onClick={() => void toggleKillswitch(false)}>Turn OFF (needs re-auth)</button>
      </section>

      <section className="panel">
        <h2>Log routing</h2>
        {routes === undefined ? (
          <p>Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Channel</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.eventKind}>
                  <td>{r.eventKind}</td>
                  <td>{r.channelId}</td>
                  <td>{r.includeContent ? 'included' : 'redacted'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <LogRouteForm
          onSubmit={(eventKind, channelId, includeContent) =>
            void setLogRoute(eventKind, channelId, includeContent)
          }
        />
      </section>

      <section className="panel">
        <h2>Panels</h2>
        <p>Configuration is read-only here — use the operator CLI (`panel show` / `panel sync`).</p>
        {panels === undefined ? (
          <p>Loading…</p>
        ) : (
          <ul>
            {panels.map((p) => (
              <li key={p.panelId}>
                {p.panelId} — {p.kind}/{p.component}/{p.behaviour}, {p.status}, {p.optionCount}{' '}
                option(s)
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Audit</h2>
        {audit === undefined ? (
          <p>Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row) => (
                <tr key={row.auditId}>
                  <td>{new Date(row.at).toLocaleString()}</td>
                  <td>
                    {row.actorType}
                    {row.actorUnixUserClaimed !== null
                      ? ` (${row.actorUnixUserClaimed}, claimed)`
                      : ''}
                  </td>
                  <td>{row.action}</td>
                  <td>
                    {row.subjectType}
                    {row.subjectId !== null ? `:${row.subjectId}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function LogRouteForm({
  onSubmit,
}: {
  onSubmit: (eventKind: string, channelId: string, includeContent: boolean) => void;
}) {
  const [eventKind, setEventKind] = useState('');
  const [channelId, setChannelId] = useState('');
  const [includeContent, setIncludeContent] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(eventKind, channelId, includeContent);
      }}
    >
      <input
        placeholder="event kind"
        value={eventKind}
        onChange={(e) => setEventKind(e.target.value)}
      />
      <input
        placeholder="channel id"
        value={channelId}
        onChange={(e) => setChannelId(e.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={includeContent}
          onChange={(e) => setIncludeContent(e.target.checked)}
        />
        include content
      </label>
      <button type="submit">Set route</button>
    </form>
  );
}

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

  if (phase.kind === 'loading') return <p>Loading…</p>;
  if (phase.kind === 'anon') return <LoginForm onSignedIn={check} />;
  if (phase.kind === 'bootstrap') {
    return <BootstrapForm token={phase.token} onSignedIn={check} />;
  }
  return <Dashboard session={phase.session} onLoggedOut={check} />;
}
