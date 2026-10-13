import { useState } from 'react';
import { ApiError, type ApiErrorBody } from '../api.js';
import { fieldError } from '../api/describe-error.js';
import { Attribution } from '../ui/Attribution.js';
import { Brand } from '../ui/Brand.js';
import { Button } from '../ui/Button.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { Field, Input } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <main className="login-backdrop relative grid min-h-screen place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[25rem]">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <div className="rounded-panel border border-line bg-panel/95 p-6 shadow-2xl shadow-black/20">
          <h1 className="text-title font-semibold">{title}</h1>
          {children}
        </div>
        <Attribution className="mt-5 text-center text-caption text-ink-muted" />
      </div>
    </main>
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
            <Select
              value={guildId}
              onValueChange={setGuildId}
              options={choices.map((choice) => ({
                value: choice.guildId,
                label: choice.name ?? choice.guildId,
              }))}
            />
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
  const [error, setError] = useState<unknown>(undefined);
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
        // The server answers `{ error, title, message, hint, fields?,
        // requestId }` (0078): keep the whole answer so the notice below
        // renders its title, hint and request id, and each field its
        // problem — never the bare code.
        const body = (await response.json()) as ApiErrorBody;
        setError(new ApiError(response.status, body));
        return;
      }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  const usernameProblem = fieldError(error, 'username');
  const passwordProblem = fieldError(error, 'password');

  return (
    <Card title="First-run setup">
      <p className="mt-1 text-small text-ink-muted">
        Create the owner account. This link works once.
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3">
        <Field
          label="Username"
          {...(usernameProblem === undefined ? {} : { error: usernameProblem })}
        >
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
          {...(passwordProblem === undefined ? {} : { error: passwordProblem })}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {error !== undefined && <ErrorNotice error={error} />}
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Create owner account
          </Button>
        </div>
      </form>
    </Card>
  );
}
