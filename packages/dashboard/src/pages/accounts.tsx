import { useCallback } from 'react';
import { Link } from 'wouter';
import {
  ACCOUNT_ROLES,
  CAPABILITY_INFO,
  roleForCapabilities,
  type Capability,
} from '@bananasaurs/core';
import type { Account, AccountsResponse } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

export const OWNER_SENTENCE =
  'The owner runs this Bananasaurs install and always has every permission on every server.';

const roleLabel = (caps: readonly Capability[]): string => {
  const role = roleForCapabilities(caps);
  if (role === 'custom') return 'Custom';
  return ACCOUNT_ROLES.find((r) => r.id === role)?.label ?? role;
};

interface AccountRow {
  readonly account: Account;
  readonly caps: readonly Capability[];
}

/**
 * `/accounts`: the operator roster (ADR 0069). The owner row is locked — an
 * Owner badge with its sentence and no mutating controls; the owner can only
 * change their own password, from their own edit page. Every other row shows
 * its role in plain words with an Edit link to `/accounts/:username`, where
 * all changes happen. Capability ids never render as visible text.
 */
export function AccountsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AccountsResponse>('/api/accounts'), [session]);
  const accounts = useResource('the accounts', load);

  return (
    <>
      <PageHeader
        title="Accounts"
        purpose="Everyone who can sign in to this dashboard, and what each account may do on this server."
        actions={
          <Link
            href="/accounts/new"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-ink bg-ink px-2.5 py-1 text-sm text-canvas hover:opacity-90"
          >
            Add account
          </Link>
        }
      />
      <DataState
        resource={accounts.resource}
        isEmpty={(r) => r.accounts.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No accounts. The setup page re-arms with bootstrap reissue from the host.
          </p>
        }
      >
        {(r) => {
          const rows: readonly AccountRow[] = r.accounts.map((account) => ({
            account,
            caps: (r.capabilities[account.accountId] ?? []) as readonly Capability[],
          }));
          return (
            <DataTable
              caption="Dashboard accounts"
              rows={rows}
              rowKey={(row) => row.account.accountId}
              columns={[
                { key: 'username', header: 'Username', cell: (row) => row.account.username },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (row) =>
                    row.account.isOwner ? (
                      <span className="grid max-w-md gap-1">
                        <span>
                          <Badge tone="neutral">Owner</Badge>
                        </span>
                        <span className="text-xs text-ink-muted">{OWNER_SENTENCE}</span>
                      </span>
                    ) : (
                      roleLabel(row.caps)
                    ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (row) => (
                    <span className="flex gap-1 whitespace-nowrap">
                      {row.account.disabled ? (
                        <Badge tone="danger">Disabled</Badge>
                      ) : (
                        'Enabled'
                      )}
                      {row.account.lockedUntil !== null &&
                        row.account.lockedUntil > Date.now() && (
                          <Badge tone="hold">
                            Locked until {new Date(row.account.lockedUntil).toLocaleString()}
                          </Badge>
                        )}
                    </span>
                  ),
                },
                {
                  key: 'permissions',
                  header: 'Permissions on this server',
                  cell: (row) =>
                    row.account.isOwner ? (
                      'Every permission'
                    ) : row.caps.length === 0 ? (
                      <span className="text-ink-muted">None yet</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-1">
                        {row.caps.map((capability, index) => (
                          <span key={capability}>
                            <span title={capability}>
                              {CAPABILITY_INFO[capability]?.label ?? capability}
                            </span>
                            {index < row.caps.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  key: 'created',
                  header: 'Created',
                  cell: (row) => (
                    <span className="whitespace-nowrap">
                      {new Date(row.account.createdAt).toLocaleDateString()}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  cell: (row) =>
                    row.account.isOwner ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <Link
                        href={`/accounts/${row.account.username}`}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-panel px-2.5 py-1 text-sm text-ink hover:border-ink-muted"
                      >
                        Edit
                      </Link>
                    ),
                },
              ]}
            />
          );
        }}
      </DataState>
    </>
  );
}
