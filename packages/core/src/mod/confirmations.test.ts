import { vi, describe, expect, it } from 'vitest';
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
import type {
  DeleteMessageIntent,
  DeleteMessageOutcome,
  ModerationIntent,
  ModerationOutcome,
} from '../effects/moderation-gateway.js';
import { PURGE_MAX_MESSAGES } from '../effects/budget.js';
import { BULK_DELETE_CEILING_MS } from './purge.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import { modPurgePayload, purgeDedupeKey, type ModPurgePayload } from '../jobs/kinds.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import {
  buildModCancelCustomId,
  buildModConfirmCustomId,
  createModConfirmationSubscriber,
  deleteConfirmDedupeKey,
  handleBanPreview,
  handlePurgePreview,
  modPendingActionPayload,
  parseModConfirmCustomId,
  PENDING_ACTION_TTL_MS,
  writeDeleteIntent,
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
    deleteMessage: { auth: unknown; intent: DeleteMessageIntent }[];
    recordCaseEvent: Parameters<ModConfirmationCasePorts['recordCaseEvent']>[0][];
    enqueuePurgeJob: { payload: string; dedupeKey: string; now: number }[];
    defer: { ref: InteractionRef; options: { ephemeral: boolean } }[];
    respond: { ref: InteractionRef; message: OutgoingMessage }[];
    fetchInvokerRoleIds: Snowflake[];
  };
  pendingActions: ReturnType<typeof fakePendingActionPorts>;
  /**
   * Flips the fake `AuthzStore`'s verdict after the harness was built — the
   * fix round's finding 3: a capability can be revoked between preview and
   * confirm, and the confirm path must re-check it rather than inherit the
   * preview's own verdict.
   */
  setAuthorized: (value: boolean) => void;
}

function buildHarness(
  opts: {
    authorized?: boolean;
    applyActionResult?: ModerationOutcome;
    deleteMessageResult?: DeleteMessageOutcome;
    fetchRecentMessages?: ReturnType<typeof fakeFetchRecentMessages>;
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    applyAction: [],
    deleteMessage: [],
    recordCaseEvent: [],
    enqueuePurgeJob: [],
    defer: [],
    respond: [],
    fetchInvokerRoleIds: [],
  };

  let authorized = opts.authorized ?? true;
  const authz: AuthzStore = { hasGrant: () => authorized };

  const moderationGateway: ModerationGatewayPort = {
    async applyAction(auth, intent) {
      calls.applyAction.push({ auth, intent });
      return opts.applyActionResult ?? { status: 'applied' };
    },
    async deleteMessage(auth, intent) {
      calls.deleteMessage.push({ auth, intent });
      return opts.deleteMessageResult ?? { status: 'applied' };
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
    deferUpdate: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    editOriginal: vi.fn(async () => undefined),
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

  return { deps, calls, pendingActions, setAuthorized: (value) => (authorized = value) };
}

const extractIntentId = (message: OutgoingMessage): string => {
  const ids = cardCustomIds(message.components ?? []);
  const customId = ids[0];
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

  it('the ban preview card carries a Confirm and a Cancel custom id', async () => {
    const { deps, calls } = buildHarness();
    await handleBanPreview(deps, slashCommandEvent(), {
      interactionId: 'interaction-1',
      token: 'token-1',
    });
    const message = calls.respond[0]!.message;
    const ids = cardCustomIds(message.components ?? []);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^modconfirm:/);
    expect(ids[1]).toMatch(/^modcancel:/);
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
    expect(message.flags).toBe(32768);
    const previewText = cardTexts(message.components ?? []);
    expect(previewText).toContain(`Ban <@${TARGET}>?`);
    expect(previewText).toContain('raiding');

    const intentId = extractIntentId(message);
    const row = pendingActions.peek(intentId);
    expect(row).not.toBeUndefined();
    expect(row?.createdBy).toBe(MODERATOR);
    expect(row?.expiresAt).toBe(NOW_MS + PENDING_ACTION_TTL_MS);
    const payload = modPendingActionPayload.parse(JSON.parse(row!.payload));
    expect(payload).toEqual({ kind: 'ban', targetId: TARGET, reason: 'raiding' });
  });

  it('refuses an unauthorized caller, writes no pending intent, and records the refusal on the target’s case', async () => {
    const { deps, calls, pendingActions } = buildHarness({ authorized: false });
    await handleBanPreview(deps, slashCommandEvent(), {
      interactionId: 'interaction-1',
      token: 'token-1',
    });

    expect(calls.applyAction).toHaveLength(0);
    expect(cardTexts(calls.respond[0]?.message.components ?? [])).toContain(
      "You can't take moderation actions",
    );
    expect(pendingActions.rows.size).toBe(0);

    // Fix round, finding 4: an unauthorized /mod ban attempt must land in
    // durable case history exactly like an unauthorized /mod kick does
    // (commands.ts's recordDirectRefusal), not only in the log file.
    expect(calls.recordCaseEvent).toHaveLength(1);
    const event = calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(TARGET);
    expect(event.actorId).toBe(MODERATOR);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.escalationAction).toBe('ban');
    expect(event.matchedSnippet).toBe('raiding');
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
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      `Banned <@${TARGET}>`,
    );

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
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'This was already handled',
    );
  });

  it('Confirm by a different authorized moderator is refused, and the intent survives for the original moderator', async () => {
    const harness = buildHarness();
    const intentId = await preview(harness);
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: OTHER_MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'Only the moderator who started this can confirm it',
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
    const cancelledText = cardTexts(harness.calls.respond.at(-1)?.message.components ?? []);
    expect(cancelledText).toContain('Cancelled');
    expect(cancelledText).toContain('Nothing was done');
    expect(harness.pendingActions.peek(intentId)).toBeUndefined();
  });

  it('an expired intent answers "expired", calls the gateway zero times, and is consumed rather than left to leak', async () => {
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
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'This confirmation expired',
    );
    void subscriber; // the un-advanced subscriber is unused in this test

    // Fix round, finding 1: `sweepExpiredPendingActions` has no scheduler
    // wired to it anywhere in the repo, so this "expired" branch is the
    // only code path that ever reaps a row a moderator previewed and never
    // clicked on again — it must consume the row itself or it leaks
    // forever (short of the guild being deleted, which cascades it away).
    expect(harness.pendingActions.peek(intentId)).toBeUndefined();
  });

  it('a thrown error while resolving the click still answers ephemeral, not a hung interaction', async () => {
    // Fix round, finding 2: the try/catch previously started partway
    // through the handler — after the peek and the whole cancel branch —
    // so an exception there escaped `handle()` entirely, leaving the
    // moderator's interaction deferred and never resolved. Simulates a
    // failure in the very first thing the handler does after defer: the
    // peek itself (a stand-in for, e.g., a transient SQLite error).
    const harness = buildHarness();
    const intentId = await preview(harness);
    const respondsAtPreview = harness.calls.respond.length;
    harness.pendingActions.peek = () => {
      throw new Error('simulated storage failure');
    };
    const subscriber = createModConfirmationSubscriber(harness.deps);

    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.defer).toHaveLength(1);
    expect(harness.calls.respond).toHaveLength(respondsAtPreview + 1);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      "Couldn't finish that",
    );
    expect(harness.calls.applyAction).toHaveLength(0);
  });

  it('re-checks authorization at confirm time: a capability revoked after preview refuses the confirm, calls the gateway zero times, records the refusal, and leaves the intent intact', async () => {
    // Fix round, finding 3.
    const harness = buildHarness({ authorized: true });
    const intentId = await preview(harness);
    const fetchCallsAtPreview = harness.calls.fetchInvokerRoleIds.length;

    harness.setAuthorized(false);
    const subscriber = createModConfirmationSubscriber(harness.deps);
    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      "You can't take moderation actions",
    );
    // Proves re-authorization actually ran at confirm time — deleting the
    // confirm path's own `authorizeInvoker` call and relying only on the
    // `createdBy` identity check would leave this assertion failing.
    expect(harness.calls.fetchInvokerRoleIds.length).toBeGreaterThan(fetchCallsAtPreview);

    // Deliberate design choice, not an oversight: authorization can be a
    // transient state (a role re-sync still catching up, an admin about to
    // re-grant a stripped role), so the intent is left intact for the same
    // moderator to retry within the confirmation window — symmetric with
    // how a wrong-moderator click leaves the row intact for the right one.
    expect(harness.pendingActions.peek(intentId)).not.toBeUndefined();

    // And it is durably recorded, the same as an unauthorized preview.
    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(TARGET);
    expect(event.actorId).toBe(MODERATOR);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.escalationAction).toBe('ban');
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
    expect(cardTexts(harness.calls.respond[0]?.message.components ?? [])).toContain(
      'Too many messages to purge at once',
    );
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
    expect(respondMessage.flags).toBe(32768);
    const previewText = cardTexts(respondMessage.components ?? []);
    expect(previewText).toContain(`Delete 5 messages from <#${CHANNEL}>?`);
    expect(previewText).toContain(
      '3 can go in bulk. 2 are older than 14 days and go one at a time.',
    );
    expect(harness.pendingActions.rows.size).toBe(1);
  });

  it('refuses an unauthorized caller before ever fetching messages, and records the refusal on the initiator’s own case', async () => {
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
    expect(cardTexts(harness.calls.respond[0]?.message.components ?? [])).toContain(
      "You can't take moderation actions",
    );

    // Fix round, finding 4. Purge has no single target member — reuses
    // purge.ts's own resolution: attach to the initiating moderator's own,
    // non-counting case, the same as a completed purge's own case events.
    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(MODERATOR);
    expect(event.actorId).toBe(MODERATOR);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.escalationAction).toBeUndefined();
    expect(event.matchedSnippet).toBe('spam cleanup');
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
    const queuedText = cardTexts(harness.calls.respond.at(-1)?.message.components ?? []);
    expect(queuedText).toContain(`Purging <#${CHANNEL}>`);
    expect(queuedText).toContain('It runs in the background');
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
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'This was already handled',
    );
  });

  it('re-checks authorization at confirm time for purge too: a revoked capability refuses the confirm, never enqueues, and records the refusal on the initiator’s own case', async () => {
    const harness = buildHarness({ authorized: true });
    const intentId = await previewPurge(harness);

    harness.setAuthorized(false);
    const subscriber = createModConfirmationSubscriber(harness.deps);
    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId: MODERATOR }),
    );

    expect(harness.calls.enqueuePurgeJob).toHaveLength(0);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      "You can't take moderation actions",
    );
    expect(harness.pendingActions.peek(intentId)).not.toBeUndefined();

    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(MODERATOR);
    expect(event.actorId).toBe(MODERATOR);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.escalationAction).toBeUndefined();
  });
});

describe('delete intent', () => {
  const AUTHOR: Snowflake = '555555555555555555';
  const MESSAGE: Snowflake = '666666666666666666';

  const writeIntent = (harness: Harness): string =>
    writeDeleteIntent(harness.deps, {
      actorId: MODERATOR,
      channelId: parseSnowflakeId(CHANNEL),
      messageId: parseSnowflakeId(MESSAGE),
      authorId: parseSnowflakeId(AUTHOR),
    });

  const confirm = async (harness: Harness, intentId: string, userId: Snowflake = MODERATOR) => {
    const subscriber = createModConfirmationSubscriber(harness.deps);
    await subscriber.handle(
      interactionEvent({ customId: buildModConfirmCustomId(intentId), userId }),
    );
  };

  it('writeDeleteIntent stores the delete payload, the actor and the expiry', () => {
    const harness = buildHarness();
    const intentId = writeIntent(harness);
    const row = harness.pendingActions.peek(intentId);
    expect(row).not.toBeUndefined();
    expect(row?.createdBy).toBe(MODERATOR);
    expect(row?.expiresAt).toBe(NOW_MS + PENDING_ACTION_TTL_MS);
    expect(modPendingActionPayload.parse(JSON.parse(row!.payload))).toEqual({
      kind: 'delete',
      channelId: CHANNEL,
      messageId: MESSAGE,
      authorId: AUTHOR,
    });
    expect(deleteConfirmDedupeKey(GUILD, intentId)).toBe(`mod:${GUILD}:delete:${intentId}`);
  });

  it('confirm calls deleteMessage once with the intent dedupe key, records deleted on the author’s case, and replies', async () => {
    const harness = buildHarness();
    const intentId = writeIntent(harness);
    await confirm(harness, intentId);

    expect(harness.calls.deleteMessage).toHaveLength(1);
    const { auth, intent } = harness.calls.deleteMessage[0]!;
    expect(auth).toBeDefined();
    expect(intent).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
      dedupeKey: `mod:${GUILD}:delete:${intentId}`,
      reason: 'Deleted from a log card',
    });

    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(AUTHOR);
    expect(event.ruleId).toBe('manual');
    expect(event.matchedCategory).toBe('delete');
    expect(event.matchedSnippet).toBe('Deleted from a log card');
    expect(event.actionTaken).toBe('deleted');
    expect(event.actorId).toBe(MODERATOR);

    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'Deleted the message',
    );
    expect(harness.pendingActions.peek(intentId)).toBeUndefined();
  });

  it.each([
    [{ status: 'applied' } as const, 'deleted'],
    [{ status: 'dry-run' } as const, 'delete_blocked_dry_run'],
    [{ status: 'refused', reason: 'killswitch' } as const, 'delete_blocked_killswitch'],
    [{ status: 'refused', reason: 'breaker-open' } as const, 'delete_blocked_breaker'],
    [{ status: 'refused', reason: 'guild-unknown' } as const, 'delete_blocked_guild_unknown'],
    [{ status: 'refused', reason: 'unauthorized' } as const, 'escalation_refused'],
    [{ status: 'failed', code: 'DiscordApiError' } as const, 'delete_failed'],
  ] as const)('%o records %s', async (outcome, actionTaken) => {
    const harness = buildHarness({ deleteMessageResult: outcome });
    await confirm(harness, writeIntent(harness));

    expect(harness.calls.deleteMessage).toHaveLength(1);
    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(AUTHOR);
    expect(event.actionTaken).toBe(actionTaken);
    if (outcome.status === 'refused' && outcome.reason === 'unauthorized') {
      expect(event.refusalReason).toBe('unauthorized');
    }
  });

  it.each([
    { status: 'skipped', reason: 'message-gone' },
    { status: 'skipped', reason: 'already-applied' },
  ] as const)('%o records no case event', async (outcome) => {
    const harness = buildHarness({ deleteMessageResult: outcome });
    await confirm(harness, writeIntent(harness));

    expect(harness.calls.deleteMessage).toHaveLength(1);
    expect(harness.calls.recordCaseEvent).toHaveLength(0);
  });

  it('a second Confirm answers "already handled" and deletes through the gateway once total', async () => {
    const harness = buildHarness();
    const intentId = writeIntent(harness);
    await confirm(harness, intentId);
    const subscriber = createModConfirmationSubscriber(harness.deps);
    await subscriber.handle(
      interactionEvent({
        interactionId: 'click-2',
        customId: buildModConfirmCustomId(intentId),
        userId: MODERATOR,
      }),
    );

    expect(harness.calls.deleteMessage).toHaveLength(1);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'This was already handled',
    );
  });

  it('Confirm by a different moderator is refused, calls nothing, and leaves the intent in place', async () => {
    const harness = buildHarness();
    const intentId = writeIntent(harness);
    await confirm(harness, intentId, OTHER_MODERATOR);

    expect(harness.calls.deleteMessage).toHaveLength(0);
    expect(harness.calls.recordCaseEvent).toHaveLength(0);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      'Only the moderator who started this can confirm it',
    );
    expect(harness.pendingActions.peek(intentId)).not.toBeUndefined();

    await confirm(harness, intentId, MODERATOR);
    expect(harness.calls.deleteMessage).toHaveLength(1);
  });

  it('a capability revoked after the click refuses the confirm, records it on the author’s case, and leaves the intent intact', async () => {
    const harness = buildHarness({ authorized: true });
    const intentId = writeIntent(harness);
    harness.setAuthorized(false);
    await confirm(harness, intentId, MODERATOR);

    expect(harness.calls.deleteMessage).toHaveLength(0);
    expect(cardTexts(harness.calls.respond.at(-1)?.message.components ?? [])).toContain(
      "You can't take moderation actions",
    );
    expect(harness.pendingActions.peek(intentId)).not.toBeUndefined();

    expect(harness.calls.recordCaseEvent).toHaveLength(1);
    const event = harness.calls.recordCaseEvent[0]!;
    expect(event.memberId).toBe(AUTHOR);
    expect(event.matchedCategory).toBe('delete');
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.actorId).toBe(MODERATOR);
  });
});
