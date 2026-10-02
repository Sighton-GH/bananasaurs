import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { parseGuildId, RetryAfterError, type EffectGateway } from '@bananasaurs/core';
import type { mcpBulkRepo } from '@bananasaurs/storage';
import {
  MCP_BULK_MAX_ATTEMPTS,
  MCP_BULK_RATE_RETRY_MS,
  MCP_BULK_ROLE_KIND,
  mcpBulkRoleDedupeKey,
  mcpBulkRoleHandler,
  mcpBulkRolePayload,
  type McpBulkRoleJobPorts,
} from './mcp-bulk-role.js';

/**
 * Slice 4, Task 4, job layer: `mcp.bulk_role` against a fake gateway — the
 * same seam the daemon wires to the real MCP gateway in `runtime/guild.ts`,
 * so the walk behaviour pinned here (previewed set, cursor resume, rate-cap
 * reschedule) holds whichever gateway sits behind it.
 */

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const ROLE = '522222222222222222';
const MEMBER_A = '633333333333333333';
const MEMBER_B = '634444444444444444';
const ACTION = 'act-00000000000000000000000001';

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
});

afterEach(() => {
  t.close();
});

type GatewayCall = Parameters<EffectGateway['applyRoleEffect']>[1];
type GatewayResult = Awaited<ReturnType<EffectGateway['applyRoleEffect']>>;

const fakeGateway = (
  behave: (memberId: string) => GatewayResult | Promise<GatewayResult> = () => ({
    status: 'applied',
    effectId: 'eff-1',
    hadRoleBefore: false,
  }),
): Pick<EffectGateway, 'applyRoleEffect'> & { readonly calls: GatewayCall[] } => {
  const calls: GatewayCall[] = [];
  return {
    calls,
    applyRoleEffect: (_witness, intent) => {
      calls.push(intent);
      return Promise.resolve(behave(String(intent.userId)));
    },
  };
};

const previewRow = (
  over: Partial<mcpBulkRepo.McpBulkPreviewRow> = {},
): mcpBulkRepo.McpBulkPreviewRow => ({
  previewId: 'preview-1',
  actionKind: 'add',
  roleId: ROLE,
  argsHash: 'args-1',
  memberIds: [MEMBER_A, MEMBER_B],
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
  consumedAt: 1_700_000_000_001,
  jobId: 9,
  ...over,
});

const captureLogger = (lines: string[]): McpBulkRoleJobPorts['logger'] =>
  ({
    info: (_fields: unknown, message: string) => {
      lines.push(message);
    },
    warn: (_fields: unknown, message: string) => {
      lines.push(message);
    },
    error: (_fields: unknown, message: string) => {
      lines.push(message);
    },
  }) as unknown as McpBulkRoleJobPorts['logger'];

const portsFor = (
  over: Partial<McpBulkRoleJobPorts> = {},
): McpBulkRoleJobPorts & {
  readonly lines: string[];
} => {
  const lines: string[] = [];
  return {
    gateway: fakeGateway(),
    lines,
    scope: t.scopes.forGuild(GUILD),
    logger: captureLogger(lines),
    now: () => 1_700_000_000_000,
    authorizeAccount: () => ({}) as never,
    findPreview: () => previewRow(),
    ...over,
  };
};

const payload = (over: Record<string, unknown> = {}) =>
  mcpBulkRolePayload.parse({
    guildId: GUILD,
    previewId: 'preview-1',
    actionId: ACTION,
    accountId: 'acct_1',
    ...over,
  });

const runCtx = (over: { jobId?: number; cursor?: string | null } = {}) => {
  const saved: (string | null)[] = [];
  return {
    saved,
    ctx: {
      jobId: over.jobId ?? 9,
      attempts: 1,
      cursor: over.cursor ?? null,
      saveCursor: (cursor: string | null) => {
        saved.push(cursor);
      },
    },
  };
};

describe('mcp.bulk_role kind and envelope', () => {
  it('is named mcp.bulk_role with a per-action dedupe key', () => {
    expect(MCP_BULK_ROLE_KIND).toBe('mcp.bulk_role');
    expect(mcpBulkRoleDedupeKey(ACTION)).toBe(`mcp.bulk_role:${ACTION}`);
    expect(mcpBulkRoleDedupeKey('other')).not.toBe(mcpBulkRoleDedupeKey(ACTION));
  });

  it('allows room to reschedule a 100-member walk through a per-minute bucket', () => {
    expect(MCP_BULK_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
    expect(MCP_BULK_RATE_RETRY_MS).toBe(60_000);
  });
});

describe('mcp.bulk_role walk', () => {
  it('applies the previewed set with the bulk trigger ref and the action batch', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway });
    const { ctx } = runCtx();
    await mcpBulkRoleHandler(ports).run(payload(), ctx);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[0]).toMatchObject({
      roleId: ROLE,
      action: 'grant',
      panelId: undefined,
      triggerRef: `mcp-bulk:${ACTION}:${MEMBER_A}`,
      source: 'mcp',
      batchId: ACTION,
    });
    expect(gateway.calls[1]).toMatchObject({
      triggerRef: `mcp-bulk:${ACTION}:${MEMBER_B}`,
      batchId: ACTION,
    });
    expect(ports.lines.join('\n')).toContain('2/2 applied');
  });

  it('a removal walks as revoke, and skipped members record already-had', async () => {
    const gateway = fakeGateway(() => ({ status: 'skipped', reason: 'no-change-needed' }));
    const ports = portsFor({ gateway, findPreview: () => previewRow({ actionKind: 'remove' }) });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls[0]).toMatchObject({ action: 'revoke' });
    expect(ports.lines.join('\n')).toContain('0/2 applied');
    expect(ports.lines.join('\n')).toContain('already-had');
  });

  it('refusals are recorded per member and the walk continues past them', async () => {
    const gateway = fakeGateway((memberId) =>
      memberId === MEMBER_A
        ? { status: 'refused', reason: 'protected-target' }
        : { status: 'applied', effectId: 'eff-2', hadRoleBefore: false },
    );
    const ports = portsFor({ gateway });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls).toHaveLength(2);
    expect(ports.lines.join('\n')).toContain(`${MEMBER_A}:refused:protected-target`);
    expect(ports.lines.join('\n')).toContain('1/2 applied');
  });

  it('a gateway throw is one member failed result, never a failed walk', async () => {
    const gateway: Pick<EffectGateway, 'applyRoleEffect'> & { readonly calls: GatewayCall[] } = {
      calls: [],
      applyRoleEffect: (_witness, intent) => {
        gateway.calls.push(intent);
        return String(intent.userId) === MEMBER_A
          ? Promise.reject(new Error('fetch exploded'))
          : Promise.resolve({ status: 'applied', effectId: 'eff-2', hadRoleBefore: false });
      },
    };
    const ports = portsFor({ gateway });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls).toHaveLength(2);
    expect(ports.lines.join('\n')).toContain(`${MEMBER_A}:failed:Error`);
    expect(ports.lines.join('\n')).toContain('1/2 applied');
  });

  it('without a witness every member is unauthorized and the job still completes', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway, authorizeAccount: () => undefined });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls).toHaveLength(0);
    expect(ports.lines.join('\n')).toContain('unauthorized');
    expect(ports.lines.join('\n')).toContain('0/2 applied');
  });
});

describe('mcp.bulk_role resume', () => {
  it('resumes from the cursor after a simulated restart, skipping done members', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway });
    const first = runCtx();
    // A crash after the first member: only its cursor write survived.
    await mcpBulkRoleHandler(ports).run(payload(), first.ctx);
    expect(gateway.calls).toHaveLength(2);
    // A fresh handler after a restart, handed the persisted cursor: only the
    // second member is applied, the first never retried.
    const resumedGateway = fakeGateway();
    const resumed = portsFor({ gateway: resumedGateway, scope: ports.scope });
    await mcpBulkRoleHandler(resumed).run(
      payload(),
      runCtx({ cursor: JSON.stringify({ next: 1 }) }).ctx,
    );
    expect(resumedGateway.calls).toHaveLength(1);
    expect(String(resumedGateway.calls[0]?.triggerRef)).toContain(MEMBER_B);
    expect(resumed.lines.join('\n')).toContain('1/2 applied');
  });

  it('an unreadable cursor restarts from zero rather than trusting it', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx({ cursor: 'not-json' }).ctx);
    expect(gateway.calls).toHaveLength(2);
  });

  it('a rate-cap refusal persists the cursor at the refused member and reschedules', async () => {
    let calls = 0;
    const gateway = fakeGateway(() => {
      calls += 1;
      return calls === 1
        ? { status: 'applied', effectId: 'eff-1', hadRoleBefore: false }
        : { status: 'refused', reason: 'rate-cap' };
    });
    const ports = portsFor({ gateway });
    const first = runCtx();
    await expect(mcpBulkRoleHandler(ports).run(payload(), first.ctx)).rejects.toBeInstanceOf(
      RetryAfterError,
    );
    expect(JSON.parse(first.saved.at(-1) ?? '{}')).toMatchObject({ next: 1 });
    // The retry resumes at the refused member, after the bucket refills.
    const retryGateway = fakeGateway(() => ({
      status: 'applied',
      effectId: 'eff-2',
      hadRoleBefore: false,
    }));
    const retry = portsFor({ gateway: retryGateway, scope: ports.scope });
    await mcpBulkRoleHandler(retry).run(
      payload(),
      runCtx({ cursor: first.saved.at(-1) ?? null }).ctx,
    );
    expect(retryGateway.calls).toHaveLength(1);
    expect(String(retryGateway.calls[0]?.triggerRef)).toContain(MEMBER_B);
  });

  it('outcomes from before a rate-cap retry survive into the completion record', async () => {
    let calls = 0;
    const gateway = fakeGateway(() => {
      calls += 1;
      return calls === 1
        ? { status: 'skipped', reason: 'no-change-needed' }
        : { status: 'refused', reason: 'rate-cap' };
    });
    const ports = portsFor({ gateway });
    const first = runCtx();
    await expect(mcpBulkRoleHandler(ports).run(payload(), first.ctx)).rejects.toBeInstanceOf(
      RetryAfterError,
    );
    const retry = portsFor({
      gateway: fakeGateway(() => ({ status: 'applied', effectId: 'eff-2', hadRoleBefore: false })),
      scope: ports.scope,
    });
    await mcpBulkRoleHandler(retry).run(
      payload(),
      runCtx({ cursor: first.saved.at(-1) ?? null }).ctx,
    );
    const record = retry.lines.join('\n');
    expect(record).toContain(`${MEMBER_A}:already-had`);
    expect(record).toContain(`${MEMBER_B}:applied`);
  });
});

describe('mcp.bulk_role guards', () => {
  it('a job whose preview belongs to another job completes without acting', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway, findPreview: () => previewRow({ jobId: 10 }) });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx({ jobId: 9 }).ctx);
    expect(gateway.calls).toHaveLength(0);
    expect(ports.lines.join('\n')).toContain('another job');
  });

  it('a missing preview completes without acting', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway, findPreview: () => undefined });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls).toHaveLength(0);
  });

  it('a payload for another guild completes without acting', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway });
    await mcpBulkRoleHandler(ports).run(payload({ guildId: OTHER_GUILD }), runCtx().ctx);
    expect(gateway.calls).toHaveLength(0);
  });

  it('malformed stored ids complete without acting', async () => {
    const gateway = fakeGateway();
    const ports = portsFor({ gateway, findPreview: () => previewRow({ memberIds: ['../x'] }) });
    await mcpBulkRoleHandler(ports).run(payload(), runCtx().ctx);
    expect(gateway.calls).toHaveLength(0);
    expect(ports.lines.join('\n')).toContain('malformed ids');
  });
});
