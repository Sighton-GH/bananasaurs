import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import type { UseResource } from '../../hooks/useResource.js';
import { useCallback, useState } from 'react';
import { ApiError } from '../../api.js';
import { describeError } from '../../api/describe-error.js';
import type {
  GuildRoleInfo,
  RoleAllowlistEntry,
  RoleAllowlistPurpose,
  RolePolicyMode,
  RolePolicyResponse,
  RolePolicyUpdate,
} from '../../api/ops.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Button } from '../../ui/Button.js';
import { RolePicker } from '../../ui/RolePicker.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { useToast } from '../../ui/Toast.js';
const ROLE_POLICY_MODES: readonly RolePolicyMode[] = ['below-bot', 'allowlist'];
const ROLE_ALLOWLIST_PURPOSES: readonly RoleAllowlistPurpose[] = ['grant', 'ping'];

/**
 * A server refusal from the allow-role write, as one inline sentence. The
 * route answers 404 `no-such-role` and 409 `role-everyone` / `role-managed` /
 * `role-dangerous`; anything else falls back to the catalogued error text.
 */
const describeRoleRefusal = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.body.error === 'no-such-role')
      return 'That role is not in this server — nothing was allowlisted.';
    if (err.body.error === 'role-everyone')
      return '@everyone can never be allowlisted — nothing was allowlisted.';
    if (err.body.error === 'role-managed')
      return 'That role is managed by an integration and can never be allowlisted — nothing was allowlisted.';
    if (err.body.error === 'role-dangerous')
      return (
        'That role holds a dangerous permission (ADR 0117 floor) and can never ' +
        'be allowlisted — nothing was allowlisted.'
      );
  }
  const described = describeError(err);
  return [described.message, described.hint].filter(Boolean).join(' ');
};

/**
 * The "Role policy" card: `mcp role-policy` / `mcp allow-role` /
 * `mcp disallow-role` through the same ports the CLI calls
 * (`GET /api/role-policy`, `POST /api/role-policy`,
 * `POST /api/role-allowlist`, `DELETE /api/role-allowlist/:roleId`).
 *
 * Mounted only once the policy has loaded, so the mode selectors seed
 * directly from `policy` and a `reload()` remounts this view with fresh
 * values — the same shape the automod rule page's mode section uses. Ids
 * and purposes only cross the API; role names come from the live role list
 * and degrade to bare ids when it is unavailable.
 */
function RolePolicyControls({
  policy,
  reload,
}: {
  readonly policy: RolePolicyResponse;
  readonly reload: () => void;
}) {
  const session = useSession();
  const toast = useToast();

  const [grantMode, setGrantMode] = useState<RolePolicyMode>(policy.grantMode);
  const [pingMode, setPingMode] = useState<RolePolicyMode>(policy.pingMode);
  const [roleId, setRoleId] = useState('');
  const [purpose, setPurpose] = useState<RoleAllowlistPurpose>('grant');
  const [addRefusal, setAddRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const loadRoles = useCallback(
    () => session.read<{ roles: GuildRoleInfo[] }>('/api/guild/roles'),
    [session],
  );
  const roles = useResource('the role list', loadRoles);
  const nameOf = (id: string): string =>
    roles.resource.state === 'ready'
      ? (roles.resource.data.roles.find((r) => r.roleId === id)?.name ?? id)
      : id;

  const saveModes = async () => {
    setBusy(true);
    const result = await session.write<RolePolicyUpdate>('/api/role-policy', {
      grant: grantMode,
      ping: pingMode,
    });
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title: result.changed
          ? `Role policy is now grant=${result.after.grantMode} ping=${result.after.pingMode}`
          : 'Role policy already had those modes — nothing changed',
      });
      reload();
    }
  };

  const allowRole = async () => {
    const trimmed = roleId.trim();
    if (trimmed === '') {
      setAddRefusal('Choose a role first — nothing was allowlisted.');
      return;
    }
    setAddRefusal(undefined);
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{ outcome: string }>(
        '/api/role-allowlist',
        { roleId: trimmed, purpose, accountId: session.info.accountId },
        'POST',
        [404],
      );
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-allowed'
            ? 'That role was already allowlisted — nothing changed'
            : 'Role allowlisted',
      });
      setRoleId('');
      reload();
    } catch (err) {
      // `writeOrThrow` lets the server's 400/404/409 answers through; the
      // session toasts and resolves `undefined` for everything else, which
      // the early return above already handled.
      if (err instanceof ApiError) setAddRefusal(describeRoleRefusal(err));
      else throw err;
    } finally {
      setBusy(false);
    }
  };

  const disallowRole = async (entry: RoleAllowlistEntry) => {
    setBusy(true);
    const result = await session.write<{ ok: boolean }>(
      `/api/role-allowlist/${encodeURIComponent(entry.roleId)}?purpose=${entry.purpose}`,
      undefined,
      'DELETE',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({ tone: 'ok', title: 'Role removed from the allowlist' });
      reload();
    }
  };

  return (
    <div className="grid gap-3">
      {roles.resource.state === 'error' && (
        <DataState resource={roles.resource}>{() => null}</DataState>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <RadioGroup
          legend="Grant mode"
          name="mcp-grantMode"
          value={grantMode}
          onChange={(value) => setGrantMode(value as RolePolicyMode)}
          orientation="horizontal"
          options={ROLE_POLICY_MODES.map((value) => ({
            value,
            label:
              value === 'below-bot'
                ? 'Roles below the bot'
                : value === 'allowlist'
                  ? 'Allowlisted roles only'
                  : value === 'grant'
                    ? 'Grant roles'
                    : 'Ping roles',
          }))}
        />
        <RadioGroup
          legend="Ping mode"
          name="mcp-pingMode"
          value={pingMode}
          onChange={(value) => setPingMode(value as RolePolicyMode)}
          orientation="horizontal"
          options={ROLE_POLICY_MODES.map((value) => ({
            value,
            label:
              value === 'below-bot'
                ? 'Roles below the bot'
                : value === 'allowlist'
                  ? 'Allowlisted roles only'
                  : value === 'grant'
                    ? 'Grant roles'
                    : 'Ping roles',
          }))}
        />
        <Button busy={busy} onClick={() => void saveModes()}>
          Save modes
        </Button>
      </div>
      <p className="text-small text-ink-muted">
        Roles below the bot allows every role below the bot; Allowlisted roles only allows roles in
        the table. Above-bot roles may still be allowlisted — hierarchy is checked at use time, not
        here.
      </p>
      <DataState
        resource={{ state: 'ready', data: policy.entries }}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <p className="text-small text-ink-muted">
            No roles allowlisted — under allowlist modes the connector may grant or ping nothing.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Roles the connector may grant or ping"
            rows={[...rows]}
            rowKey={(e) => `${e.purpose}:${e.roleId}`}
            columns={[
              {
                key: 'role',
                header: 'Role',
                cell: (e) => <span className="whitespace-nowrap">{nameOf(e.roleId)}</span>,
              },
              { key: 'id', header: 'Role ID', cell: (e) => e.roleId },
              { key: 'purpose', header: 'Purpose', cell: (e) => e.purpose },
              {
                key: 'addedBy',
                header: 'Added by',
                cell: (e) => <span className="whitespace-nowrap">{e.addedByAccountId}</span>,
              },
              {
                key: 'addedAt',
                header: 'Added',
                cell: (e) => (
                  <span className="whitespace-nowrap">{new Date(e.addedAt).toLocaleString()}</span>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (e) => (
                  <Button busy={busy} onClick={() => void disallowRole(e)}>
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        )}
      </DataState>
      <div className="grid max-w-md gap-2">
        <RolePicker label="Role" value={roleId} onChange={setRoleId} />
        <RadioGroup
          legend="Purpose"
          name="mcp-purpose"
          value={purpose}
          onChange={(value) => setPurpose(value as RoleAllowlistPurpose)}
          orientation="horizontal"
          options={ROLE_ALLOWLIST_PURPOSES.map((value) => ({
            value,
            label: value === 'grant' ? 'Grant roles' : 'Ping roles',
          }))}
        />
        <div>
          <Button busy={busy} onClick={() => void allowRole()}>
            Allow role
          </Button>
        </div>
        {addRefusal !== undefined && (
          <p role="alert" className="text-small text-tone-danger-ink">
            {addRefusal}
          </p>
        )}
      </div>
    </div>
  );
}

export function RolePolicySection({ rolePolicy }: { rolePolicy: UseResource<RolePolicyResponse> }) {
  return (
    <Card title="Role policy">
      <DataState resource={rolePolicy.resource} isEmpty={() => false} empty={null}>
        {(policy) => <RolePolicyControls policy={policy} reload={rolePolicy.reload} />}
      </DataState>
    </Card>
  );
}
