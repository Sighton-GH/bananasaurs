import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPorts, OpsSendRecord } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  mcpAllowChannelCommand,
  mcpAllowlistCommand,
  mcpDisallowChannelCommand,
  mcpSendsCommand,
} from './mcp-allowlist.js';

const NOW = 1_700_000_000_000;
const CHANNEL = '444444444444444444';

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
}

const harness = (overPorts: Partial<OpsPorts> = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const dispatcher = createDispatcher({
    commands: [
      mcpAllowChannelCommand,
      mcpDisallowChannelCommand,
      mcpAllowlistCommand,
      mcpSendsCommand,
    ],
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

const send = (over: Partial<OpsSendRecord> = {}): OpsSendRecord => ({
  channelId: CHANNEL,
  messageId: '555555555555555555',
  tokenId: 'tok_0123456789abcdef0123456789abcdef',
  sentAt: NOW - 1_000,
  outcome: 'sent',
  ...over,
});

describe('mcp send commands are registered on the operator surface (slice M5)', () => {
  it('all four appear in the command list', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'mcp allow-channel',
        'mcp disallow-channel',
        'mcp allowlist',
        'mcp sends',
      ]),
    );
  });

  it('the writes need --confirm and the reads do not', () => {
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp allow-channel')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp disallow-channel')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp allowlist')?.write).toBe(false);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'mcp sends')?.write).toBe(false);
  });
});

describe('mcp allow-channel', () => {
  it('allows the channel and audits the write', async () => {
    const seen: Array<{ channelId: string; accountId: string }> = [];
    const h = harness({
      allowSendChannel: (input) => {
        seen.push({ channelId: input.channelId, accountId: input.accountId });
        return 'allowed';
      },
    });
    const response = await h.run('mcp allow-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(`channel ${CHANNEL} may now receive MCP sends`);
    expect(response.ok && response.data).toMatchObject({
      channelId: CHANNEL,
      allowed: true,
      changed: true,
    });
    // The CLI has no verified account: the claim travels as the adder, the
    // same claim-not-identity `account grant` records as `grantedBy`.
    expect(seen).toEqual([{ channelId: CHANNEL, accountId: 'operator_cli' }]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.send_channel.allowed',
      subjectType: 'mcp_send_channel',
      subjectId: CHANNEL,
      before: { allowed: false },
      after: { allowed: true, changed: true },
    });
  });

  it('an already-allowlisted channel is a usage answer with an audit row, not a fault', async () => {
    const h = harness({ allowSendChannel: () => 'already-allowed' });
    const response = await h.run('mcp allow-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('already allowlisted');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.send_channel.allowed',
      after: { allowed: true, changed: false },
    });
  });

  it('refuses without --confirm and never calls the port', async () => {
    let calls = 0;
    const h = harness({
      allowSendChannel: () => {
        calls += 1;
        return 'allowed';
      },
    });
    const response = await h.run('mcp allow-channel', { channelId: CHANNEL }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it('refuses a non-snowflake channel id', async () => {
    const h = harness({ allowSendChannel: () => 'allowed' });
    const response = await h.run('mcp allow-channel', { channelId: 'not-a-channel' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('bad-request');
  });

  it('a channel that is not in the guild is a usage answer naming the guild, with an audit row', async () => {
    // The port refused before any write; the command says plainly that the id
    // is not a channel of this guild the bot can post text into. A DM-shaped
    // id lands here: it is a well-formed snowflake the guild cache simply does
    // not contain.
    const h = harness({ allowSendChannel: () => 'no-such-channel' });
    const response = await h.run('mcp allow-channel', { channelId: '700000000000000001' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(
      'not a channel of this guild the bot can post text into',
    );
    expect(response.ok && response.data).toMatchObject({
      ok: false,
      reason: 'no-such-channel',
      channelId: '700000000000000001',
    });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.send_channel.allowed',
      subjectType: 'mcp_send_channel',
      subjectId: '700000000000000001',
      after: { outcome: 'no-such-channel' },
    });
  });
});

describe('mcp disallow-channel', () => {
  it('removes the channel and audits the write', async () => {
    const seen: string[] = [];
    const h = harness({
      disallowSendChannel: (channelId) => {
        seen.push(channelId);
        return true;
      },
    });
    const response = await h.run('mcp disallow-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toBe(`channel ${CHANNEL} can no longer receive MCP sends`);
    expect(response.ok && response.data).toMatchObject({
      channelId: CHANNEL,
      allowed: false,
      changed: true,
    });
    expect(seen).toEqual([CHANNEL]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.send_channel.disallowed',
      subjectType: 'mcp_send_channel',
      subjectId: CHANNEL,
      before: { allowed: true },
      after: { allowed: false, changed: true },
    });
  });

  it('a channel that was never allowlisted is a usage answer with an audit row', async () => {
    const h = harness({ disallowSendChannel: () => false });
    const response = await h.run('mcp disallow-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('was not allowlisted');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'mcp.send_channel.disallowed',
      after: { allowed: false, changed: false },
    });
  });

  it('refuses without --confirm and never calls the port', async () => {
    let calls = 0;
    const h = harness({
      disallowSendChannel: () => {
        calls += 1;
        return true;
      },
    });
    const response = await h.run('mcp disallow-channel', { channelId: CHANNEL }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });
});

describe('mcp allowlist', () => {
  it('says so plainly when nothing is allowlisted', async () => {
    const h = harness({ listSendAllowlist: () => [] });
    const response = await h.run('mcp allowlist');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toMatch(/no channels are allowlisted/);
    expect(response.ok && response.data).toEqual([]);
  });

  it('prints one line per channel with id, adder and date', async () => {
    const h = harness({
      listSendAllowlist: () => [
        { channelId: CHANNEL, addedByAccountId: 'acct_1', addedAt: NOW - 86_400_000 },
      ],
    });
    const response = await h.run('mcp allowlist');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(CHANNEL);
    expect(response.ok && response.text).toContain('acct_1');
    expect(response.ok && response.text).toContain(new Date(NOW - 86_400_000).toISOString());
  });

  it('never asks for --confirm, since nothing changes', async () => {
    const h = harness({ listSendAllowlist: () => [] });
    const response = await h.run('mcp allowlist', {}, false);
    expect(response.ok).toBe(true);
  });
});

describe('mcp sends', () => {
  it('says so plainly when nothing was sent', async () => {
    const h = harness({ listSends: () => [] });
    const response = await h.run('mcp sends');
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toMatch(/no MCP sends recorded/);
    expect(response.ok && response.data).toEqual([]);
  });

  it('names the window when a --since filter matches nothing', async () => {
    const h = harness({ listSends: () => [] });
    const response = await h.run('mcp sends', { since: '2h' });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('no MCP sends recorded in the last 2h');
  });

  it('renders channels, outcomes, tokens and message ids — never content', async () => {
    const content = 'the message text must never reach this surface';
    const h = harness({
      listSends: () => [
        send(),
        send({ channelId: '666666666666666666', outcome: 'dry_run', messageId: undefined }),
      ],
    });
    const response = await h.run('mcp sends');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.text).toContain(CHANNEL);
    expect(response.text).toContain('sent');
    expect(response.text).toContain('dry_run');
    expect(response.text).toContain('tok_0123456789abcdef0123456789abcdef');
    expect(response.text).toContain('message 555555555555555555');
    expect(response.text).not.toContain(content);
    expect(JSON.stringify(response.data)).not.toContain(content);
  });

  it('turns --since into an absolute timestamp against the context clock', async () => {
    let seen: { sinceMs?: number | undefined; limit?: number | undefined } | undefined;
    const h = harness({
      listSends: (input) => {
        seen = input;
        return [];
      },
    });
    const response = await h.run('mcp sends', { since: '2h' });
    expect(response.ok).toBe(true);
    expect(seen).toEqual({ sinceMs: NOW - 7_200_000, limit: undefined });
  });

  it('refuses an unparseable --since rather than silently ignoring it', async () => {
    const h = harness({ listSends: () => [] });
    const response = await h.run('mcp sends', { since: 'yesterday' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('--since expects a duration');
  });

  it('never asks for --confirm, since nothing changes', async () => {
    const h = harness({ listSends: () => [] });
    const response = await h.run('mcp sends', {}, false);
    expect(response.ok).toBe(true);
  });
});
