import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Authorized, type AuthzStore, type Denied, type Result } from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { ErrorCode } from '../copy/errors.js';
import { refFor } from '../copy/refusals.js';
import type { SlashCommandEvent, SlashCommandOption } from '../discord/events.js';
import type { DiscordPort, InteractionRef, Snowflake } from '../discord/port.js';
import { checkPurgeBudget, PURGE_MAX_MESSAGES } from '../effects/budget.js';
import type {
  DeleteMessageOutcome,
  ModerationOutcome,
  ModerationRefusalReason,
} from '../effects/moderation-gateway.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { parseSnowflakeId, snowflakeIdSchema } from '../ids.js';
import { purgeDedupeKey, type ModPurgePayload } from '../jobs/kinds.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { toOutgoingMessage, type CardMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import {
  banConfirmCard,
  cancelledCard,
  deleteOutcomeCard,
  modOutcomeCard,
  purgeConfirmCard,
  purgeQueuedCard,
} from './cards.js';
import { BULK_DELETE_CEILING_MS } from './purge.js';
import { MANUAL_RULE_ID } from './warn.js';

/**
 * The confirm-then-execute handshake for `/mod ban` and `/mod purge` (ADR
 * 0037, Task 7).
 *
 * `timeout`/`untimeout`/`kick`/`unban`/`warn` (Task 6, `commands.ts`) apply
 * on invocation. `ban` and `purge` are irreversible-at-scale enough that
 * ADR 0037 requires a second, explicit tap: the command writes an intent to
 * `mod_pending_actions`, renders an ephemeral preview with Confirm/Cancel
 * buttons, and *only* the confirming click — by the same moderator, before
 * the intent expires — actually executes anything. This module owns that
 * whole handshake end to end: preview rendering, the pending-intent payload
 * schema, the buttons' custom ids, and the click handler.
 *
 * Deliberately **not** folded into `commands.ts`'s `handleDirectAction`
 * (Task 6's own handoff note): that function is "defer → authorize →
 * apply → respond" in one straight line, and there is no such line here —
 * a preview writes nothing to the case table and calls no gateway; a
 * confirm click is a *second*, independent interaction arriving on its own
 * event kind (`InteractionEvent`, not `SlashCommandEvent`) with no
 * relationship to the original slash command's `interactionId` or
 * deferral. `commands.ts` calls into this module's `handleBanPreview` /
 * `handlePurgePreview` for the two subcommand names, and owns none of the
 * confirm/cancel logic itself — this module also exports its own
 * `Subscriber` for the button clicks, wired as a sibling in the
 * composition root (`apps/daemon/src/runtime/guild.ts`), parallel to how
 * `panels/interactions.ts` is a sibling of `panels/reactions.ts` rather
 * than a branch inside it.
 *
 * This module never imports `@bananasaurs/storage` (ADR 0014) or
 * `./commands.js` (to keep the dependency one-directional: `commands.ts`
 * imports from here, so the reverse would cycle) — the concrete repo calls
 * are wired in the composition root, and this module names its own ports
 * even where they resemble `commands.ts`'s (the same "sibling interface
 * naming only the vocabulary its own call sites use" idiom `WarnCasePorts`
 * and `PurgeCasePorts` already establish).
 */

// --- the pending-intent payload ---------------------------------------------

/**
 * What survives between "the moderator ran `/mod ban`" and "the moderator
 * clicked Confirm" — the JSON `mod_pending_actions.payload` opaquely stores.
 *
 * A discriminated union rather than two separate payload shapes with no
 * shared handling, because both intents are read back by exactly one click
 * handler (`createModConfirmationSubscriber`) that needs to know which kind
 * it holds before it can do anything else.
 *
 * **What is deliberately absent:** the confirming moderator's id (already a
 * separate column, `mod_pending_actions.created_by` — duplicating it here
 * would let the column and the payload disagree) and any dedupe key (both
 * `ban`'s and `purge`'s dedupe keys are pure functions of `(guildId,
 * intentId)` — see `banConfirmDedupeKey` below and `purgeDedupeKey`
 * (`jobs/kinds.ts`) — so storing one would be a second, driftable copy of a
 * value the confirm handler can always recompute identically).
 */
const banPendingPayload = z.object({
  kind: z.literal('ban'),
  targetId: snowflakeIdSchema,
  reason: z.string().min(1).max(500),
});

const purgePendingPayload = z.object({
  kind: z.literal('purge'),
  channelId: snowflakeIdSchema,
  reason: z.string().min(1).max(500),
});

const deletePendingPayload = z.object({
  kind: z.literal('delete'),
  channelId: snowflakeIdSchema,
  messageId: snowflakeIdSchema,
  authorId: snowflakeIdSchema,
});

export const modPendingActionPayload = z.discriminatedUnion('kind', [
  banPendingPayload,
  purgePendingPayload,
  deletePendingPayload,
]);
export type ModPendingActionPayload = z.infer<typeof modPendingActionPayload>;

/**
 * The interaction-token window (ADR 0018): a confirmation cannot outlive
 * the token that would carry its response, so there is no value in an
 * intent surviving longer than this. Matches `mod_pending_actions.expires_
 * at`'s own docstring (`packages/storage/src/schema.ts`) and the value
 * already exercised in `mod-pending.test.ts`.
 */
export const PENDING_ACTION_TTL_MS = 15 * 60_000;

/** `mod:<guildId>:ban:<intentId>` — recomputed identically at preview time (never) and confirm time (always), never stored. */
export const banConfirmDedupeKey = (guildId: string, intentId: string): string =>
  `mod:${guildId}:ban:${intentId}`;

/** `mod:<guildId>:delete:<intentId>` — the same pure-function idiom as the ban key above. */
export const deleteConfirmDedupeKey = (guildId: string, intentId: string): string =>
  `mod:${guildId}:delete:${intentId}`;

/** The audit-log reason and case-history snippet for a delete that started on a log card. */
const DELETE_FROM_LOG_CARD = 'Deleted from a log card';

/**
 * Writes the `delete` intent a log-card Delete click needs before it can show
 * its confirm card (ADR 0141 decision 7). Returns the new intent id. The
 * click handler lives in `card-actions.ts`; the confirm handler below reads
 * the row back.
 */
export const writeDeleteIntent = (
  deps: ModConfirmationDeps,
  input: {
    actorId: Snowflake;
    channelId: SnowflakeId;
    messageId: SnowflakeId;
    authorId: SnowflakeId;
  },
): string => {
  const intentId = randomUUID();
  const payload: ModPendingActionPayload = {
    kind: 'delete',
    channelId: input.channelId,
    messageId: input.messageId,
    authorId: input.authorId,
  };
  const nowMs = deps.now();
  deps.pendingActions.put({
    intentId,
    payload: JSON.stringify(payload),
    createdBy: input.actorId,
    now: nowMs,
    expiresAt: nowMs + PENDING_ACTION_TTL_MS,
  });
  return intentId;
};

// --- custom ids and buttons --------------------------------------------------

/** Discord's 100-character custom-id ceiling; `crypto.randomUUID()` is 36, so the prefix has ample room. */
const MAX_CUSTOM_ID = 100;
const CONFIRM_PREFIX = 'modconfirm';
const CANCEL_PREFIX = 'modcancel';

export interface ParsedModConfirmCustomId {
  readonly action: 'confirm' | 'cancel';
  readonly intentId: string;
}

export const buildModConfirmCustomId = (intentId: string): string =>
  `${CONFIRM_PREFIX}:${intentId}`;
export const buildModCancelCustomId = (intentId: string): string => `${CANCEL_PREFIX}:${intentId}`;

/**
 * Parsed with a schema rather than a bare `split(':')` — the custom id
 * arrives from the client and is untrusted input in the strict sense of
 * `CLAUDE.md` rule 3, exactly like `panels/components.ts`'s own custom id.
 */
const modConfirmCustomIdSchema = z
  .string()
  .max(MAX_CUSTOM_ID)
  .transform((raw, ctx) => {
    const parts = raw.split(':');
    if (parts.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not a Bananasaurs mod-confirm custom id',
      });
      return z.NEVER;
    }
    const [prefix, intentId] = parts;
    if (intentId === undefined || intentId === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'intent id missing' });
      return z.NEVER;
    }
    if (prefix === CONFIRM_PREFIX) return { action: 'confirm' as const, intentId };
    if (prefix === CANCEL_PREFIX) return { action: 'cancel' as const, intentId };
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'not a Bananasaurs mod-confirm custom id',
    });
    return z.NEVER;
  });

/** Non-throwing: an unparseable custom id is another component in the same channel, not an error. */
export const parseModConfirmCustomId = (raw: string): ParsedModConfirmCustomId | undefined => {
  const result = modConfirmCustomIdSchema.safeParse(raw);
  return result.success ? result.data : undefined;
};

/** Discord's raw wire shapes, mirroring `panels/components.ts`'s ACTION_ROW/BUTTON literals (`core` may not import discord.js — ADR 0014). */

// --- ports -------------------------------------------------------------------

export interface PendingActionRowLike {
  readonly intentId: string;
  readonly payload: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * The narrow slice of `mod-pending.ts` this module calls. `peek` is
 * read-only and never deletes — see `resolveIntentForClick` below for why
 * that matters: a wrong-moderator click or an over-eager auth failure must
 * never consume the one real moderator's still-good intent.
 */
export interface ModPendingActionPorts {
  put(input: {
    intentId: string;
    payload: string;
    createdBy: string;
    now: number;
    expiresAt: number;
  }): void;
  take(intentId: string, now: number): PendingActionRowLike | undefined;
  peek(intentId: string): PendingActionRowLike | undefined;
}

/**
 * The narrow slice of the case repo a confirmed ban writes. A sibling of
 * `commands.ts`'s `ModCommandCasePorts` (same shape, `'ban'` added to the
 * `escalationAction` vocabulary) rather than a shared interface, for the
 * one-directional-import reason this module's own docstring gives.
 */
export interface ModConfirmationCasePorts {
  openOrResolveCase(input: { memberId: string; now: number; countsAsViolation: boolean }): {
    caseId: string;
    violationCount: number;
  };
  recordCaseEvent(input: {
    eventId: string;
    caseId: string;
    ruleId: string;
    memberId: string;
    at: number;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken:
      | 'manual_applied'
      | 'escalation_refused'
      | 'escalation_failed'
      | 'escalation_dry_run'
      | 'escalation_skipped'
      | 'deleted'
      | 'delete_failed'
      | 'delete_blocked_killswitch'
      | 'delete_blocked_breaker'
      | 'delete_blocked_dry_run'
      | 'delete_blocked_guild_unknown';
    escalationAction?: 'ban';
    refusalReason?: ModerationRefusalReason;
    actorId: string;
  }): void;
}

export interface ModConfirmationDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  readonly fetchInvokerRoleIds: (userId: Snowflake) => Promise<readonly Snowflake[]>;
  readonly moderationGateway: ModerationGatewayPort;
  readonly cases: ModConfirmationCasePorts;
  readonly pendingActions: ModPendingActionPorts;
  readonly fetchRecentMessages: DiscordPort['fetchRecentMessages'];
  /**
   * Enqueues the purge job's very first tick (`JOB_KINDS.modPurge`, no
   * cursor) — this module never runs a purge itself, only ever hands it to
   * the job queue Task 5 already built.
   */
  readonly enqueuePurgeJob: (input: { payload: string; dedupeKey: string; now: number }) => void;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
}

// --- shared helpers ------------------------------------------------------

const optionValue = (
  options: readonly SlashCommandOption[],
  name: string,
): string | number | boolean | undefined => options.find((o) => o.name === name)?.value;

const stringOption = (options: readonly SlashCommandOption[], name: string): string => {
  const value = optionValue(options, name);
  return typeof value === 'string' ? value : '';
};

/** Obtained honestly from a live `fetchMember`, re-verified by the gateway on ban execution — mirrors `commands.ts`'s own `authorizeInvoker`. */
const authorizeInvoker = async (
  deps: ModConfirmationDeps,
  userId: Snowflake,
): Promise<Result<Authorized<'moderation.act'>, Denied>> => {
  const roleIds = await deps.fetchInvokerRoleIds(userId);
  return authorize(
    {
      store: deps.authz,
      guildId: deps.guildId,
      actor: { type: 'member', id: userId, roleIds: roleIds.map((id) => parseSnowflakeId(id)) },
    },
    'moderation.act',
  );
};

/**
 * The same check under the name the log-card button subscriber uses: a click
 * authorises exactly the way a preview does (ADR 0141 decision 5).
 */
export const authorizeForCard = (
  deps: ModConfirmationDeps,
  userId: Snowflake,
): Promise<Result<Authorized<'moderation.act'>, Denied>> => authorizeInvoker(deps, userId);

/**
 * Records an unauthorized ban/purge attempt on `mod_case_events`, the same
 * way `commands.ts`'s `recordDirectRefusal` durably records an unauthorized
 * `/mod kick` (Task 6) — brought here in the fix round after review found
 * these paths only logging (finding 4). An unauthorized `/mod ban` attempt
 * — arguably the more serious probe — must be as visible in case history as
 * an unauthorized `/mod kick`, not only in the log file.
 *
 * `ban` has a target member to hang the case on (`payload.targetId` at
 * confirm time, the parsed `target` option at preview time). `purge` does
 * not — a channel cleanup has no member on the other end — so it reuses the
 * exact resolution `purge.ts`'s own case events already settled on: attach
 * to the *initiating actor's own*, non-counting case, the same call
 * `recordPurgeCaseEvent` makes with `memberId: payload.initiatorUserId`.
 * Reusing that resolution here (rather than inventing a third pattern for
 * "no target") is deliberate.
 */
const recordUnauthorizedRefusal = (
  deps: ModConfirmationDeps,
  input: {
    memberId: SnowflakeId;
    category: 'ban' | 'purge' | 'delete';
    reason: string;
    actorId: Snowflake;
    now: number;
    escalationAction?: 'ban';
  },
): void => {
  const { caseId } = deps.cases.openOrResolveCase({
    memberId: input.memberId,
    now: input.now,
    countsAsViolation: false,
  });
  deps.cases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: input.memberId,
    at: input.now,
    matchedCategory: input.category,
    matchedSnippet: input.reason,
    actionTaken: 'escalation_refused',
    ...(input.escalationAction !== undefined && { escalationAction: input.escalationAction }),
    refusalReason: 'unauthorized',
    actorId: input.actorId,
  });
};

/**
 * Records an unauthorized log-card Delete click on the message author's case,
 * the same way a revoked `/mod ban` confirm is recorded on its target's
 * (ADR 0141 decision 5). Shared with the button subscriber rather than
 * duplicated there.
 */
export const recordCardRefusal = (
  deps: ModConfirmationDeps,
  input: { memberId: SnowflakeId; actorId: Snowflake; now: number },
): void =>
  recordUnauthorizedRefusal(deps, {
    memberId: input.memberId,
    category: 'delete',
    reason: DELETE_FROM_LOG_CARD,
    actorId: input.actorId,
    now: input.now,
  });

// --- ban preview ---------------------------------------------------------

export const handleBanPreview = async (
  deps: ModConfirmationDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
): Promise<void> => {
  const nowMs = deps.now();
  const targetId = parseSnowflakeId(optionValue(event.options, 'target'));
  const reason = stringOption(event.options, 'reason');

  const authResult = await authorizeInvoker(deps, event.userId);
  if (!authResult.ok) {
    recordUnauthorizedRefusal(deps, {
      memberId: targetId,
      category: 'ban',
      reason,
      actorId: event.userId,
      now: nowMs,
      escalationAction: 'ban',
    });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-confirmations',
        guildId: deps.guildId,
        actorId: event.userId,
        targetId,
        action: 'ban',
        outcome: 'unauthorized',
      }),
      '/mod ban refused: caller lacks moderation.act',
    );
    await reply(
      deps.responder,
      ref,
      errorCard('mod.not-allowed', { ref: refFor(event.interactionId) }),
    );
    return;
  }

  const intentId = randomUUID();
  const payload: ModPendingActionPayload = { kind: 'ban', targetId, reason };
  deps.pendingActions.put({
    intentId,
    payload: JSON.stringify(payload),
    createdBy: event.userId,
    now: nowMs,
    expiresAt: nowMs + PENDING_ACTION_TTL_MS,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-confirmations',
      guildId: deps.guildId,
      actorId: event.userId,
      targetId,
      action: 'ban',
      outcome: 'preview',
    }),
    '/mod ban preview issued, nothing executed yet',
  );

  await reply(deps.responder, ref, banConfirmCard({ targetId, reason, intentId }));
};

// --- purge preview ---------------------------------------------------------

const PREVIEW_PAGE_LIMIT = 100;

/**
 * Pages `fetchRecentMessages` up to `PURGE_MAX_MESSAGES + 1` messages — just
 * enough to tell whether the channel is over budget without an unbounded
 * fetch, mirroring `runPurgeTick`'s own pagination shape (`purge.ts`) but
 * for counting rather than deleting.
 */
const fetchPreviewMessages = async (
  deps: Pick<ModConfirmationDeps, 'fetchRecentMessages' | 'guildId'>,
  channelId: Snowflake,
): Promise<{ messageId: Snowflake; createdAtMs: number }[]> => {
  const collected: { messageId: Snowflake; createdAtMs: number }[] = [];
  let before: Snowflake | undefined;
  for (;;) {
    const page = await deps.fetchRecentMessages(deps.guildId, channelId, {
      before,
      limit: PREVIEW_PAGE_LIMIT,
    });
    collected.push(...page.messages);
    if (collected.length > PURGE_MAX_MESSAGES) break;
    if (page.nextBefore === undefined) break;
    before = page.nextBefore;
  }
  return collected;
};

export const handlePurgePreview = async (
  deps: ModConfirmationDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
): Promise<void> => {
  const nowMs = deps.now();
  const channelId = parseSnowflakeId(optionValue(event.options, 'channel'));
  const reason = stringOption(event.options, 'reason');

  const authResult = await authorizeInvoker(deps, event.userId);
  if (!authResult.ok) {
    recordUnauthorizedRefusal(deps, {
      memberId: parseSnowflakeId(event.userId),
      category: 'purge',
      reason,
      actorId: event.userId,
      now: nowMs,
    });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-confirmations',
        guildId: deps.guildId,
        actorId: event.userId,
        channelId,
        action: 'purge',
        outcome: 'unauthorized',
      }),
      '/mod purge refused: caller lacks moderation.act',
    );
    await reply(
      deps.responder,
      ref,
      errorCard('mod.not-allowed', { ref: refFor(event.interactionId) }),
    );
    return;
  }

  const messages = await fetchPreviewMessages(deps, channelId);
  const budget = checkPurgeBudget(messages.length, PURGE_MAX_MESSAGES);
  if (!budget.ok) {
    deps.logger.warn(
      safeLogFields({
        component: 'mod-confirmations',
        guildId: deps.guildId,
        actorId: event.userId,
        channelId,
        action: 'purge',
        outcome: 'over-budget',
        count: messages.length,
      }),
      '/mod purge preview refused: over budget',
    );
    await reply(
      deps.responder,
      ref,
      errorCard('mod.over-budget', { ref: refFor(event.interactionId) }),
    );
    return;
  }

  const cutoff = nowMs - BULK_DELETE_CEILING_MS;
  const freshCount = messages.filter((m) => m.createdAtMs > cutoff).length;
  const oldCount = messages.length - freshCount;

  const intentId = randomUUID();
  const payload: ModPendingActionPayload = { kind: 'purge', channelId, reason };
  deps.pendingActions.put({
    intentId,
    payload: JSON.stringify(payload),
    createdBy: event.userId,
    now: nowMs,
    expiresAt: nowMs + PENDING_ACTION_TTL_MS,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-confirmations',
      guildId: deps.guildId,
      actorId: event.userId,
      channelId,
      action: 'purge',
      outcome: 'preview',
      count: messages.length,
    }),
    '/mod purge preview issued, nothing executed yet',
  );

  await reply(
    deps.responder,
    ref,
    purgeConfirmCard({
      channelId,
      total: messages.length,
      fresh: freshCount,
      old: oldCount,
      newestAtMs: messages[0]?.createdAtMs,
      reason,
      intentId,
    }),
  );
};

// --- confirm / cancel -------------------------------------------------------

/**
 * The three ways a click can fail to reach execution, resolved from a
 * `peek` — never a `take` — so that none of them consume the real
 * moderator's still-good intent (point 2 of this task's brief).
 *
 * `not-found` deliberately covers three different underlying facts (never
 * existed, already taken by a prior confirm, cancelled) that a peek alone
 * cannot tell apart — see `mod-pending.ts`'s `peekPendingAction` docstring.
 * That collapse is fine here: all three mean the same thing to the person
 * clicking ("there is nothing left to confirm"), and the one case that
 * *does* need its own message — expired — is checked first, from the row's
 * own `expiresAt`, before this collapse ever has a chance to hide it.
 */
type ResolvedIntent =
  | { readonly kind: 'ok'; readonly row: PendingActionRowLike }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'wrong-moderator' };

const resolveIntentForClick = (
  deps: ModConfirmationDeps,
  intentId: string,
  userId: Snowflake,
  now: number,
): ResolvedIntent => {
  const peeked = deps.pendingActions.peek(intentId);
  if (peeked === undefined) return { kind: 'not-found' };
  if (peeked.expiresAt <= now) return { kind: 'expired' };
  if (peeked.createdBy !== userId) return { kind: 'wrong-moderator' };
  return { kind: 'ok', row: peeked };
};

/** Every reply this module sends is a card. */
const reply = (
  responder: SlashResponder,
  ref: InteractionRef,
  message: CardMessage,
): Promise<void> => responder.respond(ref, toOutgoingMessage(message));

const RESOLUTION_CODE = {
  expired: 'confirm.expired',
  'not-found': 'confirm.done',
  'wrong-moderator': 'confirm.not-yours',
} as const satisfies Record<string, ErrorCode>;

const respondResolution = (
  responder: SlashResponder,
  ref: InteractionRef,
  kind: keyof typeof RESOLUTION_CODE,
  interactionId: string,
): Promise<void> =>
  reply(responder, ref, errorCard(RESOLUTION_CODE[kind], { ref: refFor(interactionId) }));

const respondBanOutcome = (
  responder: SlashResponder,
  ref: InteractionRef,
  targetId: SnowflakeId,
  outcome: ModerationOutcome,
  reason: string,
  interactionId: string,
): Promise<void> =>
  reply(
    responder,
    ref,
    modOutcomeCard({ action: 'ban', targetId, outcome, reason, interactionId }),
  );

/** One value per `ModerationOutcome` variant — mirrors `commands.ts`'s `ACTION_TAKEN_FOR`. */
const BAN_ACTION_TAKEN: Record<
  ModerationOutcome['status'],
  | 'manual_applied'
  | 'escalation_refused'
  | 'escalation_failed'
  | 'escalation_dry_run'
  | 'escalation_skipped'
> = {
  applied: 'manual_applied',
  refused: 'escalation_refused',
  failed: 'escalation_failed',
  'dry-run': 'escalation_dry_run',
  skipped: 'escalation_skipped',
};

const recordBanOutcome = (
  deps: ModConfirmationDeps,
  input: {
    targetId: SnowflakeId;
    reason: string;
    actorId: Snowflake;
    now: number;
    outcome: ModerationOutcome;
  },
): void => {
  const { caseId } = deps.cases.openOrResolveCase({
    memberId: input.targetId,
    now: input.now,
    countsAsViolation: false,
  });
  deps.cases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: input.targetId,
    at: input.now,
    matchedCategory: 'ban',
    matchedSnippet: input.reason,
    actionTaken: BAN_ACTION_TAKEN[input.outcome.status],
    escalationAction: 'ban',
    ...(input.outcome.status === 'refused' && { refusalReason: input.outcome.reason }),
    actorId: input.actorId,
  });
};

const executeConfirmedBan = async (
  deps: ModConfirmationDeps,
  ref: InteractionRef,
  intentId: string,
  userId: Snowflake,
  interactionId: Snowflake,
  payload: Extract<ModPendingActionPayload, { kind: 'ban' }>,
  auth: Authorized<'moderation.act'>,
  nowMs: number,
): Promise<void> => {
  const outcome = await deps.moderationGateway.applyAction(auth, {
    userId: payload.targetId,
    action: 'ban',
    timeoutMs: undefined,
    // The key minted at preview time — except it was never minted there:
    // it is a pure function of (guildId, intentId), computed identically
    // here on confirm and, were a replay to somehow reach this far again,
    // identically again. There is no separate "mint" step to desynchronise
    // from a "recompute" step.
    dedupeKey: banConfirmDedupeKey(deps.guildId, intentId),
    reason: payload.reason,
  });

  recordBanOutcome(deps, {
    targetId: payload.targetId,
    reason: payload.reason,
    actorId: userId,
    now: nowMs,
    outcome,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-confirmations',
      guildId: deps.guildId,
      actorId: userId,
      targetId: payload.targetId,
      action: 'ban',
      outcome: outcome.status,
    }),
    '/mod ban confirmed',
  );

  await respondBanOutcome(
    deps.responder,
    ref,
    payload.targetId,
    outcome,
    payload.reason,
    interactionId,
  );
};

/**
 * One value per `DeleteMessageOutcome` variant (ADR 0141 decision 7).
 * `undefined` means this moderator deleted nothing, so nothing is recorded:
 * the message was already gone, or an earlier confirm already recorded it.
 */
const deleteActionTaken = (
  outcome: DeleteMessageOutcome,
):
  | 'deleted'
  | 'delete_failed'
  | 'delete_blocked_killswitch'
  | 'delete_blocked_breaker'
  | 'delete_blocked_dry_run'
  | 'delete_blocked_guild_unknown'
  | 'escalation_refused'
  | undefined => {
  switch (outcome.status) {
    case 'applied':
      return 'deleted';
    case 'dry-run':
      return 'delete_blocked_dry_run';
    case 'failed':
      return 'delete_failed';
    case 'skipped':
      return undefined;
    case 'refused':
      switch (outcome.reason) {
        case 'unauthorized':
          return 'escalation_refused';
        case 'killswitch':
          return 'delete_blocked_killswitch';
        case 'breaker-open':
          return 'delete_blocked_breaker';
        case 'guild-unknown':
          return 'delete_blocked_guild_unknown';
      }
  }
};

const recordDeleteOutcome = (
  deps: ModConfirmationDeps,
  input: {
    authorId: SnowflakeId;
    actorId: Snowflake;
    now: number;
    outcome: DeleteMessageOutcome;
  },
): void => {
  const actionTaken = deleteActionTaken(input.outcome);
  if (actionTaken === undefined) return;
  const { caseId } = deps.cases.openOrResolveCase({
    memberId: input.authorId,
    now: input.now,
    countsAsViolation: false,
  });
  deps.cases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: input.authorId,
    at: input.now,
    matchedCategory: 'delete',
    matchedSnippet: DELETE_FROM_LOG_CARD,
    actionTaken,
    ...(actionTaken === 'escalation_refused' &&
      input.outcome.status === 'refused' && { refusalReason: input.outcome.reason }),
    actorId: input.actorId,
  });
};

const executeConfirmedDelete = async (
  deps: ModConfirmationDeps,
  ref: InteractionRef,
  intentId: string,
  userId: Snowflake,
  interactionId: Snowflake,
  payload: Extract<ModPendingActionPayload, { kind: 'delete' }>,
  auth: Authorized<'moderation.act'>,
  nowMs: number,
): Promise<void> => {
  const outcome = await deps.moderationGateway.deleteMessage(auth, {
    channelId: payload.channelId,
    messageId: payload.messageId,
    // The key minted at click time — except it was never minted there: it
    // is a pure function of (guildId, intentId), computed identically here
    // on confirm, the same idiom the ban key above follows.
    dedupeKey: deleteConfirmDedupeKey(deps.guildId, intentId),
    reason: DELETE_FROM_LOG_CARD,
  });

  recordDeleteOutcome(deps, { authorId: payload.authorId, actorId: userId, now: nowMs, outcome });

  deps.logger.info(
    safeLogFields({
      component: 'mod-confirmations',
      guildId: deps.guildId,
      actorId: userId,
      channelId: payload.channelId,
      messageId: payload.messageId,
      action: 'delete',
      outcome: outcome.status,
    }),
    'a log-card delete confirmed',
  );

  await reply(deps.responder, ref, deleteOutcomeCard(outcome, interactionId));
};

const executeConfirmedPurge = async (
  deps: ModConfirmationDeps,
  ref: InteractionRef,
  intentId: string,
  userId: Snowflake,
  payload: Extract<ModPendingActionPayload, { kind: 'purge' }>,
  nowMs: number,
): Promise<void> => {
  const purgePayload: ModPurgePayload = {
    intentId,
    channelId: payload.channelId,
    initiatorUserId: parseSnowflakeId(userId),
    reason: payload.reason,
  };

  // No `afterJobId`: this is the *first* tick of this purge (`purgeDedupeKey`'s
  // own docstring, `jobs/kinds.ts`) — every tick after this one mints its own
  // successor key from its own job id, which is `runPurgeTick`'s concern, not
  // this module's.
  deps.enqueuePurgeJob({
    payload: JSON.stringify(purgePayload),
    dedupeKey: purgeDedupeKey(deps.guildId, intentId),
    now: nowMs,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-confirmations',
      guildId: deps.guildId,
      actorId: userId,
      channelId: payload.channelId,
      action: 'purge',
      outcome: 'enqueued',
    }),
    '/mod purge confirmed, first tick enqueued',
  );

  await reply(deps.responder, ref, purgeQueuedCard(payload.channelId));
};

export const createModConfirmationSubscriber = (deps: ModConfirmationDeps): Subscriber => ({
  name: 'mod-confirmations',
  async handle(event) {
    if (event.kind !== 'interaction') return;

    // Identify before acknowledging — the same rule `panels/interactions.ts`
    // follows: an unparseable custom id belongs to someone else's component
    // and must not be swallowed.
    const parsed = parseModConfirmCustomId(event.customId);
    if (parsed === undefined) return;

    const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
    await deps.responder.defer(ref, { ephemeral: true });

    // Everything below can throw (a peek/take against a real database, a
    // live `authorize()` call, a gateway or job-queue call) and must still
    // leave the moderator with an answer rather than a deferred interaction
    // that never resolves. `commands.ts`'s own docstring names this pattern
    // — "an honest fallback if the handler throws after deferring" — and
    // wraps *everything* after its defer in the try; this now does too
    // (fix round, finding 2: the try previously started partway through,
    // after the peek and the whole cancel branch).
    try {
      const nowMs = deps.now();
      const resolved = resolveIntentForClick(deps, parsed.intentId, event.userId, nowMs);

      if (resolved.kind === 'expired') {
        // Consumed here, deliberately (fix round, finding 1). Before this,
        // an expired intent was reported "expired" straight from the peek
        // and never reached `take` — the only other place that ever
        // deleted an expired row — so a moderator who previewed and never
        // clicked anything left a row in `mod_pending_actions` forever
        // (`sweepExpiredPendingActions`, Task 1, has no scheduler wired to
        // it; nothing else in this codebase calls it). Still reported as
        // "expired", not "already executed" — the row genuinely was this
        // moderator's own intent, it simply outlived its window; the take
        // is housekeeping, not a change to what the moderator is told.
        deps.pendingActions.take(parsed.intentId, nowMs);
        await respondResolution(deps.responder, ref, 'expired', event.interactionId);
        return;
      }
      if (resolved.kind === 'not-found') {
        await respondResolution(deps.responder, ref, 'not-found', event.interactionId);
        return;
      }
      if (resolved.kind === 'wrong-moderator') {
        await respondResolution(deps.responder, ref, 'wrong-moderator', event.interactionId);
        return;
      }

      // resolved.kind === 'ok': present, fresh, belongs to this clicker.
      if (parsed.action === 'cancel') {
        deps.pendingActions.take(parsed.intentId, nowMs);
        deps.logger.info(
          safeLogFields({
            component: 'mod-confirmations',
            guildId: deps.guildId,
            actorId: event.userId,
            intentId: parsed.intentId,
            outcome: 'cancelled',
          }),
          '/mod confirmation cancelled',
        );
        await reply(deps.responder, ref, cancelledCard());
        return;
      }

      // --- confirm -----------------------------------------------------
      // Parsed from the peeked row, before taking anything: a refusal
      // below (an authorization that no longer holds) needs to know which
      // kind this is — and, for ban, the target — to record an honest
      // case event, and there is no reason to wait until after `take` to
      // learn that. Cancel above never needed the payload's content at
      // all.
      const payloadResult = modPendingActionPayload.safeParse(
        JSON.parse(resolved.row.payload) as unknown,
      );
      if (!payloadResult.success) {
        // Consumed rather than left for indefinite retry: a payload this
        // module wrote itself that fails to parse back is corruption, not
        // a transient condition a second click would resolve.
        deps.pendingActions.take(parsed.intentId, nowMs);
        deps.logger.error(
          safeLogFields({
            component: 'mod-confirmations',
            guildId: deps.guildId,
            intentId: parsed.intentId,
            outcome: 'failed',
            err: payloadResult.error,
          }),
          'a pending action payload failed to validate on confirm',
        );
        await reply(
          deps.responder,
          ref,
          errorCard('mod.unavailable', { ref: refFor(event.interactionId) }),
        );
        return;
      }
      const payload = payloadResult.data;

      // Re-verified here, not merely inherited from the preview (fix
      // round, finding 3): a moderator's capability can be revoked
      // between preview and confirm, and `createdBy === userId` — already
      // checked by `resolveIntentForClick` above — proves identity, not
      // standing authorization.
      const authResult = await authorizeInvoker(deps, event.userId);
      if (!authResult.ok) {
        if (payload.kind === 'ban') {
          recordUnauthorizedRefusal(deps, {
            memberId: payload.targetId,
            category: 'ban',
            reason: payload.reason,
            actorId: event.userId,
            now: nowMs,
            escalationAction: 'ban',
          });
        } else if (payload.kind === 'delete') {
          recordUnauthorizedRefusal(deps, {
            memberId: payload.authorId,
            category: 'delete',
            reason: DELETE_FROM_LOG_CARD,
            actorId: event.userId,
            now: nowMs,
          });
        } else {
          recordUnauthorizedRefusal(deps, {
            memberId: parseSnowflakeId(event.userId),
            category: 'purge',
            reason: payload.reason,
            actorId: event.userId,
            now: nowMs,
          });
        }
        deps.logger.warn(
          safeLogFields({
            component: 'mod-confirmations',
            guildId: deps.guildId,
            actorId: event.userId,
            intentId: parsed.intentId,
            action: payload.kind,
            outcome: 'unauthorized',
          }),
          '/mod confirmation refused: caller no longer has moderation.act',
        );
        // Deliberately NOT taken (a design decision, not an oversight):
        // authorization can be a transient state — a role re-sync still
        // catching up, an admin about to re-grant a stripped role — and
        // the *same* moderator regaining it within the confirmation
        // window should still be able to confirm the same intent, the
        // same way a wrong-moderator click above leaves the row intact
        // for the right moderator rather than burning it.
        await reply(
          deps.responder,
          ref,
          errorCard('mod.not-allowed', { ref: refFor(event.interactionId) }),
        );
        return;
      }

      // The one-shot claim, taken immediately before acting — mirrors the
      // gateway's own "claim right before the REST call" ordering
      // (`moderation-gateway.ts` layer 9). A concurrent second click landing
      // in the narrow window between `resolveIntentForClick`'s peek above
      // and this take is the one theoretical race this task's brief
      // accepts rather than engineers against (single-writer SQLite per
      // guild, ADR 0008; a confirm click is not a tight loop).
      const taken = deps.pendingActions.take(parsed.intentId, nowMs);
      if (taken === undefined) {
        await respondResolution(deps.responder, ref, 'not-found', event.interactionId);
        return;
      }

      if (payload.kind === 'ban') {
        await executeConfirmedBan(
          deps,
          ref,
          parsed.intentId,
          event.userId,
          event.interactionId,
          payload,
          authResult.value,
          nowMs,
        );
      } else if (payload.kind === 'delete') {
        await executeConfirmedDelete(
          deps,
          ref,
          parsed.intentId,
          event.userId,
          event.interactionId,
          payload,
          authResult.value,
          nowMs,
        );
      } else {
        await executeConfirmedPurge(deps, ref, parsed.intentId, event.userId, payload, nowMs);
      }
    } catch (err) {
      deps.logger.error(
        safeLogFields({
          component: 'mod-confirmations',
          guildId: deps.guildId,
          actorId: event.userId,
          intentId: parsed.intentId,
          outcome: 'failed',
          err,
        }),
        'a /mod confirmation failed unexpectedly',
      );
      await reply(
        deps.responder,
        ref,
        errorCard('mod.unavailable', { ref: refFor(event.interactionId) }),
      );
    }
  },
});
