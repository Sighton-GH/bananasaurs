import { useState } from 'react';
import { Button } from '../ui/Button.js';
import { Field, Input } from '../ui/Field.js';

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 w-[22rem] max-w-[calc(100vw-2rem)] rounded-md border border-line bg-panel p-5">
      <h1 className="text-xl">{title}</h1>
      {children}
    </div>
  );
}

export function LoginForm({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [guildId, setGuildId] = useState<string | undefined>(undefined);
  const [choices, setChoices] = useState<readonly { guildId: string; name?: string }[] | undefined>(
    undefined,
  );
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
        body: JSON.stringify(
          guildId === undefined ? { username, password } : { username, password, guildId },
        ),
      });
      if (!response.ok) {
        const body = (await response.json()) as {
          error: string;
          choices?: { guildId: string; name?: string }[];
        };
        // The account reaches more than one guild: the server verified the
        // password first and sent the reachable set, so ask which guild —
        // and re-post the same credentials with the choice.
        if (body.error === 'guild-required' && Array.isArray(body.choices)) {
          setChoices(body.choices);
          setGuildId(body.choices[0]?.guildId);
          setError('This account reaches more than one server. Choose which one to sign in to.');
          return;
        }
        setError(
          body.error === 'locked-out'
            ? 'This account is temporarily locked after too many failed attempts.'
            : body.error === 'read-only'
              ? ((body as { message?: string }).message ?? 'This instance is read-only.')
              : body.error === 'no-guild-access'
                ? 'This account cannot reach any server on this instance.'
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
    <Card title="Bananasaurs">
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3">
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </Field>
        <Field label="Password" {...(error !== undefined ? { error } : {})}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {choices !== undefined && (
          <Field label="Server">
            <select
              value={guildId ?? ''}
              onChange={(e) => setGuildId(e.target.value)}
              className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
            >
              {choices.map((choice) => (
                <option key={choice.guildId} value={choice.guildId}>
                  {choice.name ?? choice.guildId}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Sign in
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function BootstrapForm({
  token,
  onSignedIn,
}: {
  readonly token: string;
  readonly onSignedIn: () => void;
}) {
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
    <Card title="First-run setup">
      <p className="mt-1 text-sm text-ink-muted">Create the owner account. This link works once.</p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3">
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </Field>
        <Field
          label="Password"
          hint="At least 12 characters"
          {...(error !== undefined ? { error } : {})}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Create owner account
          </Button>
        </div>
      </form>
    </Card>
  );
}
