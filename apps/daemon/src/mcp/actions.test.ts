import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { effectRepo, guildRepo, mcpActionsRepo, type GuildScope } from '@bananasaurs/storage';
import { MCP_ACTION_CAPS, parseGuildId, type GuildId } from '@bananasaurs/core';
import { mcpActionDepsFor } from './actions.js';
import { createInstanceSettingsStore } from '../settings/instance-settings-store.js';

/**
 * Task 4 Step 2: the `McpActionDeps` factory over the storage repos — the
 * ledger ports delegate to `mcp_actions`, the audit port writes the
 * `mcp.message.sent` trail with ids and the outcome but never content.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '444444444444444444';
const PARENT = '455555555555555555';
const CLIENT_ID = 'cli_testclient';
const TOKEN_ID = 'tok_testtoken';
const MESSAGE_ID = '777777777777777777';
const NOW = 1_700_000_000_000;

let t: MigratedTestDatabase;
let clock: number;

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
} as never;

const env = (): {
  scopes: { forGuild(guildId: GuildId): GuildScope };
  logger: typeof silentLogger;
  now: () => number;
} => ({ scopes: t.scopes, logger: silentLogger, now: () => clock });

beforeEach(() => {
  t = openMigratedTestDatabase();
  clock = NOW;
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: clock });
});

afterEach(() => {
  t.close();
});

const depsFor = (guildId: GuildId, grantedByChannelId?: string) =>
  mcpActionDepsFor(
    env(),
    guildId,
    { clientId: CLIENT_ID, tokenId: TOKEN_ID },
    ...(grantedByChannelId !== undefined ? [{ grantedByChannelId } as const] : []),
  );

describe('mcpActionDepsFor ledger', () => {
  it('claim then find round-trips the row', () => {
    const deps = depsFor(GUILD_A);
    expect(
      deps.ledger.claim({
        actionId: 'act-1',
        idempotencyKey: 'k1',
        kind: 'message.send',
        capGroup: 'message',
        argsHash: 'hash-1',
        tokenId: TOKEN_ID,
        targetChannelId: CHANNEL,
        dryRun: false,
        now: clock,
      }),
    ).toEqual({ claimed: true });
    expect(deps.ledger.find('k1')).toMatchObject({ actionId: 'act-1', argsHash: 'hash-1' });
  });

  it('guild B cannot see guild A rows', () => {
    depsFor(GUILD_A).ledger.claim({
      actionId: 'act-1',
      idempotencyKey: 'k1',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'hash-1',
      tokenId: TOKEN_ID,
      now: clock,
      dryRun: false,
    });
    expect(depsFor(GUILD_B).ledger.find('k1')).toBeUndefined();
    expect(depsFor(GUILD_B).ledger.countSince('message', 0)).toBe(0);
  });

  it('countSince delegates: dry runs and done rows count, failed rows do not', () => {
    const deps = depsFor(GUILD_A);
    deps.ledger.claim({
      actionId: 'act-dry',
      idempotencyKey: 'k-dry',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'h-dry',
      tokenId: TOKEN_ID,
      now: clock,
      dryRun: true,
    });
    deps.ledger.claim({
      actionId: 'act-done',
      idempotencyKey: 'k-done',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'h-done',
      tokenId: TOKEN_ID,
      now: clock,
      dryRun: false,
    });
    deps.ledger.claim({
      actionId: 'act-failed',
      idempotencyKey: 'k-failed',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'h-failed',
      tokenId: TOKEN_ID,
      now: clock,
      dryRun: false,
    });
    deps.ledger.complete('act-done', { status: 'done', resultMessageId: MESSAGE_ID, now: clock });
    deps.ledger.complete('act-failed', { status: 'failed', now: clock });
    expect(deps.ledger.countSince('message', 0)).toBe(2);
  });

  it('recentSameContent delegates to the ledger window', () => {
    const deps = depsFor(GUILD_A);
    deps.ledger.claim({
      actionId: 'act-1',
      idempotencyKey: 'k1',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'hash-1',
      tokenId: TOKEN_ID,
      targetChannelId: CHANNEL,
      now: clock,
      dryRun: false,
    });
    expect(deps.ledger.recentSameContent('hash-1', CHANNEL, clock - 60_000)).toBe(true);
    expect(deps.ledger.recentSameContent('hash-1', PARENT, clock - 60_000)).toBe(false);
    expect(deps.ledger.recentSameContent('hash-1', undefined, clock - 60_000)).toBe(false);
  });

  it('complete stores the result ids and the undo payload', () => {
    const deps = depsFor(GUILD_A);
    deps.ledger.claim({
      actionId: 'act-1',
      idempotencyKey: 'k1',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'hash-1',
      tokenId: TOKEN_ID,
      now: clock,
      dryRun: false,
    });
    deps.ledger.complete('act-1', {
      status: 'done',
      resultMessageId: MESSAGE_ID,
      undo: { content: 'previous text' },
      now: clock,
    });
    expect(deps.ledger.find('k1')).toMatchObject({ resultMessageId: MESSAGE_ID });
    const stored = mcpActionsRepo.findActionById(t.scopes.forGuild(GUILD_A), 'act-1');
    expect(stored?.undoJson).toContain('previous text');
  });

  it('newActionId mints a fresh id per call', () => {
    const deps = depsFor(GUILD_A);
    const first = deps.newActionId();
    const second = deps.newActionId();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('capFor falls back to the defaults without a store', () => {
    const deps = depsFor(GUILD_A);
    expect(deps.capFor('message')).toBe(MCP_ACTION_CAPS.message);
    expect(deps.capFor('edit')).toBe(MCP_ACTION_CAPS.edit);
    expect(deps.capFor('member_role')).toBe(MCP_ACTION_CAPS.member_role);
    expect(deps.capFor('structure')).toBe(MCP_ACTION_CAPS.structure);
    expect(deps.capFor('pin_react')).toBe(MCP_ACTION_CAPS.pin_react);
  });

  it('capFor reads the live setting on every call', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger: silentLogger });
    const live = mcpActionDepsFor(
      { ...env(), instanceSettings: store },
      GUILD_A,
      { clientId: CLIENT_ID, tokenId: TOKEN_ID },
    );
    expect(live.capFor('message')).toBe(300);
    expect(store.set('mcp.cap.message', 2, 'owner-acct', clock).ok).toBe(true);
    expect(live.capFor('message')).toBe(2);
    expect(store.set('mcp.cap.message', 5, 'owner-acct', clock).ok).toBe(true);
    expect(live.capFor('message')).toBe(5);
  });
});

describe('mcpActionDepsFor audit', () => {
  const CONTENT = 'picnic-probe-audit-content-that-must-never-persist-zz9';

  const lastSentAudit = (guildId: GuildId) => {
    const trail = effectRepo.tailAudit(t.scopes.forGuild(guildId), { limit: 10 });
    const audit = trail.find((entry) => entry.action === 'mcp.message.sent');
    if (audit === undefined) throw new Error('expected an mcp.message.sent audit row');
    return { audit, after: JSON.parse(audit.after ?? '{}') as Record<string, unknown>, trail };
  };

  it('a done send audits mcp.message.sent with ids, outcome and actionId, never content', () => {
    const deps = depsFor(GUILD_A);
    deps.audit.record({
      kind: 'message.send',
      actionId: 'act-1',
      outcome: 'done',
      targetChannelId: CHANNEL,
      resultMessageId: MESSAGE_ID,
      tokenId: TOKEN_ID,
      dryRun: false,
      atMs: clock,
    });
    const { audit, after, trail } = lastSentAudit(GUILD_A);
    expect(audit.actorType).toBe('mcp_operator');
    expect(audit.actorId).toBe(TOKEN_ID);
    expect(audit.via).toBe('http');
    expect(audit.subjectType).toBe('channel');
    expect(audit.subjectId).toBe(CHANNEL);
    expect(after['clientId']).toBe(CLIENT_ID);
    expect(after['tokenId']).toBe(TOKEN_ID);
    expect(after['outcome']).toBe('sent');
    expect(after['messageId']).toBe(MESSAGE_ID);
    expect(after['actionId']).toBe('act-1');
    expect(after).not.toHaveProperty('authorization');
    expect(JSON.stringify(trail)).not.toContain(CONTENT);
  });

  it('a derived grant audits the granting channel', () => {
    const deps = depsFor(GUILD_A, PARENT);
    deps.audit.record({
      kind: 'message.send',
      actionId: 'act-1',
      outcome: 'done',
      targetChannelId: CHANNEL,
      resultMessageId: MESSAGE_ID,
      tokenId: TOKEN_ID,
      dryRun: false,
      atMs: clock,
    });
    const { after } = lastSentAudit(GUILD_A);
    expect(after['authorization']).toBe('derived');
    expect(after['grantedByChannelId']).toBe(PARENT);
  });

  it('a failed attempt audits the failure without claiming anything was posted', () => {
    const deps = depsFor(GUILD_A);
    deps.audit.record({
      kind: 'message.send',
      actionId: 'act-1',
      outcome: 'failed',
      targetChannelId: CHANNEL,
      tokenId: TOKEN_ID,
      dryRun: false,
      atMs: clock,
    });
    const { after } = lastSentAudit(GUILD_A);
    expect(after['outcome']).toBe('failed');
    expect(after).not.toHaveProperty('messageId');
  });

  it('audit rows are guild-scoped', () => {
    depsFor(GUILD_A).audit.record({
      kind: 'message.send',
      actionId: 'act-1',
      outcome: 'done',
      targetChannelId: CHANNEL,
      resultMessageId: MESSAGE_ID,
      tokenId: TOKEN_ID,
      dryRun: false,
      atMs: clock,
    });
    const trailB = effectRepo.tailAudit(t.scopes.forGuild(GUILD_B), { limit: 10 });
    expect(trailB.find((entry) => entry.action === 'mcp.message.sent')).toBeUndefined();
  });
});
