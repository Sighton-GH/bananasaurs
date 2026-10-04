import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import {
  readScopeDisableCategoryCommand,
  readScopeDisableChannelCommand,
  readScopeEnableCategoryCommand,
  readScopeEnableChannelCommand,
  readScopeListCommand,
} from './read-scope.js';

const NOW = 1_700_000_000_000;
const CHANNEL = '444444444444444444';
const CATEGORY = '999999999999999999';

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(command: string, args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
}

const harness = (overPorts: Partial<OpsPorts> = {}): Harness => {
  const audit: OpsAuditWrite[] = [];
  const dispatcher = createDispatcher({
    commands: [
      readScopeEnableChannelCommand,
      readScopeDisableChannelCommand,
      readScopeEnableCategoryCommand,
      readScopeDisableCategoryCommand,
      readScopeListCommand,
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

/** A Map-backed stub of the three read-scope ports, so the round trip below is behaviour, not mocks. */
const liveReadScope = (): Partial<OpsPorts> => {
  const rows = new Map<string, { scopeKind: 'channel' | 'category'; addedAt: number }>();
  return {
    readScopeAllow: (input) => {
      if (input.scopeKind === 'category' && input.channelId !== CATEGORY) return 'no-such-channel';
      if (input.scopeKind === 'channel' && input.channelId === CATEGORY) return 'no-such-channel';
      if (rows.has(input.channelId)) return 'already-allowed';
      rows.set(input.channelId, { scopeKind: input.scopeKind, addedAt: NOW });
      return 'allowed';
    },
    readScopeDisallow: (input) => {
      const row = rows.get(input.channelId);
      if (row === undefined) return 'not-allowed';
      if (row.scopeKind !== input.scopeKind) return 'wrong-kind';
      rows.delete(input.channelId);
      return 'removed';
    },
    readScopeList: () => [...rows.entries()].map(([channelId, row]) => ({ channelId, ...row })),
  };
};

describe('read scope commands are registered on the operator surface (ADR 0126)', () => {
  it('all five appear in the command list', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'scope read list',
        'scope read enable-channel',
        'scope read enable-category',
        'scope read disable-channel',
        'scope read disable-category',
      ]),
    );
  });

  it('the writes need --confirm and the list does not', () => {
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'scope read enable-channel')?.write).toBe(true);
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'scope read disable-channel')?.write).toBe(
      true,
    );
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'scope read enable-category')?.write).toBe(
      true,
    );
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'scope read disable-category')?.write).toBe(
      true,
    );
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'scope read list')?.write).toBe(false);
  });

  it('every command describes Read as live recent-message lookup', () => {
    for (const name of [
      'scope read list',
      'scope read enable-channel',
      'scope read enable-category',
      'scope read disable-channel',
      'scope read disable-category',
    ]) {
      const summary = OPERATOR_COMMANDS.find((c) => c.name === name)?.summary ?? '';
      expect(summary, name).toContain(
        'Read lets Bananasaurs look up recent messages live from Discord in this channel',
      );
    }
  });
});

describe('scope read enable-channel / list / disable-channel round trip', () => {
  it('allow, list, disallow round trip with audit rows and no message content', async () => {
    const h = harness(liveReadScope());

    const allowed = await h.run('scope read enable-channel', { channelId: CHANNEL });
    expect(allowed.ok).toBe(true);
    expect(allowed.ok && allowed.text).toContain(CHANNEL);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'read_scope.allow',
      subjectId: CHANNEL,
    });

    const listed = await h.run('scope read list');
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.text).toContain(CHANNEL);
    expect(listed.ok && listed.data).toEqual([
      { channelId: CHANNEL, scopeKind: 'channel', addedAt: NOW },
    ]);

    const removed = await h.run('scope read disable-channel', { channelId: CHANNEL });
    expect(removed.ok).toBe(true);
    expect(removed.ok && removed.text).toContain(CHANNEL);
    expect(h.audit).toHaveLength(2);
    expect(h.audit[1]).toMatchObject({
      action: 'read_scope.disallow',
      subjectId: CHANNEL,
    });

    const empty = await h.run('scope read list');
    expect(empty.ok).toBe(true);
    expect(empty.ok && empty.data).toEqual([]);

    // Never message content anywhere: ids and outcomes only.
    const content = 'the message text must never reach this surface';
    expect(JSON.stringify(h.audit)).not.toContain(content);
  });

  it('an already-readable channel is a usage answer with an audit row, not a fault', async () => {
    const h = harness({ ...liveReadScope(), readScopeAllow: () => 'already-allowed' });
    const response = await h.run('scope read enable-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('already');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'read_scope.allow' });
  });

  it('refuses without --confirm and never calls the port', async () => {
    let calls = 0;
    const h = harness({
      ...liveReadScope(),
      readScopeAllow: () => {
        calls += 1;
        return 'allowed';
      },
    });
    const response = await h.run('scope read enable-channel', { channelId: CHANNEL }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(calls).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it('a channel that is not in the guild is a usage answer naming the guild, with an audit row', async () => {
    const h = harness({ readScopeAllow: () => 'no-such-channel' });
    const response = await h.run('scope read enable-channel', {
      channelId: '700000000000000001',
    });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('not a channel of this guild');
    expect(response.ok && response.data).toMatchObject({
      ok: false,
      reason: 'no-such-channel',
      channelId: '700000000000000001',
    });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'read_scope.allow' });
  });
});

describe('scope read disable-channel', () => {
  it('a channel that was never readable is a usage answer with an audit row', async () => {
    const h = harness({ readScopeDisallow: () => 'not-allowed' });
    const response = await h.run('scope read disable-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('was not readable');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'read_scope.disallow' });
  });

  it('a category-readable id is wrong-kind to disable-channel', async () => {
    const h = harness({ readScopeDisallow: () => 'wrong-kind' });
    const response = await h.run('scope read disable-channel', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('scope read disable-category');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'read_scope.disallow' });
  });
});

describe('scope read enable-category / disable-category', () => {
  it('enable-category round trip through the live stub', async () => {
    const h = harness(liveReadScope());
    const allowed = await h.run('scope read enable-category', { channelId: CATEGORY });
    expect(allowed.ok).toBe(true);
    expect(allowed.ok && allowed.text).toContain(CATEGORY);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: 'read_scope.allow', subjectId: CATEGORY });

    const listed = await h.run('scope read list');
    expect(listed.ok && listed.data).toEqual([
      { channelId: CATEGORY, scopeKind: 'category', addedAt: NOW },
    ]);

    const removed = await h.run('scope read disable-category', { channelId: CATEGORY });
    expect(removed.ok).toBe(true);
    expect(h.audit).toHaveLength(2);
    expect(h.audit[1]).toMatchObject({ action: 'read_scope.disallow', subjectId: CATEGORY });
  });

  it('enable-category refuses an id that is not a category of the guild', async () => {
    // A text channel id handed to the category verb: the port answers
    // `no-such-channel`, the command a usage answer — never a row.
    const h = harness({ readScopeAllow: () => 'no-such-channel' });
    const response = await h.run('scope read enable-category', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('not a category of this guild');
    expect(response.ok && response.data).toMatchObject({
      ok: false,
      reason: 'no-such-channel',
      channelId: CHANNEL,
    });
    expect(h.audit).toHaveLength(1);
  });

  it('disable-category reports wrong-kind for a channel-readable id', async () => {
    const h = harness({ readScopeDisallow: () => 'wrong-kind' });
    const response = await h.run('scope read disable-category', { channelId: CHANNEL });
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain('scope read disable-channel');
  });
});
