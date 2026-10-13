import { ACCOUNT_ROLES, roleForCapabilities, type Capability } from '@bananasaurs/core';
import { type Account } from '../../../api/ops.js';
import { Badge } from '../../../ui/Badge.js';
import { Card } from '../../../ui/Card.js';
import { OWNER_SENTENCE } from '../../accounts.js';

const roleLabel = (caps: readonly Capability[]): string => {
  const role = roleForCapabilities(caps);
  if (role === 'custom') return 'Custom';
  return ACCOUNT_ROLES.find((r) => r.id === role)?.label ?? role;
};

export function SummaryCard({
  account,
  caps,
}: {
  readonly account: Account;
  readonly caps: readonly Capability[];
}) {
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
