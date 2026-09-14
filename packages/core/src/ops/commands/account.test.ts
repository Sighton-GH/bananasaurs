import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import { accountGrantCommand } from './account.js';

const NOW = 1_700_000_000_000;

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly seen: unknown[];
}

const harness = (grant: OpsPorts['grantAccountCapability']): Harness => {
  const audit: OpsAuditWrite[] = [];
  const seen: unknown[] = [];
  const dispatcher = createDispatcher({
    commands: [accountGrantCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
        grantAccountCapability: (input) => {
          seen.push(input);
          return grant(input);
        },
      }),
    }),
    instance: fakeOpsInstance(),
  });
  return {
    audit,
    seen,
    run: (args = {}, confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'account grant', args, confirm }),
  };
};

describe('account grant is registered on the operator surface (ADR 0028)', () => {
  it('appears in the command list as a write', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('account grant');
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'account grant')?.write).toBe(true);
  });
});

describe('account grant', () => {
  it('refuses without --confirm before argument validation', async () => {
    const h = harness(() => 'granted');
    // A deliberately invalid capability: the error must still be
    // needs-confirm, because the dispatcher checks confirmation first.
    const response = await h.run({ username: 'owner', capability: 'mcp.admin' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
  });

  it('grants the capability and audits the write', async () => {
    const h = harness(() => 'granted');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(
      `granted mcp.authorize to owner in guild ${FIXTURE_GUILD_ID}`,
    );
    expect(h.seen).toEqual([
      { username: 'owner', capability: 'mcp.authorize', grantedBy: expect.any(String) },
    ]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.capability.granted',
      subjectType: 'account',
      subjectId: 'owner',
      before: { held: false },
      after: { held: true, capability: 'mcp.authorize' },
    });
  });

  it('reports already-held as a usage answer with an audit row marked unchanged', async () => {
    const h = harness(() => 'already-held');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('already holds');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'account.capability.granted',
      subjectType: 'account',
      subjectId: 'owner',
    });
    expect((h.audit[0]?.after as { changed?: boolean } | undefined)?.changed).toBe(false);
  });

  it('throws for an account that does not exist, and audits nothing', async () => {
    const h = harness(() => 'no-such-account');
    const response = await h.run({ username: 'ghost', capability: 'mcp.authorize' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('ghost');
    expect(h.audit).toHaveLength(0);
  });

  it('throws for an account that cannot reach this guild, and audits nothing', async () => {
    const h = harness(() => 'no-guild-access');
    const response = await h.run({ username: 'owner', capability: 'mcp.authorize' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('owner');
    expect(h.audit).toHaveLength(0);
  });

  it('refuses an unknown capability by naming the valid set', async () => {
    const h = harness(() => 'granted');
    const response = await h.run({ username: 'owner', capability: 'mcp.admin' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('bad-request');
    // The validator is `z.enum(CAPABILITIES)`, so the refusal names what was
    // expected — including the capability this grant path is for.
    expect(response.ok === false && response.message).toContain('mcp.authorize');
  });
});
