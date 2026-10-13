import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { AuthzStore } from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { InteractionEvent, ModalSubmitEvent } from '../discord/events.js';
import type { InteractionRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import type {
  DeleteMessageIntent,
  DeleteMessageOutcome,
  ModerationIntent,
  ModerationOutcome,
} from '../effects/moderation-gateway.js';
import { parseGuildId } from '../ids.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import type { Modal } from '../ui/discord/kit.js';
import { buildModCustomId } from './custom-ids.js';
import { createModCardActionSubscriber, type ModCardActionDeps } from './card-actions.js';
import type {
  ModCommandCasePorts,
  ModCommandDeps,
  NoteEvidenceCasePorts,
} from './commands.js';
import type {
  ModConfirmationCasePorts,
  ModConfirmationDeps,
  ModPendingActionPorts,
  PendingActionRowLike,
} from './confirmations.js';
import type { HistoryCasePorts } from './history.js';
import type { WarnCasePorts } from './warn.js';

/**
 * Unit tests for the log-card moderator buttons (ADR 0141 decisions 4–7):
 * Warn/Timeout open a modal first and share `/mod`'s code path on submit;
 * Delete defers, authorises, writes a `delete` intent and shows the confirm
 * card. Every port faked, like `commands.test.ts`.
 */

const GUILD = parseGuildId('111111111111111111');
const MODERATOR: Snowflake = '222222222222222222';
const TARGET: Snowflake = '333333333333333333';
const CHANNEL: Snowflake = '444444444444444444';
const MESSAGE: Snowflake = '555555555555555555';
const NOW_MS = 1_700_000_000_000;

const silentLogger = pino({ level: 'silent' });

const clickEvent = (over: Partial<InteractionEvent> = {}): InteractionEvent => ({
  kind: 'interaction',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  interactionId: 'click-1',
  token: 'click-token-1',
  channelId: CHANNEL,
  messageId: 'log-message-1',
  userId: MODERATOR,
  customId: buildModCustomId({ action: 'warn', userId: TARGET }),
  ...over,
});

const submitEvent = (over: Partial<ModalSubmitEvent> = {}): ModalSubmitEvent => ({
  kind: 'modalSubmit',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  interactionId: 'submit-1',
  token: 'submit-token-1',
  channelId: CHANNEL,
  messageId: 'log-message-1',
  userId: MODERATOR,
  customId: buildModCustomId({ action: 'warn', userId: TARGET }),
  fields: { reason: 'spam' },
  ...over,
});

interface Harness {
  deps: ModCardActionDeps;
  calls: {
    applyAction: { auth: unknown; intent: ModerationIntent }[];
    deleteMessage: { auth: unknown; intent: DeleteMessageIntent }[];
    commandRecordCaseEvent: Parameters<ModCommandCasePorts['recordCaseEvent']>[0][];
    warnRecordCaseEvent: Parameters<WarnCasePorts['recordCaseEvent']>[0][];
    confirmRecordCaseEvent: Parameters<ModConfirmationCasePorts['recordCaseEvent']>[0][];
    defer: { ref: InteractionRef; options: { ephemeral: boolean } }[];
    respond: { ref: InteractionRef; message: OutgoingMessage }[];
    showModal: { ref: InteractionRef; modal: Modal }[];
    deferUpdate: { ref: InteractionRef }[];
    fetchInvokerRoleIds: Snowflake[];
  };
  pendingRows: Map<string, PendingActionRowLike>;
}

function buildHarness(
  opts: {
    authorized?: boolean;
    applyActionResult?: ModerationOutcome;
    deleteMessageResult?: DeleteMessageOutcome;
    applyActionError?: Error;
  } = {},
): Harness {
  const calls: Harness['calls'] = {
    applyAction: [],
    deleteMessage: [],
    commandRecordCaseEvent: [],
    warnRecordCaseEvent: [],
    confirmRecordCaseEvent: [],
    defer: [],
    respond: [],
    showModal: [],
    deferUpdate: [],
    fetchInvokerRoleIds: [],
  };
  const pendingRows = new Map<string, PendingActionRowLike>();

  const authorized = opts.authorized ?? true;
  const authz: AuthzStore = { hasGrant: () => authorized };

  const moderationGateway: ModerationGatewayPort = {
    async applyAction(auth, intent) {
      if (opts.applyActionError !== undefined) throw opts.applyActionError;
      calls.applyAction.push({ auth, intent });
      return opts.applyActionResult ?? { status: 'applied' };
    },
    async deleteMessage(auth, intent) {
      calls.deleteMessage.push({ auth, intent });
      return opts.deleteMessageResult ?? { status: 'applied' };
    },
  };

  const responder: SlashResponder = {
    defer: async (ref, options) => {
      calls.defer.push({ ref, options });
    },
    respond: async (ref, message) => {
      calls.respond.push({ ref, message });
    },
    showModal: async (ref, modal) => {
      calls.showModal.push({ ref, modal });
    },
    deferUpdate: async (ref) => {
      calls.deferUpdate.push({ ref });
    },
    editOriginal: async () => undefined,
  };

  const fetchInvokerRoleIds = async (userId: Snowflake): Promise<readonly Snowflake[]> => {
    calls.fetchInvokerRoleIds.push(userId);
    return [];
  };

  const pendingActions: ModPendingActionPorts = {
    put: (input) => {
      if (!pendingRows.has(input.intentId)) {
        pendingRows.set(input.intentId, {
          intentId: input.intentId,
          payload: input.payload,
          createdBy: input.createdBy,
          createdAt: input.now,
          expiresAt: input.expiresAt,
        });
      }
    },
    take: (intentId, now) => {
      const row = pendingRows.get(intentId);
      if (row === undefined) return undefined;
      pendingRows.delete(intentId);
      if (row.expiresAt <= now) return undefined;
      return row;
    },
    peek: (intentId) => pendingRows.get(intentId),
  };

  const confirmCases: ModConfirmationCasePorts = {
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
    recordCaseEvent: (input) => {
      calls.confirmRecordCaseEvent.push(input);
    },
  };

  const confirmations: ModConfirmationDeps = {
    guildId: GUILD,
    authz,
    fetchInvokerRoleIds,
    moderationGateway,
    cases: confirmCases,
    pendingActions,
    fetchRecentMessages: async () => ({ messages: [], nextBefore: undefined }),
    enqueuePurgeJob: () => {},
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
  };

  const commandCases: ModCommandCasePorts = {
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
    recordCaseEvent: (input) => {
      calls.commandRecordCaseEvent.push(input);
    },
  };

  const warnRepo: WarnCasePorts = {
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 1 }),
    recordCaseEvent: (input) => {
      calls.warnRecordCaseEvent.push(input);
    },
    nextEscalationTier: () => ({ tier: 0, action: undefined, timeoutMs: undefined }),
    recordEscalationOutcome: () => {},
  };

  const noteEvidenceCases: NoteEvidenceCasePorts = {
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 0 }),
    recordCaseEvent: () => {},
  };

  const historyCases: HistoryCasePorts = {
    listCasesForMember: () => [],
    listCaseEvents: () => [],
    openOrResolveCase: () => ({ caseId: 'case-1', violationCount: 0 }),
    recordCaseEvent: () => {},
  };

  const commands: ModCommandDeps = {
    guildId: GUILD,
    authz,
    fetchInvokerRoleIds,
    moderationGateway,
    cases: commandCases,
    warnRepo,
    noteEvidenceCases,
    history: {
      guildId: GUILD,
      authz,
      fetchInvokerRoleIds,
      cases: historyCases,
      responder,
      now: () => NOW_MS,
      logger: silentLogger,
    },
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
    confirmations,
  };

  const deps: ModCardActionDeps = {
    guildId: GUILD,
    commands,
    confirmations,
    responder,
    now: () => NOW_MS,
    logger: silentLogger,
  };

  return { deps, calls, pendingRows };
}

const lastReplyTexts = (harness: Harness): string =>
  cardTexts(harness.calls.respond.at(-1)?.message.components ?? []);

describe('log-card button clicks', () => {
  it('Warn opens the warn modal first: no defer, no authorisation lookup, no case write', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(clickEvent());

    expect(harness.calls.showModal).toHaveLength(1);
    expect(harness.calls.showModal[0]?.modal.custom_id).toBe(`bs.mod:warn:${TARGET}`);
    expect(harness.calls.defer).toHaveLength(0);
    expect(harness.calls.fetchInvokerRoleIds).toHaveLength(0);
    expect(harness.calls.commandRecordCaseEvent).toHaveLength(0);
    expect(harness.calls.warnRecordCaseEvent).toHaveLength(0);
  });

  it('Timeout opens the timeout modal with no defer', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      clickEvent({ customId: buildModCustomId({ action: 'timeout', userId: TARGET }) }),
    );

    expect(harness.calls.showModal).toHaveLength(1);
    expect(harness.calls.showModal[0]?.modal.custom_id).toBe(`bs.mod:timeout:${TARGET}`);
    expect(harness.calls.defer).toHaveLength(0);
  });

  it('an authorised Delete click defers, writes one delete intent, and shows the confirm card', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      clickEvent({
        customId: buildModCustomId({
          action: 'delete',
          channelId: CHANNEL,
          messageId: MESSAGE,
          authorId: TARGET,
        }),
      }),
    );

    expect(harness.calls.defer).toEqual([
      {
        ref: { interactionId: 'click-1', token: 'click-token-1' },
        options: { ephemeral: true },
      },
    ]);
    expect(harness.pendingRows.size).toBe(1);
    const row = [...harness.pendingRows.values()][0]!;
    expect(row.createdBy).toBe(MODERATOR);
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'delete',
      channelId: CHANNEL,
      messageId: MESSAGE,
      authorId: TARGET,
    });
    const reply = lastReplyTexts(harness);
    expect(reply).toContain(`Delete this message by <@${TARGET}>`);
    const ids = cardCustomIds(harness.calls.respond.at(-1)?.message.components ?? []);
    expect(ids[0]).toMatch(/^modconfirm:/);
    expect(ids).toHaveLength(2);
  });

  it('an unauthorised Delete click writes no intent, records the refusal on the author’s case, and refuses', async () => {
    const harness = buildHarness({ authorized: false });
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      clickEvent({
        customId: buildModCustomId({
          action: 'delete',
          channelId: CHANNEL,
          messageId: MESSAGE,
          authorId: TARGET,
        }),
      }),
    );

    expect(harness.pendingRows.size).toBe(0);
    expect(harness.calls.confirmRecordCaseEvent).toHaveLength(1);
    const event = harness.calls.confirmRecordCaseEvent[0]!;
    expect(event.memberId).toBe(TARGET);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.matchedCategory).toBe('delete');
    expect(lastReplyTexts(harness)).toContain("You can't take moderation actions");
  });

  it('ignores a component that is not a mod-card button', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(clickEvent({ customId: 'bs.task:start:x:1' }));
    await subscriber.handle(clickEvent({ customId: 'modconfirm:abc' }));

    expect(harness.calls.defer).toHaveLength(0);
    expect(harness.calls.showModal).toHaveLength(0);
    expect(harness.calls.respond).toHaveLength(0);
  });

  it('ignores a modal submit that is not a mod-card modal', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(submitEvent({ customId: 'bs.task:update:x' }));

    expect(harness.calls.defer).toHaveLength(0);
    expect(harness.calls.respond).toHaveLength(0);
  });
});

describe('log-card modal submits', () => {
  it('an authorised Warn submit defers, warns through the shared path, and replies', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(submitEvent());

    expect(harness.calls.defer).toEqual([
      {
        ref: { interactionId: 'submit-1', token: 'submit-token-1' },
        options: { ephemeral: true },
      },
    ]);
    expect(harness.calls.warnRecordCaseEvent).toHaveLength(1);
    expect(harness.calls.warnRecordCaseEvent[0]?.actionTaken).toBe('warned');
    expect(lastReplyTexts(harness)).toContain(`Warned <@${TARGET}>`);
  });

  it('a Warn submit from a non-moderator records escalation_refused like /mod warn, warns nobody, and refuses', async () => {
    const harness = buildHarness({ authorized: false });
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(submitEvent());

    expect(harness.calls.warnRecordCaseEvent).toHaveLength(0);
    expect(harness.calls.commandRecordCaseEvent).toHaveLength(1);
    const event = harness.calls.commandRecordCaseEvent[0]!;
    expect(event.memberId).toBe(TARGET);
    expect(event.actionTaken).toBe('escalation_refused');
    expect(event.refusalReason).toBe('unauthorized');
    expect(event.matchedCategory).toBe('warn');
    expect(lastReplyTexts(harness)).toContain("You can't take moderation actions");
  });

  it('a Timeout submit applies through the gateway with the chosen duration and the submit-bound dedupe key', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      submitEvent({
        customId: buildModCustomId({ action: 'timeout', userId: TARGET }),
        fields: { minutes: '1440', reason: 'raid' },
      }),
    );

    expect(harness.calls.applyAction).toHaveLength(1);
    const { intent } = harness.calls.applyAction[0]!;
    expect(intent.action).toBe('timeout');
    expect(intent.timeoutMs).toBe(86_400_000);
    expect(intent.dedupeKey).toBe(`mod:${GUILD}:timeout:submit-1`);
    expect(lastReplyTexts(harness)).toContain(`Timed out <@${TARGET}> for 1 day`);
  });

  it('a Timeout submit with an unlisted duration falls back to one hour', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      submitEvent({
        customId: buildModCustomId({ action: 'timeout', userId: TARGET }),
        fields: { minutes: '999', reason: 'raid' },
      }),
    );

    expect(harness.calls.applyAction).toHaveLength(1);
    expect(harness.calls.applyAction[0]?.intent.timeoutMs).toBe(3_600_000);
  });

  it('a Warn submit with a blank reason calls nothing, records nothing, and asks for a reason', async () => {
    const harness = buildHarness();
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(submitEvent({ fields: { reason: '   ' } }));

    expect(harness.calls.applyAction).toHaveLength(0);
    expect(harness.calls.warnRecordCaseEvent).toHaveLength(0);
    expect(harness.calls.commandRecordCaseEvent).toHaveLength(0);
    expect(lastReplyTexts(harness)).toContain('Add a reason');
  });

  it('a gateway failure on submit answers honestly instead of hanging the interaction', async () => {
    const harness = buildHarness({ applyActionError: new Error('boom') });
    const subscriber = createModCardActionSubscriber(harness.deps);

    await subscriber.handle(
      submitEvent({
        interactionId: '1234567890123456789',
        customId: buildModCustomId({ action: 'timeout', userId: TARGET }),
        fields: { minutes: '10', reason: 'raid' },
      }),
    );

    const reply = lastReplyTexts(harness);
    expect(reply).toContain("Couldn't finish that");
    expect(reply).toContain('-# Ref ');
  });
});
