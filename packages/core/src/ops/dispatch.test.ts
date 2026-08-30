import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseGuildId } from '../ids.js';
import {
  createDispatcher,
  defineCommand,
  type OpsGuildContext,
  type RegisteredCommand,
} from './dispatch.js';
import type { OpsAuditWrite } from './ports.js';
import { fakeOpsInstance, fakeOpsPorts } from './test-fixtures.js';

const GUILD_A = parseGuildId('1000000000000000001');
const GUILD_B = parseGuildId('1000000000000000002');

const contextFor = (guildId: string): OpsGuildContext | undefined => {
  if (guildId !== GUILD_A && guildId !== GUILD_B) return undefined;
  return {
    guildId: parseGuildId(guildId),
    now: () => 1_700_000_000_000,
    // Stubbed here rather than left to throw: from slice 13b the dispatcher
    // records an audit row after every successful write, so a fake that
    // refuses would make every write test fail for the wrong reason.
    ports: fakeOpsPorts({ recordAudit: () => undefined }),
  };
};

/** A read command that reports the guild it ran under, so scope is observable. */
const whoami = defineCommand<Record<string, never>>({
  name: 'whoami',
  write: false,
  summary: 'reports the guild and actor',
  args: z.object({}),
  run: (ctx) => ({
    text: `${ctx.guildId} ${ctx.actor.type} ${ctx.actor.unixUserClaimed ?? '-'}`,
    data: { guildId: ctx.guildId, unixUserClaimed: ctx.actor.unixUserClaimed ?? null },
  }),
});

const touched: string[] = [];
const touch = defineCommand<{ note: string }>({
  name: 'touch',
  write: true,
  summary: 'a write command',
  args: z.object({ note: z.string().min(1) }),
  run: (ctx, args) => {
    touched.push(`${ctx.guildId}:${args.note}`);
    return {
      text: 'touched',
      data: { note: args.note },
      audit: { action: 'touch.done', subjectType: 'guild' },
    };
  },
});

const boom = defineCommand<Record<string, never>>({
  name: 'boom',
  write: false,
  summary: 'throws',
  args: z.object({}),
  run: () => {
    throw new Error('the underlying thing broke');
  },
});

const build = (guildIds: readonly string[] = [GUILD_A, GUILD_B]) =>
  createDispatcher({ commands: [whoami, touch, boom], guildIds, contextFor, instance });

const instance = fakeOpsInstance();

const request = (over: Record<string, unknown>): unknown => ({ v: 1, ...over });

describe('the ops dispatcher', () => {
  describe('guild scope', () => {
    it('runs the command under the guild the request names', async () => {
      const res = await build().dispatch(request({ command: 'whoami', guildId: GUILD_B }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual({ guildId: GUILD_B, unixUserClaimed: null });
    });

    it('refuses a guild that is not allowlisted, rather than defaulting to one', async () => {
      const res = await build().dispatch(
        request({ command: 'whoami', guildId: '1000000000000000009' }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('unknown-guild');
      expect(res.message).toContain('1000000000000000009');
    });

    it('defaults to the sole allowlisted guild when --guild is omitted', async () => {
      const res = await build([GUILD_A]).dispatch(request({ command: 'whoami' }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual({ guildId: GUILD_A, unixUserClaimed: null });
    });

    it('refuses to guess when --guild is omitted and more than one is allowlisted', async () => {
      const res = await build().dispatch(request({ command: 'whoami' }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('unknown-guild');
      expect(res.message).toMatch(/--guild/);
    });

    it('refuses an allowlisted guild that has no runtime context', async () => {
      const res = await createDispatcher({
        commands: [whoami],
        guildIds: ['1000000000000000007'],
        contextFor,
        instance,
      }).dispatch(request({ command: 'whoami', guildId: '1000000000000000007' }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('unknown-guild');
    });
  });

  describe('the confirm gate', () => {
    it('refuses a write without confirm, and does not run it', async () => {
      touched.length = 0;
      const res = await build().dispatch(
        request({ command: 'touch', guildId: GUILD_A, args: { note: 'x' } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('needs-confirm');
      expect(touched).toEqual([]);
    });

    it('runs a write with confirm', async () => {
      touched.length = 0;
      const res = await build().dispatch(
        request({ command: 'touch', guildId: GUILD_A, args: { note: 'x' }, confirm: true }),
      );
      expect(res.ok).toBe(true);
      expect(touched).toEqual([`${GUILD_A}:x`]);
    });

    it('does not require confirm for a read command', async () => {
      const res = await build().dispatch(request({ command: 'whoami', guildId: GUILD_A }));
      expect(res.ok).toBe(true);
    });

    it('checks confirm before validating arguments, so a refusal never runs anything', async () => {
      touched.length = 0;
      const res = await build().dispatch(
        request({ command: 'touch', guildId: GUILD_A, args: { note: '' } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('needs-confirm');
      expect(touched).toEqual([]);
    });
  });

  describe('the actor', () => {
    it('carries the claimed unix user through to the command', async () => {
      const res = await build().dispatch(
        request({ command: 'whoami', guildId: GUILD_A, unixUserClaimed: 'bryan' }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual({ guildId: GUILD_A, unixUserClaimed: 'bryan' });
    });

    it('is always operator_cli, whatever the request says', async () => {
      const res = await build().dispatch(
        request({ command: 'whoami', guildId: GUILD_A, actorType: 'owner' }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('operator_cli');
    });
  });

  describe('untrusted input', () => {
    it('rejects a malformed envelope', async () => {
      const res = await build().dispatch({ nope: true });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('bad-request');
    });

    it('rejects an unknown command without running anything', async () => {
      const res = await build().dispatch(request({ command: 'rm-rf', guildId: GUILD_A }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('unknown-command');
    });

    it('rejects arguments the command schema refuses', async () => {
      const res = await build().dispatch(
        request({ command: 'touch', guildId: GUILD_A, args: { note: 42 }, confirm: true }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('bad-request');
      expect(res.message).toContain('note');
    });

    it('rejects a protocol version it does not speak', async () => {
      const res = await build().dispatch({ v: 99, command: 'whoami', guildId: GUILD_A });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('bad-request');
    });
  });

  describe('failures', () => {
    it('turns a thrown error into a failed response rather than crashing the daemon', async () => {
      const res = await build().dispatch(request({ command: 'boom', guildId: GUILD_A }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('failed');
      expect(res.message).toContain('the underlying thing broke');
    });

    it('reports a readonly refusal as its own code, not as a generic failure', async () => {
      class FakeReadonlyError extends Error {
        override readonly name = 'ReadonlyError';
      }
      const refusing = defineCommand<Record<string, never>>({
        name: 'refuse',
        write: true,
        summary: 'refuses',
        args: z.object({}),
        run: (): never => {
          throw new FakeReadonlyError('refusing a write: BANANASAURS_READONLY is set');
        },
      });
      const res = await createDispatcher({
        commands: [refusing],
        guildIds: [GUILD_A],
        contextFor,
        instance,
      }).dispatch(request({ command: 'refuse', confirm: true }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('readonly');
    });
  });

  it('lists its commands, so the CLI does not carry a second copy of the surface', () => {
    expect(build().commandNames()).toEqual(['boom', 'touch', 'whoami']);
  });

  it('awaits an async command before responding', async () => {
    const slow = defineCommand<Record<string, never>>({
      name: 'slow',
      write: false,
      summary: 'async',
      args: z.object({}),
      run: async () => {
        await Promise.resolve();
        return { text: 'done', data: { done: true } };
      },
    });
    const res = await createDispatcher({
      commands: [slow],
      guildIds: [GUILD_A],
      contextFor,
      instance,
    }).dispatch(request({ command: 'slow' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ done: true });
  });

  it('does not let a command name collide silently', () => {
    expect(() =>
      createDispatcher({ commands: [whoami, whoami], guildIds: [GUILD_A], contextFor, instance }),
    ).toThrow(/whoami/);
  });

  it('never lets a rejected promise escape', async () => {
    const rejecting = defineCommand<Record<string, never>>({
      name: 'reject',
      write: false,
      summary: 'rejects',
      args: z.object({}),
      run: () => Promise.reject(new Error('async boom')),
    });
    const onUnhandled = vi.fn();
    process.once('unhandledRejection', onUnhandled);
    const res = await createDispatcher({
      commands: [rejecting],
      guildIds: [GUILD_A],
      contextFor,
      instance,
    }).dispatch(request({ command: 'reject' }));
    process.off('unhandledRejection', onUnhandled);
    expect(res.ok).toBe(false);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe('the audit trail (ADR 0013 §4, docs/19 §6.9)', () => {
  const recorded: OpsAuditWrite[] = [];

  const ports = () =>
    fakeOpsPorts({
      recordAudit: (input) => {
        recorded.push(input);
      },
    });

  const audited = defineCommand<{ note: string }>({
    name: 'audited',
    write: true,
    summary: 'a write that reports what it did',
    args: z.object({ note: z.string() }),
    run: (_ctx, args) => ({
      text: 'done',
      data: null,
      audit: {
        action: 'thing.changed',
        subjectType: 'guild',
        subjectId: 'subject-1',
        before: { note: 'old' },
        after: { note: args.note },
      },
    }),
  });

  const build = (commands = [audited, whoami]) =>
    createDispatcher({
      commands,
      guildIds: [GUILD_A],
      contextFor: (guildId) => ({
        guildId: parseGuildId(guildId),
        now: () => 1_700_000_000_000,
        ports: ports(),
      }),
      instance,
    });

  beforeEach(() => {
    recorded.length = 0;
  });

  it('records one row for a write command that succeeded', async () => {
    const res = await build().dispatch(
      request({ command: 'audited', args: { note: 'new' }, confirm: true, unixUserClaimed: 'bry' }),
    );
    expect(res.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorType: 'operator_cli',
      via: 'ssh',
      actorUnixUserClaimed: 'bry',
      action: 'thing.changed',
      subjectType: 'guild',
      subjectId: 'subject-1',
      before: { note: 'old' },
      after: { note: 'new' },
      at: 1_700_000_000_000,
    });
  });

  it('records the claimed user as a claim, and never an actor id', async () => {
    // ADR 0024: the name is an assertion. It must not be laundered into
    // `actor_id`, which every other actor type fills with a verified identity.
    await build().dispatch(
      request({ command: 'audited', args: { note: 'n' }, confirm: true, unixUserClaimed: 'root' }),
    );
    expect(recorded[0]?.actorId).toBeUndefined();
    expect(recorded[0]?.actorUnixUserClaimed).toBe('root');
  });

  it('records nothing at all for a read command', async () => {
    await build().dispatch(request({ command: 'whoami' }));
    expect(recorded).toEqual([]);
  });

  it('records nothing when a write was refused for want of --confirm', async () => {
    const res = await build().dispatch(request({ command: 'audited', args: { note: 'n' } }));
    expect(res.ok).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('records nothing when the write itself failed', async () => {
    const failing = defineCommand<Record<string, never>>({
      name: 'failing',
      write: true,
      summary: 'fails',
      args: z.object({}),
      run: (): never => {
        throw new Error('nope');
      },
    });
    const res = await build([failing]).dispatch(request({ command: 'failing', confirm: true }));
    expect(res.ok).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('refuses a write command that reported no audit record', async () => {
    // Unreachable through `defineCommand`, whose write branch demands one at
    // compile time. This is the tripwire behind that type, for a
    // `RegisteredCommand` assembled by hand.
    const unaudited: RegisteredCommand = {
      name: 'unaudited',
      write: true,
      summary: 'forgot',
      positional: [],
      flags: [],
      runParsed: () => ({ ok: true, result: { text: 'done', data: null } }),
    };
    const res = await build([unaudited]).dispatch(request({ command: 'unaudited', confirm: true }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('failed');
    expect(res.message).toMatch(/audit/i);
    expect(recorded).toEqual([]);
  });

  it('fails the command when the audit row could not be written', async () => {
    // A write that happened but was not recorded must not report success:
    // the audit trail is the only durable evidence an operator acted.
    const dispatcher = createDispatcher({
      commands: [audited],
      guildIds: [GUILD_A],
      contextFor: (guildId) => ({
        guildId: parseGuildId(guildId),
        now: () => 1,
        ports: fakeOpsPorts({
          recordAudit: () => {
            throw new Error('disk full');
          },
        }),
      }),
      instance,
    });
    const res = await dispatcher.dispatch(
      request({ command: 'audited', args: { note: 'n' }, confirm: true }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('disk full');
  });
});
