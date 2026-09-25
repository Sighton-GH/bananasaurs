import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ACCOUNT_ROLES,
  CAPABILITY_INFO,
  type AccountRoleId,
  type Capability,
} from '@bananasaurs/core';
import { accountWriteErrorText, type AccountCreateResult } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
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
  const [error, setError] = useState<string | undefined>(undefined);
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
      setError(accountWriteErrorText(err, 'The server could not create this account.'));
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
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-panel px-2.5 py-1 text-sm text-ink hover:border-ink-muted"
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
            {...(usernameError === undefined ? {} : { error: usernameError })}
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
          <div role="radiogroup" aria-label="Password" className="grid gap-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="password-choice"
                checked={passwordChoice === 'generate'}
                onChange={() => setPasswordChoice('generate')}
              />
              Generate one for me
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="password-choice"
                checked={passwordChoice === 'choose'}
                onChange={() => setPasswordChoice('choose')}
              />
              I&apos;ll choose one
            </label>
          </div>
          {passwordChoice === 'choose' && (
            <div className="mt-3">
              <Field
                label="New password"
                hint="At least 12 characters."
                {...(passwordError === undefined ? {} : { error: passwordError })}
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
            <p className="text-sm text-ink-muted">
              Name the account above to review what it will be able to do.
            </p>
          ) : (
            <p className="text-sm">{review}</p>
          )}
          {error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
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
