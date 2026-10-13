import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ACCOUNT_ROLES,
  CAPABILITY_INFO,
  type AccountRoleId,
  type Capability,
} from '@bananasaurs/core';
import { type AccountCreateResult } from '../api/ops.js';
import { fieldError } from '../api/describe-error.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RadioGroup } from '../ui/RadioGroup.js';
import { PrintOnceDialog } from '../ui/PrintOnceDialog.js';
import { RoleCards } from '../ui/RoleCards.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

const presetCapabilities = (role: AccountRoleId): readonly Capability[] =>
  role === 'custom' ? [] : (ACCOUNT_ROLES.find((r) => r.id === role)?.capabilities ?? []);

const summaryFor = (caps: readonly Capability[]): string =>
  caps.length === 0
    ? 'change nothing'
    : caps.map((capability) => CAPABILITY_INFO[capability]?.label ?? capability).join(', ');

/**
 * `/accounts/new`: one page that names the account, picks how its password is
 * set, gives it one role card, and reviews the result in plain words before
 * anything is written (ADR 0069). Access to this server is always granted on
 * creation — there is no opt-out checkbox. The generated password crosses the
 * screen exactly once, in the PrintOnceDialog, which then opens the edit page.
 */
export function AccountNewPage() {
  const session = useSession();
  const [, navigate] = useLocation();
  const guildName = session.info.guildName ?? 'this server';

  const [username, setUsername] = useState('');
  const [passwordChoice, setPasswordChoice] = useState<'generate' | 'choose'>('generate');
  const [chosenPassword, setChosenPassword] = useState('');
  const [role, setRole] = useState<AccountRoleId>('viewer');
  const [customCaps, setCustomCaps] = useState<readonly Capability[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AccountCreateResult | undefined>(undefined);

  const selected: readonly Capability[] = role === 'custom' ? customCaps : presetCapabilities(role);
  const usernameOk = USERNAME_PATTERN.test(username);
  const usernameError =
    username === '' || usernameOk
      ? undefined
      : 'Use 3–64 characters: lowercase letters, digits, dot, dash, underscore.';
  const passwordError =
    passwordChoice === 'generate' || chosenPassword === '' || chosenPassword.length >= 12
      ? undefined
      : 'Use at least 12 characters.';
  const passwordOk = passwordChoice === 'generate' || chosenPassword.length >= 12;
  const canCreate = usernameOk && passwordOk && !busy;

  const review =
    username.trim() === ''
      ? undefined
      : `${username} will be able to sign in and ${summaryFor(selected)} on ${guildName}.`;
  // Client-side validation wins; the server's field problem shows once the
  // shape is right but the value is refused.
  const usernameProblem = usernameError ?? fieldError(error, 'username');
  const passwordProblem = passwordError ?? fieldError(error, 'password');

  const create = async (): Promise<void> => {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      const body: { username: string; capabilities: readonly string[]; password?: string } = {
        username,
        capabilities: [...selected],
      };
      if (passwordChoice === 'choose') body.password = chosenPassword;
      const result = await session.writeOrThrow<AccountCreateResult>('/api/accounts', body);
      if (result !== undefined) {
        // No toast: the plaintext lives in the PrintOnceDialog only.
        setCreated(result);
      }
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer with its field
      // problems rather than translating the refusal here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Add account"
        purpose={`Give someone their own sign-in for ${guildName}, with exactly the permissions they need.`}
        actions={
          <Link
            href="/accounts"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-panel px-2.5 py-1 text-small text-ink hover:border-ink-muted"
          >
            Back to accounts
          </Link>
        }
      />
      <div className="grid max-w-2xl gap-4">
        <Card title="Name">
          <Field
            label="Username"
            hint="Lowercase letters, digits, dot, dash, underscore; 3-64 characters, never a leading dash."
            {...(usernameProblem === undefined ? {} : { error: usernameProblem })}
          >
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. sam"
              autoComplete="off"
            />
          </Field>
        </Card>
        <Card title="Password">
          <RadioGroup
            legend="How the password is set"
            name="password-choice"
            value={passwordChoice}
            onChange={(next) => setPasswordChoice(next === 'choose' ? 'choose' : 'generate')}
            options={[
              { value: 'generate', label: 'Generate one for me' },
              { value: 'choose', label: "I'll choose one" },
            ]}
          />
          {passwordChoice === 'choose' && (
            <div className="mt-3">
              <Field
                label="New password"
                hint="At least 12 characters."
                {...(passwordProblem === undefined ? {} : { error: passwordProblem })}
              >
                <Input
                  type="password"
                  value={chosenPassword}
                  onChange={(e) => setChosenPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
          )}
        </Card>
        <Card title="Role on this server">
          <RoleCards
            value={role}
            capabilities={selected}
            onChange={(nextRole, nextCaps) => {
              setRole(nextRole);
              if (nextRole === 'custom') setCustomCaps(nextCaps);
            }}
          />
        </Card>
        <Card title="Review">
          {review === undefined ? (
            <p className="text-small text-ink-muted">
              Name the account above to review what it will be able to do.
            </p>
          ) : (
            <p className="text-body">{review}</p>
          )}
          {error !== undefined && (
            <div className="mt-2">
              <ErrorNotice error={error} />
            </div>
          )}
          <div className="mt-3">
            <Button
              variant="primary"
              busy={busy}
              disabled={!canCreate}
              onClick={() => void create()}
            >
              Create account
            </Button>
          </div>
        </Card>
      </div>
      <PrintOnceDialog
        open={created !== undefined}
        title="Account created"
        secretLabel={created === undefined ? '' : `Generated password for ${created.username}`}
        secret={created?.password}
        onDone={() => {
          const name = created?.username;
          setCreated(undefined);
          if (name !== undefined) navigate(`/accounts/${name}`);
        }}
      />
    </>
  );
}
