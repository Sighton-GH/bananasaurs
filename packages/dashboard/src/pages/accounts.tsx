import { useCallback, useState } from 'react';
import { CAPABILITIES } from '@bananasaurs/core';
import type {
  Account,
  AccountCreateResult,
  AccountCapabilityOutcome,
  AccountDeleteResult,
  AccountsResponse,
  AccountDisableResult,
  AccountGuildOutcome,
  AccountRevokeResult,
  AccountSetPasswordResult,
} from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { PrintOnceDialog } from '../ui/PrintOnceDialog.js';
import { useToast } from '../ui/Toast.js';

type PendingAction =
  | { readonly kind: 'disable' | 'enable'; readonly account: Account }
  | { readonly kind: 'set-password'; readonly account: Account }
  | { readonly kind: 'revoke-credentials'; readonly account: Account }
  | { readonly kind: 'grant-guild' | 'revoke-guild'; readonly account: Account }
  | { readonly kind: 'grant-capability'; readonly account: Account; readonly capability: string }
  | { readonly kind: 'delete'; readonly account: Account };

const ACTION_TEXT: Record<
  PendingAction['kind'],
  { readonly title: (a: Account) => string; readonly confirm: string; readonly danger: boolean }
> = {
  'grant-capability': {
    title: (a) => `Grant ${a.username} a capability?`,
    confirm: 'Grant capability',
    danger: false,
  },
  disable: {
    title: (a) => `Disable ${a.username}?`,
    confirm: 'Disable account',
    danger: true,
  },
  enable: {
    title: (a) => `Enable ${a.username}?`,
    confirm: 'Enable account',
    danger: false,
  },
  'set-password': {
    title: (a) => `Reset the password for ${a.username}?`,
    confirm: 'Reset password',
    danger: true,
  },
  'revoke-credentials': {
    title: (a) => `Revoke every credential of ${a.username}?`,
    confirm: 'Revoke credentials',
    danger: true,
  },
  'grant-guild': {
    title: (a) => `Grant ${a.username} this guild?`,
    confirm: 'Grant this guild',
    danger: false,
  },
  'revoke-guild': {
    title: (a) => `Revoke ${a.username} from this guild?`,
    confirm: 'Revoke this guild',
    danger: true,
  },
  delete: {
    title: (a) => `Delete ${a.username}?`,
    confirm: 'Delete account',
    danger: true,
  },
};

const GUILD_OUTCOME_TEXT: Record<AccountGuildOutcome, string> = {
  granted: 'access granted',
  'already-had-it': 'the account already had this guild',
  revoked: 'access revoked',
  'did-not-have-it': 'the account did not have this guild',
};

/**
 * `/accounts`: the `account` family as a page (docs/17, ADR 0051 D3) —
 * list, disable/enable, revoke-credentials, set-password, grant/revoke this
 * guild, and delete. The scopes the CLI prints are stated verbatim in the
 * confirmations: disable is a pause (every session and token stops verifying
 * while it lasts), revoke-credentials is the rotation, delete is not
 * reversible. The generated password crosses the screen exactly once, in the
 * PrintOnceDialog.
 */
export function AccountsPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<AccountsResponse>('/api/accounts'), [session]);
  const accounts = useResource('the accounts', load);

  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [newPassword, setNewPassword] = useState<AccountSetPasswordResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // --- create ---------------------------------------------------------------
  // The draft is the reviewable scope: username, whether the account reaches
  // this guild, and exactly which capabilities inside it. Nothing is written
  // until the confirmation quotes that scope back.
  const [draftName, setDraftName] = useState('');
  const [draftGuild, setDraftGuild] = useState(false);
  const [draftCaps, setDraftCaps] = useState<readonly string[]>([]);
  const [createReview, setCreateReview] = useState<
    | {
        readonly username: string;
        readonly grantThisGuild: boolean;
        readonly capabilities: readonly string[];
      }
    | undefined
  >(undefined);
  const [createBusy, setCreateBusy] = useState(false);
  const [created, setCreated] = useState<AccountCreateResult | undefined>(undefined);

  const draftNameOk = /^[a-z0-9][a-z0-9._-]{2,63}$/.test(draftName);

  const draftScope = (
    username: string,
    grantThisGuild: boolean,
    capabilities: readonly string[],
  ): string => {
    const access = grantThisGuild
      ? `access to guild ${session.info.guildId}${
          capabilities.length > 0
            ? ` with the capabilities ${capabilities.join(', ')}`
            : ' and no capabilities yet'
        }`
      : 'no guild access and no capabilities — it reaches nothing until you grant both below';
    return `Creates ${username} as a non-owner account with ${access}. The generated password shows exactly once; every grant is recorded in the audit trail, and the table below edits all of it afterwards.`;
  };

  const create = async (): Promise<void> => {
    if (createReview === undefined) return;
    setCreateBusy(true);
    try {
      const result = await session.write<AccountCreateResult>('/api/accounts', {
        username: createReview.username,
        grantThisGuild: createReview.grantThisGuild,
        capabilities: [...createReview.capabilities],
      });
      if (result !== undefined) {
        // No toast: the plaintext lives in the PrintOnceDialog only.
        setCreated(result);
        setDraftName('');
        setDraftGuild(false);
        setDraftCaps([]);
      }
    } finally {
      setCreateBusy(false);
      setCreateReview(undefined);
    }
  };

  const run = async () => {
    if (pending === undefined) return;
    setBusy(true);
    const { account } = pending;
    const name = encodeURIComponent(account.username);
    try {
      switch (pending.kind) {
        case 'disable':
        case 'enable': {
          const disabled = pending.kind === 'disable';
          const result = await session.write<AccountDisableResult>(
            `/api/accounts/${name}/disabled`,
            { disabled },
          );
          if (result !== undefined) {
            if (!result.changed) {
              toast({
                tone: 'neutral',
                title: `${result.username} was already ${disabled ? 'disabled' : 'enabled'}`,
              });
            } else if (result.disabled && result.enabledOwnersRemaining === 0) {
              toast({
                tone: 'danger',
                title: `${result.username} disabled — no enabled owners remain`,
                message: 'Recovery is delete plus bootstrap reissue, from the host.',
              });
            } else {
              toast({
                tone: 'ok',
                title: `${result.username} ${result.disabled ? 'disabled' : 'enabled'}`,
                message: result.disabled
                  ? 'Every session and OAuth token stops verifying while it stays disabled.'
                  : 'Every credential it held verifies again, intact.',
              });
            }
            accounts.reload();
          }
          break;
        }
        case 'set-password': {
          const result = await session.write<AccountSetPasswordResult>(
            `/api/accounts/${name}/password`,
            { confirm: true },
          );
          if (result !== undefined) {
            // No toast: the plaintext lives in the PrintOnceDialog only.
            setNewPassword(result);
          }
          break;
        }
        case 'revoke-credentials': {
          const result = await session.write<AccountRevokeResult>(
            `/api/accounts/${name}/revoke-credentials`,
            {},
          );
          if (result !== undefined) {
            toast({
              tone: 'ok',
              title: `Credentials revoked for ${result.username}`,
              message: `${String(result.sessionsRevoked)} sessions, ${String(result.tokensRevoked)} tokens and ${String(result.codesDeleted)} authorization codes ended across ${String(result.guildsTouched)} guilds. The password still works — disable the account to stop sign-in.`,
            });
            accounts.reload();
          }
          break;
        }
        case 'grant-guild':
        case 'revoke-guild': {
          const result = await session.write<{ outcome: AccountGuildOutcome }>(
            `/api/accounts/${name}/${pending.kind}`,
            {},
          );
          if (result !== undefined) {
            toast({
              tone: result.outcome === 'granted' || result.outcome === 'revoked' ? 'ok' : 'neutral',
              title: `${account.username}: ${GUILD_OUTCOME_TEXT[result.outcome]}`,
            });
            accounts.reload();
          }
          break;
        }
        case 'grant-capability': {
          const result = await session.write<{ outcome: AccountCapabilityOutcome }>(
            `/api/accounts/${name}/capabilities`,
            { capability: pending.capability },
          );
          if (result !== undefined) {
            toast({
              tone: result.outcome === 'granted' ? 'ok' : 'neutral',
              title:
                result.outcome === 'granted'
                  ? `Granted ${pending.capability} to ${account.username} in this guild`
                  : `${account.username} already holds ${pending.capability} here`,
            });
            accounts.reload();
          }
          break;
        }
        case 'delete': {
          const result = await session.write<AccountDeleteResult>(
            `/api/accounts/${name}`,
            undefined,
            'DELETE',
          );
          if (result !== undefined) {
            if (result.enabledOwnersRemaining === 0) {
              toast({
                tone: 'danger',
                title: `${result.username} deleted — no enabled owners remain`,
                message: `${String(result.accountsRemaining)} account rows left. Bootstrap reissue refuses while any row exists.`,
              });
            } else {
              toast({
                tone: 'ok',
                title: `${result.username} deleted`,
                message: `${String(result.tokensRevoked)} OAuth tokens revoked with it.`,
              });
            }
            accounts.reload();
          }
          break;
        }
      }
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  };

  const scopeFor = (action: PendingAction): string => {
    const { account } = action;
    switch (action.kind) {
      case 'disable':
        return `Every dashboard session and every OAuth token ${account.username} approved stops verifying for as long as the account stays disabled — a pause, not a rotation. Re-enabling hands every credential back intact.`;
      case 'enable':
        return `${account.username} can sign in again, and every session and token it approved verifies again, intact.`;
      case 'set-password':
        return `Generates a replacement password, shown exactly once, and revokes ${account.username}'s dashboard sessions in every guild. OAuth tokens are NOT revoked — revoke credentials separately if the password may have leaked.`;
      case 'revoke-credentials':
        return `Ends every live dashboard session and every live OAuth token, and deletes every unexchanged authorization code, for ${account.username} — without disabling it. The account keeps its password and can sign in again for new ones.`;
      case 'grant-guild':
        return `Gives ${account.username} access to guild ${session.info.guildId}. The account still chooses the guild at sign-in.`;
      case 'revoke-guild':
        return `Revokes ${account.username}'s access to guild ${session.info.guildId}; its capabilities here cascade away.${
          account.accountId === session.info.accountId
            ? ' This is your own account — revoking signs you out with no way back in. Recovery is delete plus re-bootstrap.'
            : ''
        }`;
      case 'grant-capability':
        return `Gives ${account.username} the ${action.capability} capability in guild ${session.info.guildId} — the web half of \`bananasaurs account grant\`. Recorded in the audit trail either way; a capability it already holds changes nothing.`;
      case 'delete':
        return `Deletes ${account.username} AND revokes its OAuth tokens in one transaction; guild access, capabilities and dashboard sessions cascade. Not reversible.${
          account.isOwner ? ' It is an owner account.' : ''
        }`;
    }
  };

  return (
    <>
      <PageHeader
        title="Accounts"
        purpose="Every dashboard account: owner, enabled or disabled, lockouts — and the levers over its sessions, tokens and guild access."
      />
      <Card title="Create an account">
        <form
          className="mt-2 grid max-w-lg gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draftNameOk) return;
            setCreateReview({
              username: draftName,
              grantThisGuild: draftGuild,
              capabilities: draftGuild ? draftCaps : [],
            });
          }}
        >
          <Field
            label="Username"
            hint="Lowercase letters, digits, dot, dash, underscore; 3-64 characters, never a leading dash."
          >
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="e.g. mod-casey"
              autoComplete="off"
            />
          </Field>
          <Checkbox
            label={`Give the account access to this guild (${session.info.guildId})`}
            checked={draftGuild}
            onChange={(e) => {
              setDraftGuild(e.target.checked);
              if (!e.target.checked) setDraftCaps([]);
            }}
          />
          {draftGuild && (
            <fieldset className="grid gap-1 rounded-sm border border-line p-2">
              <legend className="px-1 text-xs text-ink-muted">
                Capabilities in this guild — none is the safe start
              </legend>
              {CAPABILITIES.map((capability) => (
                <Checkbox
                  key={capability}
                  label={capability}
                  checked={draftCaps.includes(capability)}
                  onChange={(e) =>
                    setDraftCaps(
                      e.target.checked
                        ? [...draftCaps, capability]
                        : draftCaps.filter((c) => c !== capability),
                    )
                  }
                />
              ))}
            </fieldset>
          )}
          {draftNameOk && (
            <p className="text-xs text-ink-muted">
              {draftScope(draftName, draftGuild, draftGuild ? draftCaps : [])}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={!draftNameOk}>
              Review and create
            </Button>
          </div>
        </form>
      </Card>
      <DataState
        resource={accounts.resource}
        isEmpty={(r) => r.accounts.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No accounts. The setup page re-arms with bootstrap reissue from the host.
          </p>
        }
      >
        {(r) => (
          <DataTable
            caption="Dashboard accounts"
            rows={r.accounts}
            rowKey={(a) => a.accountId}
            columns={[
              { key: 'username', header: 'Username', cell: (a) => a.username },
              {
                key: 'role',
                header: 'Role',
                cell: (a) =>
                  a.isOwner ? <Badge tone="neutral">owner</Badge> : <span>member</span>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (a) => (
                  <span className="flex gap-1 whitespace-nowrap">
                    {a.disabled ? <Badge tone="danger">disabled</Badge> : 'enabled'}
                    {a.lockedUntil !== null && a.lockedUntil > Date.now() && (
                      <Badge tone="hold">
                        locked until {new Date(a.lockedUntil).toLocaleString()}
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                key: 'capabilities',
                header: 'Capabilities in this guild',
                cell: (a) => {
                  const held = r.capabilities[a.accountId] ?? [];
                  const remaining = CAPABILITIES.filter(
                    (c) => !held.includes(c),
                  ) as readonly string[];
                  return (
                    <span className="flex flex-wrap items-center gap-1">
                      {a.isOwner ? (
                        <Badge tone="neutral">every capability (owner)</Badge>
                      ) : held.length === 0 ? (
                        <span className="text-ink-muted">none</span>
                      ) : (
                        held.map((c) => (
                          <Badge key={c} tone="neutral">
                            {c}
                          </Badge>
                        ))
                      )}
                      {!a.isOwner && remaining.length > 0 && (
                        <select
                          aria-label={`Grant a capability to ${a.username}`}
                          className="rounded-sm border border-line bg-panel px-1 py-0.5 text-xs text-ink"
                          value=""
                          onChange={(event) => {
                            const capability = event.target.value;
                            if (capability !== '') {
                              setPending({ kind: 'grant-capability', account: a, capability });
                            }
                          }}
                        >
                          <option value="">grant…</option>
                          {remaining.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                    </span>
                  );
                },
              },
              {
                key: 'created',
                header: 'Created',
                cell: (a) => new Date(a.createdAt).toLocaleDateString(),
              },
              {
                key: 'actions',
                header: '',
                cell: (a) => (
                  <span className="flex flex-wrap gap-1">
                    <Button
                      onClick={() =>
                        setPending({ kind: a.disabled ? 'enable' : 'disable', account: a })
                      }
                    >
                      {a.disabled ? 'Enable' : 'Disable'}
                    </Button>
                    <Button onClick={() => setPending({ kind: 'set-password', account: a })}>
                      Reset password
                    </Button>
                    <Button onClick={() => setPending({ kind: 'revoke-credentials', account: a })}>
                      Revoke credentials
                    </Button>
                    <Button onClick={() => setPending({ kind: 'grant-guild', account: a })}>
                      Grant guild
                    </Button>
                    <Button onClick={() => setPending({ kind: 'revoke-guild', account: a })}>
                      Revoke guild
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => setPending({ kind: 'delete', account: a })}
                    >
                      Delete
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </DataState>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending === undefined ? '' : ACTION_TEXT[pending.kind].title(pending.account)}
        scope={<p>{pending === undefined ? '' : scopeFor(pending)}</p>}
        confirmLabel={pending === undefined ? '' : ACTION_TEXT[pending.kind].confirm}
        danger={pending !== undefined && ACTION_TEXT[pending.kind].danger}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(undefined)}
      />
      <ConfirmDialog
        open={createReview !== undefined}
        title={createReview === undefined ? '' : `Create ${createReview.username}?`}
        scope={
          <p>
            {createReview === undefined
              ? ''
              : draftScope(
                  createReview.username,
                  createReview.grantThisGuild,
                  createReview.capabilities,
                )}
          </p>
        }
        confirmLabel="Create account"
        danger={false}
        busy={createBusy}
        onConfirm={() => void create()}
        onCancel={() => setCreateReview(undefined)}
      />
      <PrintOnceDialog
        open={created !== undefined}
        title="Account created"
        secretLabel={created === undefined ? '' : `Generated password for ${created.username}`}
        secret={created?.password}
        onDone={() => {
          setCreated(undefined);
          accounts.reload();
        }}
      />
      <PrintOnceDialog
        open={newPassword !== undefined}
        title="Password reset"
        secretLabel={newPassword === undefined ? '' : `New password for ${newPassword.username}`}
        secret={newPassword?.password}
        onDone={() => {
          if (newPassword !== undefined) {
            toast({
              tone: 'ok',
              title: `Password reset for ${newPassword.username}`,
              message: `${String(newPassword.sessionsRevoked)} sessions revoked across ${String(newPassword.guildsTouched)} guilds.`,
            });
          }
          setNewPassword(undefined);
          accounts.reload();
        }}
      />
    </>
  );
}
