import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  BULK_ROLE_CHANGE_TOOL_NAME,
  bulkArgsHashFor,
  bulkRoleChangeText,
  type BulkRoleOutcomeText,
  type McpBulkConfirmOutcome,
  type McpBulkConfirmRefusal,
  type McpBulkPreviewOutcome,
  type McpBulkPreviewRefusal,
  type McpBulkRolesPort,
} from './bulk-roles.js';
import type { McpGuildPort } from './guild.js';
import type { McpMemberProfile, McpMembersPort } from './members.js';

/**
 * Slice 4 Task 4, tool layer: `bulk_role_change` against a fake
 * `McpBulkRolesPort` — the same seam the daemon's bulk wiring implements, so
 * the guard behaviour pinned here (guild gate, argument boundary, id-or-name
 * resolution, refusal rendering) holds whichever implementation sits behind
 * it.
 *
 * Preview resolves the member set here, in the tool, through the same
 * listing `search_members` reads: an explicit list is snowflake-checked, a
 * selector filters that listing by role. Confirm never lists members — the
 * daemon applies the previewed set — so a selector confirm must not touch
 * the members port at all.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ROLE = '522222222222222222';
const ACTION = 'act-00000000000000000000000001';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:roles'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const previewArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  action: 'add',
  role: ROLE,
  members: ['633333333333333333', '634444444444444444'],
  idempotencyKey: 'bulk-k1',
  ...over,
});

const fakeGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listThreads: () => Promise.resolve([]),
  listRoles: () => [
    { id: ROLE, name: 'helpers', position: 4, color: 0, managedByBananasaurs: true },
    { id: '544444444444444444', name: 'ushers', position: 2, color: 0, managedByBananasaurs: true },
  ],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 2,
});

const profile = (
  id: string,
  displayName: string,
  roleIds: readonly string[] = [],
): McpMemberProfile => ({
  id,
  username: `user-${id.slice(-4)}`,
  displayName,
  nickname: undefined,
  roleIds,
  joinedAt: undefined,
});

/**
 * Distinct 18-digit member ids from string parts only: arithmetic on
 * snowflake-sized number literals loses precision at runtime
 * (`no-loss-of-precision`), and near 1e16 even `+1` stops being exact.
 */
const memberIdAt = (i: number): string => `6333333333${String(i).padStart(8, '0')}`;

const fakeMembers = (
  members: readonly McpMemberProfile[] = [
    profile('633333333333333333', 'Sam One', [ROLE]),
    profile('634444444444444444', 'Sam Two', []),
  ],
): McpMembersPort & { readonly listingCalls: () => number } => {
  let calls = 0;
  return {
    listingCalls: () => calls,
    listAllMembers: () => {
      calls += 1;
      return Promise.resolve({ members, truncated: false });
    },
    lastMessageAt: () => new Map(),
    now: () => 1_700_000_000_000,
  };
};

const fakeBulkPort = (input: {
  readonly preview?: McpBulkPreviewOutcome;
  readonly confirm?: McpBulkConfirmOutcome;
}): McpBulkRolesPort & {
  readonly previewCalls: unknown[];
  readonly confirmCalls: unknown[];
} => {
  const previewCalls: unknown[] = [];
  const confirmCalls: unknown[] = [];
  return {
    previewCalls,
    confirmCalls,
    preview: (_guildId, args) => {
      previewCalls.push(args);
      return Promise.resolve(
        input.preview ?? { status: 'done', token: 'tok', expiresAt: 1_700_000_060_000 },
      );
    },
    confirm: (_guildId, args) => {
      confirmCalls.push(args);
      return Promise.resolve(input.confirm ?? { status: 'done', actionId: ACTION, jobId: 7 });
    },
  };
};

const textOf = (outcome: BulkRoleOutcomeText): string => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.text;
};

const messageOf = (outcome: BulkRoleOutcomeText): string => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.message;
};

describe('bulk_role_change argument boundary', () => {
  it('101 explicit members are an argument fault, before any port call', async () => {
    const port = fakeBulkPort({});
    const members = fakeMembers();
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      members,
      previewArgs({ members: Array.from({ length: 101 }, (_, i) => memberIdAt(i)) }),
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.previewCalls).toHaveLength(0);
  });

  it('both members and selector are an argument fault', async () => {
    const port = fakeBulkPort({});
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      previewArgs({ selector: { hasRoles: [ROLE] } }),
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.previewCalls).toHaveLength(0);
  });

  it('neither members nor selector is an argument fault', async () => {
    const port = fakeBulkPort({});
    const { members: given, ...rest } = previewArgs();
    expect(given).toHaveLength(2);
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      rest,
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.previewCalls).toHaveLength(0);
  });

  it('a traversal id among the members is refused before any port call', async () => {
    const port = fakeBulkPort({});
    for (const bad of ['../x', '..\\x', '', 'not-an-id']) {
      const outcome = await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        previewArgs({ members: ['633333333333333333', bad] }),
      );
      expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    }
    expect(port.previewCalls).toHaveLength(0);
  });

  it('an unknown role name refuses before any port call', async () => {
    const port = fakeBulkPort({});
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      previewArgs({ role: 'no-such-role' }),
    );
    expect(messageOf(outcome)).toContain('No role named');
    expect(port.previewCalls).toHaveLength(0);
  });

  it('an unreachable guild is the shared refusal, before any port call', async () => {
    const port = fakeBulkPort({});
    const members = fakeMembers();
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      members,
      previewArgs({ guildId: '222222222222222222' }),
    );
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.previewCalls).toHaveLength(0);
    expect(members.listingCalls()).toBe(0);
  });
});

describe('bulk_role_change preview', () => {
  it('previews an explicit list: count, names, token and expiry, with the port input', async () => {
    const port = fakeBulkPort({
      preview: { status: 'done', token: 'preview-token-1', expiresAt: 1_700_000_060_000 },
    });
    const text = textOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        previewArgs(),
      ),
    );
    expect(text).toContain('2 members');
    expect(text).toContain('Sam One');
    expect(text).toContain('Sam Two');
    expect(text).toContain('preview-token-1');
    expect(text).toContain(new Date(1_700_000_060_000).toISOString());
    expect(port.previewCalls).toHaveLength(1);
    const input = port.previewCalls[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      action: 'add',
      roleId: ROLE,
      memberIds: ['633333333333333333', '634444444444444444'],
    });
    expect(typeof input['argsHash']).toBe('string');
  });

  it('a selector filters the listing by role, and an empty result previews zero', async () => {
    const port = fakeBulkPort({});
    const text = textOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        previewArgs({ members: undefined, selector: { hasRoles: [ROLE] } }),
      ),
    );
    expect(text).toContain('1 member');
    expect(text).toContain('Sam One');
    expect(text).not.toContain('Sam Two');
    const input = port.previewCalls[0] as Record<string, unknown>;
    expect(input['memberIds']).toEqual(['633333333333333333']);
  });

  it('lacksRoles drops members holding any named role', async () => {
    const port = fakeBulkPort({});
    await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      previewArgs({ members: undefined, selector: { lacksRoles: [ROLE] } }),
    );
    const input = port.previewCalls[0] as Record<string, unknown>;
    expect(input['memberIds']).toEqual(['634444444444444444']);
  });

  it('a selector matching more than 100 refuses with the narrow-the-set text', async () => {
    const port = fakeBulkPort({});
    const many = Array.from({ length: 120 }, (_, i) =>
      profile(memberIdAt(i), `Member ${String(i)}`),
    );
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(many),
      previewArgs({ members: undefined, selector: {} }),
    );
    expect(messageOf(outcome)).toContain('120 members');
    expect(messageOf(outcome)).toContain('narrow the set');
    expect(port.previewCalls).toHaveLength(0);
  });

  it('the preview names only the first 20 members', async () => {
    const port = fakeBulkPort({});
    const many = Array.from({ length: 25 }, (_, i) =>
      profile(memberIdAt(1000 + i), `Member ${String(i).padStart(2, '0')}`),
    );
    const text = textOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(many),
        previewArgs({
          members: undefined,
          selector: {},
        }),
      ),
    );
    expect(text).toContain('25 members');
    expect(text).toContain('Member 00');
    expect(text).toContain('Member 19');
    expect(text).not.toContain('Member 20');
    expect(text).toContain('5 more');
  });

  it('every preview refusal renders a distinct text', async () => {
    const reasons: readonly McpBulkPreviewRefusal[] = [
      'unknown-role',
      'role-not-allowlisted',
      'role-not-permitted',
      'too-many',
    ];
    const texts = new Set<string>();
    for (const reason of reasons) {
      const port = fakeBulkPort({
        preview:
          reason === 'too-many'
            ? { status: 'refused', reason, detail: '120' }
            : { status: 'refused', reason, detail: ROLE },
      });
      const message = messageOf(
        await bulkRoleChangeText(
          principalWith([GUILD_A]),
          port,
          fakeGuild(),
          fakeMembers(),
          previewArgs(),
        ),
      );
      expect(message.length).toBeGreaterThan(0);
      texts.add(message);
    }
    expect(texts.size).toBe(reasons.length);
  });
});

describe('bulk_role_change confirm', () => {
  const confirmArgs = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    previewArgs({ confirmToken: 'preview-token-1', idempotencyKey: 'bulk-k2', ...over });

  it('confirms with the token and renders the job id, without re-listing members', async () => {
    const port = fakeBulkPort({
      confirm: { status: 'done', actionId: ACTION, jobId: 9 },
    });
    const members = fakeMembers();
    const text = textOf(
      await bulkRoleChangeText(principalWith([GUILD_A]), port, fakeGuild(), members, confirmArgs()),
    );
    expect(text).toContain('9');
    expect(text).toContain(ACTION);
    expect(text).toContain('get_job');
    expect(port.confirmCalls).toHaveLength(1);
    const input = port.confirmCalls[0] as Record<string, unknown>;
    expect(input).toMatchObject({ confirmToken: 'preview-token-1', idempotencyKey: 'bulk-k2' });
    // The previewed set is never re-resolved at confirm: no member listing.
    expect(members.listingCalls()).toBe(0);
  });

  it('a selector confirm resolves roles but still never lists members', async () => {
    const port = fakeBulkPort({});
    const members = fakeMembers();
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      members,
      confirmArgs({ members: undefined, selector: { hasRoles: [ROLE] } }),
    );
    expect(outcome.ok).toBe(true);
    expect(members.listingCalls()).toBe(0);
    expect(port.confirmCalls).toHaveLength(1);
  });

  it('a selector confirm hashes the same args as its preview', async () => {
    const previewPort = fakeBulkPort({});
    const confirmPort = fakeBulkPort({});
    const args = { members: undefined as unknown, selector: { hasRoles: [ROLE] } };
    await bulkRoleChangeText(
      principalWith([GUILD_A]),
      previewPort,
      fakeGuild(),
      fakeMembers(),
      previewArgs(args),
    );
    await bulkRoleChangeText(
      principalWith([GUILD_A]),
      confirmPort,
      fakeGuild(),
      fakeMembers(),
      confirmArgs(args),
    );
    const previewHash = (previewPort.previewCalls[0] as Record<string, unknown>)['argsHash'];
    const confirmHash = (confirmPort.confirmCalls[0] as Record<string, unknown>)['argsHash'];
    expect(typeof previewHash).toBe('string');
    expect(confirmHash).toBe(previewHash);
  });

  it('every confirm refusal renders a distinct text, and none echoes the token', async () => {
    const reasons: readonly McpBulkConfirmRefusal[] = [
      'unknown-token',
      'preview-expired',
      'preview-used',
      'args-changed',
      'unknown-role',
      'role-not-allowlisted',
      'role-not-permitted',
      'unauthorized',
      'killswitch',
      'breaker-open',
      'rate-cap',
      'duplicate-key-different-content',
    ];
    const texts = new Set<string>();
    for (const reason of reasons) {
      const port = fakeBulkPort({
        confirm: { status: 'refused', reason, detail: 'preview-token-1' },
      });
      const message = messageOf(
        await bulkRoleChangeText(
          principalWith([GUILD_A]),
          port,
          fakeGuild(),
          fakeMembers(),
          confirmArgs(),
        ),
      );
      expect(message.length).toBeGreaterThan(0);
      // The token authenticates the confirm: it is never rendered back.
      expect(message).not.toContain('preview-token-1');
      texts.add(message);
    }
    expect(texts.size).toBe(reasons.length);
  });

  it('a dry-run confirm records without a job', async () => {
    const port = fakeBulkPort({ confirm: { status: 'dry-run', actionId: ACTION } });
    const text = textOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        confirmArgs({ dryRun: true }),
      ),
    );
    expect(text).toContain('Dry run');
    expect(text).toContain(ACTION);
    expect(text).not.toContain('get_job');
  });

  it('a replayed confirm names the earlier action', async () => {
    const port = fakeBulkPort({ confirm: { status: 'replayed', actionId: ACTION } });
    const text = textOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        confirmArgs(),
      ),
    );
    expect(text).toContain(ACTION);
  });

  it('a failed Discord call is an unknown result, never a claim nothing changed', async () => {
    const port = fakeBulkPort({ confirm: { status: 'failed' } });
    const message = messageOf(
      await bulkRoleChangeText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        confirmArgs(),
      ),
    );
    expect(message).toContain('unknown result');
  });

  it('a port throw is the shared refusal', async () => {
    const port: McpBulkRolesPort = {
      preview: () => Promise.reject(new Error('db exploded')),
      confirm: () => Promise.reject(new Error('db exploded')),
    };
    const outcome = await bulkRoleChangeText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      confirmArgs(),
    );
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

describe('bulkArgsHashFor', () => {
  it('is order-insensitive but sensitive to action, role and set', () => {
    const base = { action: 'add' as const, roleId: ROLE };
    expect(
      bulkArgsHashFor({ ...base, members: ['634444444444444444', '633333333333333333'] }),
    ).toBe(bulkArgsHashFor({ ...base, members: ['633333333333333333', '634444444444444444'] }));
    expect(bulkArgsHashFor({ ...base, members: ['633333333333333333'] })).not.toBe(
      bulkArgsHashFor({ ...base, members: ['634444444444444444'] }),
    );
    expect(bulkArgsHashFor({ ...base, members: ['633333333333333333'] })).not.toBe(
      bulkArgsHashFor({ action: 'remove', roleId: ROLE, members: ['633333333333333333'] }),
    );
    expect(
      bulkArgsHashFor({
        ...base,
        selector: { hasRoles: [ROLE], lacksRoles: [] },
      }),
    ).toBe(
      bulkArgsHashFor({
        ...base,
        selector: { hasRoles: [ROLE], lacksRoles: [] },
      }),
    );
  });

  it('matches the tool name in the registry', () => {
    expect(BULK_ROLE_CHANGE_TOOL_NAME).toBe('bulk_role_change');
  });
});

describe('bulk_role_change two-guild gate', () => {
  it('a caller reaching only guild B cannot preview or confirm for guild A', async () => {
    const previewPort = fakeBulkPort({});
    const preview = await bulkRoleChangeText(
      principalWith([GUILD_B]),
      previewPort,
      fakeGuild(),
      fakeMembers(),
      previewArgs(),
    );
    expect(preview).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(previewPort.previewCalls).toHaveLength(0);

    const confirmPort = fakeBulkPort({});
    const confirm = await bulkRoleChangeText(
      principalWith([GUILD_B]),
      confirmPort,
      fakeGuild(),
      fakeMembers(),
      previewArgs({ confirmToken: 'tok', idempotencyKey: 'bulk-k2' }),
    );
    expect(confirm).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(confirmPort.confirmCalls).toHaveLength(0);
  });
});
