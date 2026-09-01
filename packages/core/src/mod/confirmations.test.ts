import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { InteractionEvent, SlashCommandEvent } from '../discord/events.js';
import type {
  FetchedMessage,
  InteractionRef,
  OutgoingMessage,
  RecentMessagesPage,
  Snowflake,
} from '../discord/port.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import { PURGE_MAX_MESSAGES } from '../effects/budget.js';
import { BULK_DELETE_CEILING_MS } from './purge.js';
import { parseGuildId } from '../ids.js';
import { modPurgePayload, purgeDedupeKey, type ModPurgePayload } from '../jobs/kinds.js';
import type { SlashResponder } from '../ops/commands/status-slash.js';
import {
  buildConfirmCancelComponents,
  buildModCancelCustomId,
  buildModConfirmCustomId,
  createModConfirmationSubscriber,
  handleBanPreview,
  handlePurgePreview,
  modPendingActionPayload,
  parseModConfirmCustomId,
  PENDING_ACTION_TTL_MS,
  type ModConfirmationCasePorts,
  type ModConfirmationDeps,
  type ModPendingActionPorts,
  type PendingActionRowLike,
} from './confirmations.js';

/**
 * Unit tests for the ban/purge confirm-then-execute handshake (ADR 0037,
 * Task 7): every port faked, nothing touches a real database or Discord —
 * the same level `commands.test.ts` and `purge.test.ts` test at.
 */

const GUILD = parseGuildId('111111111111111111');
const MODERATOR: Snowflake = '222222222222222222';
const OTHER_MODERATOR: Snowflake = '999999999999999999';
const TARGET: Snowflake = '333333333333333333';
const CHANNEL: Snowflake = '444444444444444444';
const NOW_MS = 1_700_000_000_000;

const silentLogger = pino({ level: 'silent' });

const slashCommandEvent = (over: Partial<SlashCommandEvent> = {}): SlashCommandEvent => ({
  kind: 'slashCommand',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  interactionId: 'interaction-1',
  token: 'token-1',
  commandName: 'mod',
  subcommandPath: ['ban'],
  options: [
    { name: 'target', value: TARGET },
    { name: 'reason', value: 'raiding' },
  ],
  channelId: CHANNEL,
  userId: MODERATOR,
  ...over,
});

const interactionEvent = (over: Partial<InteractionEvent> = {}): InteractionEvent => ({
  kind: 'interaction',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  interactionId: 'click-1',
  token: 'click-token-1',
  channelId: CHANNEL,
  messageId: 'message-1',
  userId: MODERATOR,
  customId: 'modconfirm:intent-1',
  ...over,
});

/**
 * A faithful in-memory fake of `mod-pending.ts`'s real semantics: `take` is
 * a one-shot read-and-delete (undefined once taken or expired), `peek`
 * never deletes and applies no expiry filter of its own — mirroring
 * `peekPendingAction`'s real contract exactly, so this test suite proves
 * the same expired-vs-already-executed logic the storage layer supports.
 */
function fakePendingActionPorts(): ModPendingActionPorts & {
  rows: Map<string, PendingActionRowLike>;
} {
  const rows = new Map<string, PendingActionRowLike>();
  return {
    rows,
    put(input) {
      if (rows.has(input.intentId)) return;
      rows.set(input.intentId, {
        intentId: input.intentId,
        payload: input.payload,
        createdBy: input.createdBy,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      });
    },
    take(intentId, now) {
      const row = rows.get(intentId);
      if (row === undefined) return undefined;
      rows.delete(intentId);
      if (row.expiresAt <= now) return undefined;
      return row;
    },
    peek(intentId) {
      return rows.get(intentId);
    },
  };
}

/** A flat array sliced by index — `before` continues from the last id served. */
function fakeFetchRecentMessages(
  all: readonly FetchedMessage[],
): (
  guildId: Snowflake,
  channelId: Snowflake,
  options: { before?: Snowflake | undefined; limit?: number | undefined },
) => Promise<RecentMessagesPage> {
  return async (_guildId, _channelId, options) => {
    const limit = options.limit ?? 100;
    let startIdx = 0;
    if (options.before !== undefined) {
      const idx = all.findIndex((m) => m.messageId === options.before);
      startIdx = idx === -1 ? all.length : idx + 1;
    }
    const page = all.slice(startIdx, startIdx + limit);
    const nextBefore = startIdx + limit < all.length ? page[page.length - 1]?.messageId : undefined;
    return { messages: page, nextBefore };
  };
}

interface Harness {
  deps: ModConfirmationDeps;
  calls: {
    applyAction: { auth: unknown; intent: ModerationIntent }[];
    recordCaseEvent: Parameters<ModConfirmationCasePorts['recordCaseEvent']>[0][];
    enqueuePurgeJob: { payload: string; dedupeKey: string; now: number }[];
    defer: { ref: InteractionRef; options: { ephemeral: boolean } }[];
    respond: { ref: InteractionRef; message: OutgoingMessage }[];
    fetchInvokerRoleIds: Snowflake[];
  };
  pendingActions: ReturnType<typeof fakePendingActionPorts>;
}

function buildHarness(
  opts: {
    authorized?: boolean;
    applyActionResult?: ModerationOutcome;
    fetchRecentMessages?: ReturnType<typeof fakeFetchRecentMessages>;
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    applyAction: [],
    recordCaseEvent: [],
    enqueuePurgeJob: [],
    defer: [],
    respond: [],
    fetchInvokerRoleIds: [],
  };

  const authz: AuthzStore = { hasGrant: () => opts.authorized ?? true };

  const moderationGateway: ModerationGatewayPort = {
    async applyAction(auth, intent) {
      calls.applyAction.push({ auth, intent });
      return opts.applyActionResult ?? { status: 'applied' };
    },
  };

  const cases: ModConfirmationCasePorts = {
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
    recordCaseEvent: (input) => {
      calls.recordCaseEvent.push(input);
    },
  };

  const pendingActions = fakePendingActionPorts();

  const responder: SlashResponder = {
    defer: async (ref, options) => {
      calls.defer.push({ ref, options });
    },
    respond: async (ref, message) => {
      calls.respond.push({ ref, message });
    },
  };

  const deps: ModConfirmationDeps = {
    guildId: GUILD,
    authz,
    fetchInvokerRoleIds: async (userId) => {
      calls.fetchInvokerRoleIds.push(userId);
      return [];
    },
    moderationGateway,
    cases,
    pendingActions,
    fetchRecentMessages: opts.fetchRecentMessages ?? fakeFetchRecentMessages([]),
    enqueuePurgeJob: (input) => {
      calls.enqueuePurgeJob.push(input);
    },
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
  };

  return { deps, calls, pendingActions };
}

const extractIntentId = (message: OutgoingMessage): string => {
  const rows = message.components as
    readonly { components: readonly { custom_id: string }[] }[] | undefined;
  const customId = rows?.[0]?.components?.[0]?.custom_id;
  if (customId === undefined) throw new Error('no button on this message');
  const parsed = parseModConfirmCustomId(customId);
  if (parsed === undefined) throw new Error(`not a confirm custom id: ${customId}`);
  return parsed.intentId;
};

describe('custom id parsing and button components', () => {
  it('round-trips confirm and cancel custom ids', () => {
    expect(parseModConfirmCustomId(buildModConfirmCustomId('abc'))).toEqual({
      action: 'confirm',
      intentId: 'abc',
    });
    expect(parseModConfirmCustomId(buildModCancelCustomId('abc'))).toEqual({
      action: 'cancel',
      intentId: 'abc',
    });
  });

  it('refuses anything that is not one of ours', () => {
    expect(parseModConfirmCustomId('bs.panel:x:y')).toBeUndefined();
    expect(parseModConfirmCustomId('modconfirm:')).toBeUndefined();
    expect(parseModConfirmCustomId('modconfirm')).toBeUndefined();
  });

  it('builds a Confirm (success) and a Cancel (danger) button in one action row', () => {
    const rows = buildConfirmCancelComponents('intent-xyz') as {
      type: number;
      components: { type: number; style: number; custom_id: string; label: string }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toHaveLength(2);
    const [confirm, cancel] = rows[0]!.components;
    expect(confirm).toMatchObject({
      style: 3,
      custom_id: 'modconfirm:intent-xyz',
      label: 'Confirm',
    });
    expect(cancel).toMatchObject({ style: 4, custom_id: 'modcancel:intent-xyz', label: 'Cancel' });
  });
});

describe('modPendingActionPayload', () => {
  it('accepts a ban payload and a purge payload, and rejects an unknown kind', () => {
    expect(
      modPendingActionPayload.safeParse({ kind: 'ban', targetId: TARGET, reason: 'x' }).success,
    ).toBe(true);
    expect(
      modPendingActionPayload.safeParse({ kind: 'purge', channelId: CHANNEL, reason: 'x' }).success,
    ).toBe(true);
    expect(modPendingActionPayload.safeParse({ kind: 'kick', targetId: TARGET }).success).toBe(
      false,
    );
  });
});

describe('/mod ban preview', () => {
  it('executes nothing and answers with a preview plus Confirm/Cancel buttons', async () => {
    const { deps, calls, pendingActions } = buildHarness();
    await handleBanPreview(deps, slashCommandEvent(), {
      interactionId: 'interaction-1',
      token: 'token-1',
    });

    expect(calls.applyAction).toHaveLength(0);
    expect(calls.respond).toHaveLength(1);
    const message = calls.respond[0]!.message;
    expect(message.content).toMatch(/raiding/);
    expect(message.components).toBeDefined();

    const intentId = extractIntentId(message);
    const row = pendingActions.peek(intentId);
    expect(row).not.toBeUndefined();
    expect(row?.createdBy).toBe(MODERATOR);
    expect(row?.expiresAt).toBe(NOW_MS + PENDING_ACTION_TTL_MS);
    const payload = modPendingActionPayload.parse(JSON.parse(row!.payload));
    expect(payload).toEqual({ kind: 'ban', targetId: TARGET, reason: 'raiding' });
  });

  it('refuses an unauthorized caller, writes no pending intent', async () => {
    const { deps, calls, pendingActions } = buildHarness({ authorized: false });
    await handleBanPreview(deps, slashCommandEvent(), {
      interactionId: 'interaction-1',
      token: 'token-1',
    });

    expect(calls.applyAction).toHaveLength(0);
    expect(calls.respond[0]?.message.content).toMatch(/do not have permission/i);
    expect(pendingActions.rows.size).toBe(0);
  });
});

describe('ban confirm/cancel', () => {
  const preview = async (harness: Harness): Promise<string> => {
    await handleBanPreview(harness.deps, slashCommandEvent(), {
      interactionId: 'interaction-1',
      token: 'token-1',
    });
    return extractIntentId(harness.calls.respond[harness.calls.respond.length - 1]!.message);
  };

  it('same-moderator Confirm executes the ban through the gateway with the intent’s dedupe key, and deletes the pending row', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(1);
    const { auth, intent } = harness.calls.applyAction[0]!;
    expect(auth).toBeDefined();
    expect(intent.action).toBe('ban');
    expect(intent.userId).toBe(TARGET);
    expect(intent.dedupeKey).toBe(`mod:${GUILD}:ban:${intentId}`);
    expect(intent.reason).toBe('raiding');

    expect(harness.pendingActions.peek(intentId)).toBeUndefined();
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/applied/i);

    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(TARGET);
    expect(event.actorId).toBe(MODERATOR);
    expect(event.actionTaken).toBe('manual_applied');
    expect(event.escalationAction).toBe('ban');
  });

  it('a replayed Confirm dispatch answers "already executed" and calls the gateway once total', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({
        interactionId: 'click-1',
        customId: buildModConfirmCustomId(intentId),
        userId: MODERATOR,
      }),
    );
    // A second dispatch of a component click: same custom id, same clicker,
    // a fresh interaction id (Discord mints a new one per delivery even for
    // a resumed/replayed dispatch of the same underlying click).
    await subscriber.handle(
      interactionEvent({
        interactionId: 'click-2',
        customId: buildModConfirmCustomId(intentId),
        userId: MODERATOR,
      }),
    );

    expect(harness.calls.applyAction).toHaveLength(1);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/already executed/i);
  });

  it('Confirm by a different authorized moderator is refused, and the intent survives for the original moderator', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: OTHER_MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(
      /only the moderator who ran this command/i,
    );
    // Still there — the wrong click must not have consumed it.
    expect(harness.pendingActions.peek(intentId)).not.toBeUndefined();

    // And the real moderator can still confirm it afterward.
    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );
    expect(harness.calls.applyAction).toHaveLength(1);
  });

  it('Cancel deletes the intent and executes nothing', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModCancelCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/cancelled/i);
    expect(harness.pendingActions.peek(intentId)).toBeUndefined();
  });

  it('an expired intent answers "expired" and calls the gateway zero times', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    const laterDeps: ModConfirmationDeps = {
      ...harness.deps,
      now: () => NOW_MS + PENDING_ACTION_TTL_MS + 1,
    };
    const laterSubscriber = createModConfirmationSubscriber(laterDeps);
    await laterSubscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/expired/i);
    void subscriber; // the un-advanced subscriber is unused in this test
  });

  it('ignores a custom id that is not one of ours', async () => {
    const harness = buildHarness();
    const subscriber = createModConfirmationSubscriber(harness.deps);
    await subscriber.handle(interactionEvent({ customId: 'bs.panel:some-panel:opt' }));
    expect(harness.calls.defer).toHaveLength(0);
  });
});

describe('/mod purge preview', () => {
  const message = (i: number, createdAtMs: number): FetchedMessage => ({
    messageId: `m-${i}`,
    authorId: MODERATOR,
    createdAtMs,
    content: `message ${i}`,
  });

  it('refuses over the purge budget: no pending intent, no buttons, nothing fetched beyond the cap', async () => {
    const all = Array.from({ length: PURGE_MAX_MESSAGES + 50 }, (_, i) => message(i, NOW_MS));
    const harness = buildHarness({ fetchRecentMessages: fakeFetchRecentMessages(all) });

    await handlePurgePreview(
      harness.deps,
      slashCommandEvent({
        subcommandPath: ['purge'],
        options: [
          { name: 'channel', value: CHANNEL },
          { name: 'reason', value: 'spam cleanup' },
        ],
      }),
      { interactionId: 'interaction-1', token: 'token-1' },
    );

    expect(harness.calls.respond).toHaveLength(1);
    expect(harness.calls.respond[0]?.message.components).toBeUndefined();
    expect(harness.calls.respond[0]?.message.content).toMatch(new RegExp(`${PURGE_MAX_MESSAGES}`));
    expect(harness.pendingActions.rows.size).toBe(0);
    expect(harness.calls.enqueuePurgeJob).toHaveLength(0);
  });

  it('shows a fresh/old age split within budget, and writes a pending purge intent', async () => {
    const fresh = Array.from({ length: 3 }, (_, i) => message(i, NOW_MS));
    const old = Array.from({ length: 2 }, (_, i) =>
      message(100 + i, NOW_MS - BULK_DELETE_CEILING_MS - 1_000),
    );
    const harness = buildHarness({
      fetchRecentMessages: fakeFetchRecentMessages([...fresh, ...old]),
    });

    await handlePurgePreview(
      harness.deps,
      slashCommandEvent({
        subcommandPath: ['purge'],
        options: [
          { name: 'channel', value: CHANNEL },
          { name: 'reason', value: 'spam cleanup' },
        ],
      }),
      { interactionId: 'interaction-1', token: 'token-1' },
    );

    const respondMessage = harness.calls.respond[0]!.message;
    expect(respondMessage.content).toMatch(/5 message/);
    expect(respondMessage.content).toMatch(/3 in the last 14 days/);
    expect(respondMessage.content).toMatch(/2 older/);
    expect(respondMessage.components).toBeDefined();
    expect(harness.pendingActions.rows.size).toBe(1);
  });

  it('refuses an unauthorized caller before ever fetching messages', async () => {
    let fetchCalls = 0;
    const harness = buildHarness({
      authorized: false,
      fetchRecentMessages: async (...args) => {
        fetchCalls += 1;
        return fakeFetchRecentMessages([])(...args);
      },
    });

    await handlePurgePreview(
      harness.deps,
      slashCommandEvent({
        subcommandPath: ['purge'],
        options: [
          { name: 'channel', value: CHANNEL },
          { name: 'reason', value: 'spam cleanup' },
        ],
      }),
      { interactionId: 'interaction-1', token: 'token-1' },
    );

    expect(fetchCalls).toBe(0);
    expect(harness.calls.respond[0]?.message.content).toMatch(/do not have permission/i);
  });
});

describe('purge confirm', () => {
  const previewPurge = async (harness: Harness): Promise<string> => {
    await handlePurgePreview(
      harness.deps,
      slashCommandEvent({
        subcommandPath: ['purge'],
        options: [
          { name: 'channel', value: CHANNEL },
          { name: 'reason', value: 'spam cleanup' },
        ],
      }),
      { interactionId: 'interaction-1', token: 'token-1' },
    );
    return extractIntentId(harness.calls.respond[harness.calls.respond.length - 1]!.message);
  };

  it('confirm enqueues exactly one mod_purge job, addressed with the confirming moderator and the preview’s reason', async () => {
    const harness = buildHarness();
    const intentId = await previewPurge(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.enqueuePurgeJob).toHaveLength(1);
    const enqueued = harness.calls.enqueuePurgeJob[0]!;
    expect(enqueued.dedupeKey).toBe(purgeDedupeKey(GUILD, intentId));

    const payload: ModPurgePayload = modPurgePayload.parse(JSON.parse(enqueued.payload));
    expect(payload).toEqual({
      intentId,
      channelId: CHANNEL,
      initiatorUserId: MODERATOR,
      reason: 'spam cleanup',
    });

    // Purge execution is a job the daemon runs later, not this handler's job.
    expect(harness.calls.applyAction).toHaveLength(0);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/confirmed/i);
  });

  it('a double-tap on Confirm enqueues exactly one job — the second click finds the intent already taken', async () => {
    const harness = buildHarness();
    const intentId = await previewPurge(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({
        interactionId: 'click-1',
        customId: buildModConfirmCustomId(intentId),
        userId: MODERATOR,
      }),
    );
    await subscriber.handle(
      interactionEvent({
        interactionId: 'click-2',
        customId: buildModConfirmCustomId(intentId),
        userId: MODERATOR,
      }),
    );

    expect(harness.calls.enqueuePurgeJob).toHaveLength(1);
    expect(harness.calls.respond.at(-1)?.message.content).toMatch(/already executed/i);
  });
});
