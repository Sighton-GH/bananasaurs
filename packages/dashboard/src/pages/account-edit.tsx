import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  ACCOUNT_ROLES,
  roleForCapabilities,
  type AccountRoleId,
  type Capability,
} from '@bananasaurs/core';
import { ApiError } from '../api.js';
import {
  accountErrorText,
  type Account,
  type AccountDeleteResult,
  type AccountDisableResult,
  type AccountGuildOutcome,
  type AccountRevealResult,
  type AccountRevokeResult,
  type AccountsResponse,
  type AccountSetPasswordResult,
} from '../api/ops.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { PrintOnceDialog } from '../ui/PrintOnceDialog.js';
import { RoleCards } from '../ui/RoleCards.js';
import { useToast } from '../ui/Toast.js';
import { OWNER_SENTENCE } from './accounts.js';

const roleLabel = (caps: readonly Capability[]): string => {
  const role = roleForCapabilities(caps);
  if (role === 'custom') return 'Custom';
  return ACCOUNT_ROLES.find((r) => r.id === role)?.label ?? role;
};

const refusalText = (err: unknown): string => {
  if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
    const code = (err.body as { error?: string }).error ?? '';
    return accountErrorText(code) ?? 'The server refused this change.';
  }
  return err instanceof Error ? err.message : String(err);
};

function SummaryCard({ account, caps }: { readonly account: Account; readonly caps: readonly Capability[] }) {
  return (
    <Card title="Summary">
      <dl className="grid max-w-lg gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-muted">Username</dt>
        <dd>{account.username}</dd>
        <dt className="text-ink-muted">Role</dt>
        <dd>
          {account.isOwner ? (
            <span className="grid gap-1">
              <span>
                <Badge tone="neutral">Owner</Badge>
              </span>
              <span className="text-xs text-ink-muted">{OWNER_SENTENCE}</span>
            </span>
          ) : (
            roleLabel(caps)
          )}
        </dd>
        <dt className="text-ink-muted">Status</dt>
        <dd>{account.disabled ? 'Disabled' : 'Enabled'}</dd>
        <dt className="text-ink-muted">Created</dt>
        <dd>{new Date(account.createdAt).toLocaleString()}</dd>
      </dl>
    </Card>
  );
}

function PermissionsSection({
  session,
  username,
  held,
  onSaved,
}: {
  readonly session: Session;
  readonly username: string;
  readonly held: readonly Capability[];
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [role, setRole] = useState<AccountRoleId>(() => roleForCapabilities(held));
  const [customCaps, setCustomCaps] = useState<readonly Capability[]>(held);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const selected: readonly Capability[] =
    role === 'custom' ? customCaps : (ACCOUNT_ROLES.find((r) => r.id === role)?.capabilities ?? []);
  const grants = selected.filter((c) => !held.includes(c));
  const revokes = held.filter((c) => !selected.includes(c));
  const unchanged = grants.length === 0 && revokes.length === 0;

  const save = async (): Promise<void> => {
    if (unchanged || busy) return;
    setBusy(true);
    setError(undefined);
    const name = encodeURIComponent(username);
    try {
      for (const capability of grants) {
        const result = await session.writeOrThrow<{ outcome: string }>(
          `/api/accounts/${name}/capabilities`,
          { capability },
        );
        if (result === undefined) return;
      }
      for (const capability of revokes) {
        const result = await session.writeOrThrow<{ outcome: string }>(
          `/api/accounts/${name}/capabilities/${capability}`,
          undefined,
          'DELETE',
        );
        if (result === undefined) return;
      }
      toast({
        tone: 'ok',
        title: `Permissions saved for ${username}`,
        ...(grants.length === 0 && revokes.length === 0
          ? {}
          : {
              message: `Granted ${String(grants.length)}, revoked ${String(revokes.length)}.`,
            }),
      });
      onSaved();
    } catch (err) {
      setError(refusalText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Permissions on this server">
      <RoleCards
        value={role}
        capabilities={selected}
        onChange={(nextRole, nextCaps) => {
          setRole(nextRole);
          if (nextRole === 'custom') setCustomCaps(nextCaps);
        }}
      />
      {error !== undefined && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3">
        <Button variant="primary" busy={busy} disabled={unchanged} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}

function SetPasswordForm({
  session,
  username,
  onPasswordSet,
}: {
  readonly session: Session;
  readonly username: string;
  /** Runs when the new-password dialog is dismissed, so a reload cannot unmount the only copy. */
  readonly onPasswordSet: () => void;
}) {
  const [choice, setChoice] = useState<'generate' | 'choose'>('generate');
  const [chosen, setChosen] = useState('');
  const [reset, setReset] = useState<AccountSetPasswordResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const ok = choice === 'generate' || chosen.length >= 12;
  const fieldError =
    choice === 'generate' || chosen === '' || chosen.length >= 12
      ? undefined
      : 'Use at least 12 characters.';

  const submit = async (): Promise<void> => {
    if (!ok || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await session.writeOrThrow<AccountSetPasswordResult>(
        `/api/accounts/${encodeURIComponent(username)}/password`,
        choice === 'generate' ? {} : { password: chosen },
        'PUT',
      );
      if (result !== undefined) {
        // No toast: the plaintext lives in the PrintOnceDialog only.
        setReset(result);
      }
    } catch (err) {
      setError(refusalText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-sm font-medium">Set a new password</p>
      <div role="radiogroup" aria-label="New password source" className="mt-1 grid gap-2">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`password-choice-${username}`}
            checked={choice === 'generate'}
            onChange={() => setChoice('generate')}
          />
          Generate one for me
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`password-choice-${username}`}
            checked={choice === 'choose'}
            onChange={() => setChoice('choose')}
          />
          I&apos;ll choose one
        </label>
      </div>
      {choice === 'choose' && (
        <div className="mt-3 max-w-md">
          <Field
            label="New password"
            hint="At least 12 characters."
            {...(fieldError === undefined ? {} : { error: fieldError })}
          >
            <Input
              type="password"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3">
        <Button variant="primary" busy={busy} disabled={!ok} onClick={() => void submit()}>
          Set new password
        </Button>
      </div>
      <PrintOnceDialog
        open={reset !== undefined}
        title="New password"
        secretLabel={reset === undefined ? '' : `New password for ${reset.username}`}
        secret={reset?.password}
        onDone={() => {
          setReset(undefined);
          onPasswordSet();
        }}
      />
    </div>
  );
}

function PasswordSection({
  session,
  username,
  canReveal,
  revealable,
  onChanged,
}: {
  readonly session: Session;
  readonly username: string;
  readonly canReveal: boolean;
  readonly revealable: boolean;
  readonly onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState<AccountRevealResult | undefined>(undefined);
  const [revealError, setRevealError] = useState<string | undefined>(undefined);
  const [revealBusy, setRevealBusy] = useState(false);

  const reveal = async (): Promise<void> => {
    if (revealBusy) return;
    setRevealBusy(true);
    setRevealError(undefined);
    try {
      const result = await session.writeOrThrow<AccountRevealResult>(
        `/api/accounts/${encodeURIComponent(username)}/reveal-password`,
        {},
      );
      if (result !== undefined) setRevealed(result);
    } catch (err) {
      setRevealError(refusalText(err));
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <Card title="Password">
      {canReveal &&
        (revealable ? (
          <div>
            <Button busy={revealBusy} onClick={() => void reveal()}>
              Reveal current password
            </Button>
            {revealError !== undefined && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {revealError}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            Set a new password to be able to reveal it later.
          </p>
        ))}
      <SetPasswordForm session={session} username={username} onPasswordSet={onChanged} />
      <PrintOnceDialog
        open={revealed !== undefined}
        title="Current password"
        secretLabel={revealed === undefined ? '' : `Current password for ${revealed.username}`}
        secret={revealed?.password}
        onDone={() => setRevealed(undefined)}
      />
    </Card>
  );
}

function SessionsSection({
  session,
  username,
  onChanged,
}: {
  readonly session: Session;
  readonly username: string;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const signOutEverywhere = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await session.write<AccountRevokeResult>(
        `/api/accounts/${encodeURIComponent(username)}/revoke-credentials`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Signed out everywhere for ${result.username}`,
          message: `${String(result.sessionsRevoked)} sessions and ${String(result.tokensRevoked)} connected apps ended.`,
        });
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Sessions and apps">
      <p className="max-w-lg text-sm text-ink-muted">
        Ends every dashboard session and disconnects every connected app for {username}. The
        password keeps working — disable the account to stop sign-in.
      </p>
      <div className="mt-3">
        <Button busy={busy} onClick={() => void signOutEverywhere()}>
          Sign out everywhere and disconnect apps
        </Button>
      </div>
    </Card>
  );
}

function DangerSection({
  session,
  account,
  onChanged,
  onDeleted,
}: {
  readonly session: Session;
  readonly account: Account;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<'disable' | 'revoke-guild' | 'delete' | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (pending === undefined || busy) return;
    setBusy(true);
    const kind = pending;
    const name = encodeURIComponent(account.username);
    try {
      if (kind === 'disable') {
        const result = await session.write<AccountDisableResult>(
          `/api/accounts/${name}/disabled`,
          { disabled: !account.disabled },
        );
        if (result !== undefined) {
          toast({
            tone: 'ok',
            title: `${result.username} ${result.disabled ? 'disabled' : 'enabled'}`,
          });
          onChanged();
        }
      } else if (kind === 'revoke-guild') {
        const result = await session.write<{ outcome: AccountGuildOutcome }>(
          `/api/accounts/${name}/revoke-guild`,
          {},
        );
        if (result !== undefined) {
          toast({ tone: 'ok', title: `${account.username} removed from this server` });
          onChanged();
        }
      } else {
        const result = await session.write<AccountDeleteResult>(
          `/api/accounts/${name}`,
          undefined,
          'DELETE',
        );
        if (result !== undefined) {
          toast({ tone: 'ok', title: `${result.username} deleted` });
          onDeleted();
          return;
        }
      }
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  };

  const scopeText =
    pending === 'disable'
      ? account.disabled
        ? `${account.username} can sign in again.`
        : `Every dashboard session for ${account.username} stops verifying while the account stays disabled — a pause, not a rotation.`
      : pending === 'revoke-guild'
        ? `Removes ${account.username} from this server; its permissions here go with it.`
        : pending === 'delete'
          ? `Deletes ${account.username} and revokes its connected apps. Not reversible.`
          : '';

  return (
    <Card title="Danger zone">
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={() => setPending('disable')}>
          {account.disabled ? 'Enable' : 'Disable'}
        </Button>
        <Button variant="danger" onClick={() => setPending('revoke-guild')}>
          Remove from this server
        </Button>
        <Button variant="danger" onClick={() => setPending('delete')}>
          Delete
        </Button>
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={
          pending === 'disable'
            ? `${account.disabled ? 'Enable' : 'Disable'} ${account.username}?`
            : pending === 'revoke-guild'
              ? `Remove ${account.username} from this server?`
              : pending === 'delete'
                ? `Delete ${account.username}?`
                : ''
        }
        scope={<p>{scopeText}</p>}
        confirmLabel={
          pending === 'disable'
            ? `${account.disabled ? 'Enable' : 'Disable'} account`
            : pending === 'revoke-guild'
              ? 'Remove from this server'
              : 'Delete account'
        }
        danger
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(undefined)}
      />
    </Card>
  );
}

/**
 * `/accounts/:username`: one account and everything the owner may change about
 * it (ADR 0069). Sections run Summary, Permissions on this server, Password,
 * Sessions and apps, Danger zone. Permission saves only send the difference —
 * one grant or revoke call per changed permission. An owner account shows
 * only its Summary (plus changing its own password when it is yours):
 * nothing else on this page may touch it.
 */
export function AccountEditPage() {
  const { username } = useParams<{ username: string }>();
  const session = useSession();
  const [, navigate] = useLocation();
  const load = useCallback(() => session.read<AccountsResponse>('/api/accounts'), [session]);
  const accounts = useResource('the accounts', load);

  return (
    <>
      <PageHeader
        title={username === undefined ? 'Account' : `Account ${username}`}
        purpose="What this account may do on this server, and how to change it."
        actions={
          <Link
            href="/accounts"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-panel px-2.5 py-1 text-sm text-ink hover:border-ink-muted"
          >
            Back to accounts
          </Link>
        }
      />
      <DataState resource={accounts.resource}>
        {(r) => {
          const account = r.accounts.find((a) => a.username === username);
          if (account === undefined) {
            return (
              <p className="text-sm text-ink-muted">
                No such account. It may have been deleted —{' '}
                <Link href="/accounts" className="underline">
                  back to accounts
                </Link>
                .
              </p>
            );
          }
          const caps = (r.capabilities[account.accountId] ?? []) as readonly Capability[];
          // Ruling: SessionInfo carries no owner flag — the viewer is the
          // owner exactly when their own row says so.
          const isViewerOwner =
            r.accounts.find((a) => a.accountId === session.info.accountId)?.isOwner === true;
          const isOwnAccount = account.accountId === session.info.accountId;
          if (account.isOwner) {
            return (
              <div className="grid max-w-2xl gap-4">
                <SummaryCard account={account} caps={caps} />
                {isOwnAccount && (
                  <Card title="Change your password">
                    <SetPasswordForm
                      session={session}
                      username={account.username}
                      onPasswordSet={accounts.reload}
                    />
                  </Card>
                )}
              </div>
            );
          }
          return (
            <div className="grid max-w-2xl gap-4">
              <SummaryCard account={account} caps={caps} />
              <PermissionsSection
                key={account.username}
                session={session}
                username={account.username}
                held={caps}
                onSaved={accounts.reload}
              />
              <PasswordSection
                session={session}
                username={account.username}
                canReveal={isViewerOwner}
                revealable={account.revealable}
                onChanged={accounts.reload}
              />
              <SessionsSection
                session={session}
                username={account.username}
                onChanged={accounts.reload}
              />
              <DangerSection
                session={session}
                account={account}
                onChanged={accounts.reload}
                onDeleted={() => navigate('/accounts')}
              />
            </div>
          );
        }}
      </DataState>
    </>
  );
}

