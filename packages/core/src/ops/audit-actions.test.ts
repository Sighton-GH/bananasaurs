import { describe, expect, it } from 'vitest';
import { OPS_AUDIT_ACTIONS } from './audit-actions.js';

/** The names the dashboard wrote before ADR 0134 renamed them. None may survive as a value. */
const RETIRED_NAMES = [
  'setting.applied',
  'archive_channel.enabled',
  'archive_channel.disabled',
  'archive_channel.paused',
  'archive_channel.resumed',
  'archive_category.enabled',
  'archive_category.disabled',
  'archive_category.paused',
  'archive_category.resumed',
  'archive_channel.threads_set',
  'archive_message.preserved',
  'archive_message.case_linked',
  'archive_reindex.ran',
  'archive_backfill.enqueued',
  'undo.enqueued',
  'adoption_allowance.granted',
  'send_channel.allowed',
  'send_channel.disallowed',
  'send_category.allowed',
  'send_category.disallowed',
  'role_policy.updated',
  'role_allowlist.allowed',
  'role_allowlist.disallowed',
  'automod_match.verdict_recorded',
  'invite_allowlist.added',
  'invite_allowlist.removed',
  'link_domain.added',
  'link_domain.removed',
  'backup.ran',
  'account.credentials_revoked',
  'account.password_reset',
  'account.guild_granted',
  'account.guild_revoked',
  'account.capability_revoked',
  'account.password_revealed',
];

describe('OPS_AUDIT_ACTIONS (ADR 0134)', () => {
  const values = Object.values(OPS_AUDIT_ACTIONS);

  it('gives each value to exactly one key', () => {
    expect(new Set(values).size).toBe(values.length);
  });

  it('writes dotted lowercase names, the shape the CLI has always used', () => {
    for (const value of values) {
      expect(value).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it('holds none of the names ADR 0134 retired', () => {
    expect(RETIRED_NAMES).toHaveLength(35);
    for (const retired of RETIRED_NAMES) {
      expect(values).not.toContain(retired);
    }
  });
});
