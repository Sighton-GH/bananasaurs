import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  mcpAllowRoleCommand,
  mcpDisallowRoleCommand,
  mcpRolePolicyCommand,
} from './mcp-role-policy.js';

const NOW = 1_700_000_000_000;
const ROLE = '333333333333333333';

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
}

const harness = (overPorts: Partial<OpsPorts> = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const dispatcher = createDispatcher({
    commands: [mcpRolePolicyCommand, mcpAllowRoleCommand, mcpDisallowRoleCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
        ...overPorts,
      }),
    }),
    instance: fakeOpsInstance(),
  });
  return {
    audit,
    run: (command, args = {}, confirm = true) =>
      dispatcher.dispatch({ v: 1, command, args, confirm }),
  };
};

describe('mcp role-policy commands are registered on the operator surface', () => {
  it('all three appear in the command list', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(['mcp role-policy', 'mcp allow-role', 'mcp disallow-role']),
    );
  });

  it('all three are writes: they need --confirm', () => {
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp role-policy')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp allow-role')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp disallow-role')?.write).toBe(true);
  });
});

describe('mcp role-policy with no flags', () => {
  it('reads both modes and the allowlist rows, and audits what it showed', async () => {
    const h = harness({
      readRolePolicy: () => ({ grantMode: 'allowlist', pingMode: 'below-bot' }),
      listRoleAllowlist: () => [
        { roleId: ROLE, purpose: 'ping', addedByAccountId: 'acct_1', addedAt: NOW - 1_000 },
      ],
    });
    const response = await h.run('mcp role-policy');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.text).toContain('grant mode: allowlist');
    expect(response.text).toContain('ping mode: below-bot');
    expect(response.text).toContain(ROLE);
    expect(response.text).toContain('ping');
    expect(response.text).toContain('acct_1');
    expect(response.text).toContain(new Date(NOW - 1_000).toISOString());
    expect(response.data).toMatchObject({
      grantMode: 'allowlist',
      pingMode: 'below-bot',
      entries: [
        { roleId: ROLE, purpose: 'ping', addedByAccountId: 'acct_1', addedAt: NOW - 1_000 },
      ],
    });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_policy.read',
      subjectType: 'mcp_role_policy',
    });
  });

  it('says so plainly when nothing is allowlisted', async () => {
    const h = harness({
      readRolePolicy: () => ({ grantMode: 'below-bot', pingMode: 'below-bot' }),
      listRoleAllowlist: () => [],
    });
    const response = await h.run('mcp role-policy');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('no roles allowlisted');
  });

  it('refuses without --confirm and never calls the ports', async () => {
    let calls = 0;
    const h = harness({
      readRolePolicy: () => {
        calls += 1;
        return { grantMode: 'below-bot', pingMode: 'below-bot' };
      },
      listRoleAllowlist: () => [],
    });
    const response = await h.run('mcp role-policy', {}, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });
});

describe('mcp role-policy with a flag', () => {
  it('upserts the named mode, keeps the other, and audits before and after', async () => {
    const seen: { grantMode?: string; pingMode?: string }[] = [];
    const h = harness({
      setRolePolicy: (input) => {
        seen.push({ ...input });
        return {
          before: { grantMode: 'below-bot', pingMode: 'below-bot' },
          after: {
            grantMode: input.grantMode ?? 'below-bot',
            pingMode: input.pingMode ?? 'below-bot',
          },
        };
      },
    });
    const response = await h.run('mcp role-policy', { grant: 'allowlist' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe('role policy is now grant=allowlist ping=below-bot');
    expect(response.ok && response.data).toMatchObject({
      before: { grantMode: 'below-bot', pingMode: 'below-bot' },
      after: { grantMode: 'allowlist', pingMode: 'below-bot' },
      changed: true,
    });
    // The other mode is kept: only the named flag crosses the port.
    expect(seen).toEqual([{ grantMode: 'allowlist' }]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_policy.updated',
      subjectType: 'mcp_role_policy',
      before: { grantMode: 'below-bot', pingMode: 'below-bot' },
      after: { grantMode: 'allowlist', pingMode: 'below-bot', changed: true },
    });
  });

  it('a write that changes nothing is a usage answer with an audit row', async () => {
    const h = harness({
      setRolePolicy: () => ({
        before: { grantMode: 'allowlist', pingMode: 'below-bot' },
        after: { grantMode: 'allowlist', pingMode: 'below-bot' },
      }),
    });
    const response = await h.run('mcp role-policy', { grant: 'allowlist' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('nothing changed');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'mcp.role_policy.updated' });
  });

  it('refuses a mode outside the pair', async () => {
    const h = harness();
    const response = await h.run('mcp role-policy', { grant: 'everyone' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('bad-request');
    expect(h.audit).toHaveLength(0);
  });
});

describe('mcp allow-role', () => {
  it('allows the role and audits the write with the actor claim', async () => {
    const seen: { roleId: string; purpose: string; accountId: string }[] = [];
    const h = harness({
      allowRole: (input) => {
        seen.push({ ...input });
        return Promise.resolve('allowed');
      },
    });
    const response = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'ping' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(ROLE);
    expect(response.ok && response.data).toMatchObject({
      roleId: ROLE,
      purpose: 'ping',
      allowed: true,
      changed: true,
    });
    // The CLI has no verified account: the claim travels as the adder, the
    // same claim-not-identity `account grant` records as `grantedBy`.
    expect(seen).toEqual([{ roleId: ROLE, purpose: 'ping', accountId: 'operator_cli' }]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_allowlist.allowed',
      subjectType: 'mcp_role_allowlist',
      subjectId: ROLE,
      before: { allowed: false },
      after: { allowed: true, changed: true, roleId: ROLE, purpose: 'ping' },
    });
  });

  it('an already-allowlisted role is a usage answer with an audit row, not a fault', async () => {
    const h = harness({ allowRole: () => Promise.resolve('already-allowed') });
    const response = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'grant' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('already allowlisted');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_allowlist.allowed',
      after: { allowed: true, changed: false },
    });
  });

  it.each([
    ['no-such-role', 'is not a role of this guild'],
    ['everyone', 'is @everyone'],
    ['managed', 'managed by an integration'],
    ['dangerous', 'dangerous permission'],
  ] as const)(
    'a %s refusal is distinct data with an audit row, not a fault',
    async (outcome, text) => {
      const h = harness({ allowRole: () => Promise.resolve(outcome) });
      const response = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'ping' });
      expect(response.ok).toBe(true);
      expect(response.ok && response.text).toContain(text);
      expect(response.ok && response.data).toMatchObject({
        ok: false,
        reason: outcome,
        roleId: ROLE,
        purpose: 'ping',
      });
      expect(h.audit).toHaveLength(1);
      expect(h.audit[0]).toMatchObject({
        action: 'mcp.role_allowlist.allowed',
        subjectType: 'mcp_role_allowlist',
        subjectId: ROLE,
        after: { outcome, roleId: ROLE, purpose: 'ping' },
      });
    },
  );

  it('carries no role name anywhere: ids and purposes only', async () => {
    const h = harness({ allowRole: () => Promise.resolve('allowed') });
    const response = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'ping' });
    expect(response.ok).toBe(true);
    const rendered = JSON.stringify(response.ok ? response : null);
    expect(rendered).not.toContain('Cool Role');
    expect(JSON.stringify(h.audit)).not.toContain('Cool Role');
  });

  it('refuses without --confirm and never calls the port', async () => {
    let calls = 0;
    const h = harness({
      allowRole: () => {
        calls += 1;
        return Promise.resolve('allowed' as const);
      },
    });
    const response = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'ping' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it('refuses a non-snowflake role id and a purpose outside the pair', async () => {
    const h = harness({ allowRole: () => Promise.resolve('allowed') });
    const badId = await h.run('mcp allow-role', { roleId: 'not-a-role', purpose: 'ping' });
    expect(badId.ok).toBe(false);
    expect(badId.ok === false && badId.code).toBe('bad-request');
    const badPurpose = await h.run('mcp allow-role', { roleId: ROLE, purpose: 'everyone' });
    expect(badPurpose.ok).toBe(false);
    expect(badPurpose.ok === false && badPurpose.code).toBe('bad-request');
    const missing = await h.run('mcp allow-role', { roleId: ROLE });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.code).toBe('bad-request');
  });
});

describe('mcp disallow-role', () => {
  it('removes the row and audits the write', async () => {
    const seen: { roleId: string; purpose: string }[] = [];
    const h = harness({
      disallowRole: (input) => {
        seen.push({ ...input });
        return 'removed';
      },
    });
    const response = await h.run('mcp disallow-role', { roleId: ROLE, purpose: 'ping' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(`role ${ROLE} is no longer allowlisted for ping`);
    expect(response.ok && response.data).toMatchObject({
      roleId: ROLE,
      purpose: 'ping',
      allowed: false,
      changed: true,
    });
    expect(seen).toEqual([{ roleId: ROLE, purpose: 'ping' }]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_allowlist.disallowed',
      subjectType: 'mcp_role_allowlist',
      subjectId: ROLE,
      before: { allowed: true },
      after: { allowed: false, changed: true },
    });
  });

  it('a role that was not allowed is a usage answer with an audit row', async () => {
    const h = harness({ disallowRole: () => 'not-allowed' });
    const response = await h.run('mcp disallow-role', { roleId: ROLE, purpose: 'grant' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('was not allowlisted');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.role_allowlist.disallowed',
      after: { allowed: false, changed: false },
    });
  });

  it('refuses without --confirm and never calls the port', async () => {
    let calls = 0;
    const h = harness({
      disallowRole: () => {
        calls += 1;
        return 'removed' as const;
      },
    });
    const response = await h.run('mcp disallow-role', { roleId: ROLE, purpose: 'ping' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });
});
