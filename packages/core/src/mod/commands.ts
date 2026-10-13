import { randomUUID } from 'node:crypto';
import {
  authorize,
  type Actor,
  type Authorized,
  type AuthzStore,
  type Denied,
  type Result,
} from '../authz.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';
import type { SlashCommandEvent, SlashCommandOption } from '../discord/events.js';
import type { InteractionRef, Snowflake } from '../discord/port.js';
import type { ModerationOutcome, ModerationRefusalReason } from '../effects/moderation-gateway.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { refFor } from '../copy/refusals.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { toOutgoingMessage, type CardMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import { modOutcomeCard, noteOutcomeCard, warnOutcomeCard, type DirectModAction } from './cards.js';
import { handleBanPreview, handlePurgePreview, type ModConfirmationDeps } from './confirmations.js';
import { handleHistory, type HistoryDeps } from './history.js';
import { issueWarn, MANUAL_RULE_ID, type WarnCasePorts } from './warn.js';

/**
 * `/mod` — the slash-command surface over `ModerationActionGateway` and
 * `issueWarn` (ADR 0037, Task 6).
 *
 * Scope, per the Task 6 brief's ruling: `timeout`, `untimeout`, `kick`,
 * `unban`, `warn` apply on invocation. `ban` and `purge` (Task 7) do not —
 * this subscriber routes them straight to `./confirmations.js`'s preview
 * builders (`handleBanPreview` / `handlePurgePreview`), which write a
 * pending intent and render Confirm/Cancel buttons instead of calling the
 * gateway; the confirming click itself is a *different* event kind
 * (`InteractionEvent`, not `SlashCommandEvent`) and is handled entirely by
 * `confirmations.ts`'s own subscriber, not this one. `note` and `evidence`
 * (Task 8) *are* handled here, by `handleNoteOrEvidence` below: unlike
 * `ban`/`purge` they call no gateway at all — no Discord side effect, no
 * hierarchy, no confirmation to hold open — so each is just an authorized
 * moderator appending one durable `mod_case_events` row, the same shape as
 * `handleDirectAction`'s "defer → authorize → act → respond" but with the
 * "act" step being a repo write instead of a gateway call. `history` (Task
 * 9, `handleHistory` in `./history.js`) is the tenth and last subcommand:
 * read-only, so it writes no `mod_case_events` row at all, not even for a
 * refusal — see `history.ts`'s own docstring. `MOD_COMMAND`
 * (`packages/discord/src/rest/commands.ts`) registers all ten subcommands
 * now, the same way `ADR 0037` point 9 describes the registration endpoint
 * being re-PUT with a growing set.
 *
 * The pattern mirrors `ops/commands/status-slash.ts`: defer ephemeral,
 * respond ephemeral, an honest fallback if the handler throws after
 * deferring. Unlike `/status`, every subcommand here calls `authorize()`
 * with the **real invoking member** — `Actor.id` is `event.userId`,
 * `Actor.roleIds` come from a live `fetchMember`, never trusted from the
 * witness cast or skipped (`authz.ts`'s "runtime re-verification" control,
 * point 1 in its own docstring — the gateway re-checks again on top of
 * this, so a forged or stale witness still cannot execute anything).
 *
 * This module never imports `@bananasaurs/storage` (ADR 0014); the concrete
 * repo calls are wired in `apps/daemon/src/runtime/guild.ts`.
 */

export const MOD_COMMAND_NAME = 'mod';

/** Discord's timeout ceiling: 28 days, in milliseconds. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const clampTimeoutMs = (ms: number): number => Math.max(0, Math.min(ms, MAX_TIMEOUT_MS));

type DirectAction = DirectModAction;

const DIRECT_ACTIONS: ReadonlySet<string> = new Set<DirectAction>([
  'timeout',
  'untimeout',
  'kick',
  'unban',
]);

/**
 * The narrow slice of the case repo the four direct actions call. A sibling
 * of `WarnCasePorts` (`./warn.js`) and `PurgeCasePorts` (`./purge.js`)
 * rather than a shared interface — each names only the `action_taken`
 * values its own call sites actually write, per this module's `@bananasaurs/storage`
 * boundary rule (ADR 0014).
 */
export interface ModCommandCasePorts {
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
      | 'escalation_skipped';
    /**
     * Set when the action names a value `mod_case_events.escalation_action`
     * actually accepts (`timeout`/`kick`/`unban` — `ban` belongs to Task 7).
     * Absent for `untimeout`: see `ESCALATION_ACTION_FOR_DIRECT` below for
     * why, a real gap this task documents rather than papers over.
     */
    escalationAction?: 'timeout' | 'kick' | 'unban';
    /** Set only when `actionTaken` is `'escalation_refused'`. */
    refusalReason?: ModerationRefusalReason;
    /** The moderator who invoked the command. Every manual event carries one (ADR 0037). */
    actorId: string;
  }): void;
}

/**
 * The narrow slice of the case repo `note`/`evidence` call. A third sibling
 * of `WarnCasePorts` (`./warn.js`) and `ModCommandCasePorts` above rather
 * than a widening of either — Task 6/7's review settled this convention
 * ("each module names only the `action_taken` values its own call sites
 * write") and flagged that a third near-identical port here was expected,
 * not a sign the two should be merged.
 *
 * Only three `actionTaken` values are possible from this module's own two
 * call sites: `'note'`/`'evidence_added'` on success, `'escalation_refused'`
 * on an unauthorized attempt (mirroring `recordDirectRefusal`'s and
 * `handleWarn`'s own refusal recording — see `handleNoteOrEvidence` below).
 * Neither ever sets `escalationAction`: a note or an evidence link names no
 * `mod_case_events.escalation_action` value (`timeout`/`kick`/`ban`/`unban`)
 * because neither is an escalation attempt at all.
 */
export interface NoteEvidenceCasePorts {
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
    actionTaken: 'note' | 'evidence_added' | 'escalation_refused';
    /** Set only when `actionTaken` is `'escalation_refused'`. */
    refusalReason?: ModerationRefusalReason;
    /** The moderator who invoked the command. Every manual event carries one (ADR 0037). */
    actorId: string;
  }): void;
}

export interface ModCommandDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  /**
   * The invoking member's live role ids, for `authorize()`. A thunk over
   * `DiscordPort.fetchMember` closed over the guild id — mirrors
   * `automod/wiring.ts`'s `authorRoleIds`.
   */
  readonly fetchInvokerRoleIds: (userId: Snowflake) => Promise<readonly Snowflake[]>;
  readonly moderationGateway: ModerationGatewayPort;
  readonly cases: ModCommandCasePorts;
  /** Passed straight through to `issueWarn` for the `warn` subcommand. */
  readonly warnRepo: WarnCasePorts;
  /**
   * Called after a warning is recorded, for the logging module (ADR 0123).
   * Must not throw into the command — `handleWarn` awaits it inside a
   * try/catch that logs and swallows, so a logging failure never fails or
   * delays the moderator's reply beyond the existing flow.
   */
  readonly onWarned?:
    | ((info: {
        memberId: Snowflake;
        actorId: Snowflake;
        warnId: Snowflake;
        reason: string;
        caseId: string;
        violationCount: number;
      }) => Promise<void>)
    | undefined;
  /** Backs `note` and `evidence` (Task 8) — see `NoteEvidenceCasePorts`'s own docstring for why this is a third, separate port rather than a widening of `cases`. */
  readonly noteEvidenceCases: NoteEvidenceCasePorts;
  /**
   * Everything `history` needs (Task 9). A separate, self-contained deps
   * object rather than flattened fields here — mirrors `confirmations`
   * below: `history.ts` defines `HistoryDeps` and this module imports it,
   * never the reverse.
   */
  readonly history: HistoryDeps;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
  /**
   * Everything `ban`'s and `purge`'s previews need (Task 7). A separate,
   * self-contained deps object rather than flattened fields here — see
   * `confirmations.ts`'s own docstring for why this module imports *from*
   * it but never the reverse.
   */
  readonly confirmations: ModConfirmationDeps;
}

const optionValue = (
  options: readonly SlashCommandOption[],
  name: string,
): string | number | boolean | undefined => options.find((o) => o.name === name)?.value;

const stringOption = (options: readonly SlashCommandOption[], name: string): string => {
  const value = optionValue(options, name);
  return typeof value === 'string' ? value : '';
};

/**
 * One value per `ModerationOutcome` variant, mirroring `warn.ts`'s
 * `ESCALATION_ACTION_TAKEN`: `'manual_applied'`, not `'deleted_and_escalated'`
 * — nothing here deletes a message, so the automod vocabulary's deletion
 * claim would be a lie on every one of these events.
 */
const ACTION_TAKEN_FOR: Record<
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

/**
 * Which `escalation_action` value records a direct `/mod` action.
 *
 * **`untimeout` has no value.** `mod_case_events_escalation_action`'s CHECK
 * constraint (`packages/storage/src/schema.ts`) accepts
 * `'timeout'|'kick'|'ban'|'unban'` — widened for ADR 0037's manual ban/unban
 * commands, but never for untimeout, and `ModCaseEscalationAction`
 * (`packages/storage/src/repos/mod-cases.ts`) names the identical four.
 * Recording `'untimeout'` there would throw the CHECK at write time; adding
 * a fifth value is a schema migration, which is outside this task's scope
 * (Task 6 is the command layer only). So an untimeout event is written with
 * `escalationAction` left absent — every other fact still lands
 * (`memberId` is the target, `matchedSnippet` the reason, `at` the
 * timestamp, `actionTaken` the outcome, `actorId` the moderator,
 * `matchedCategory: 'untimeout'` names which action even though the
 * dedicated column cannot). Flagged in the Task 6 report as a real,
 * judgment-call gap rather than silently worked around.
 */
const ESCALATION_ACTION_FOR_DIRECT: Record<DirectAction, 'timeout' | 'kick' | 'unban' | undefined> =
  {
    timeout: 'timeout',
    untimeout: undefined,
    kick: 'kick',
    unban: 'unban',
  };

/** Obtained honestly, from a live `fetchMember`, and re-verified inside the gateway. */
const authorizeInvoker = async (
  deps: ModCommandDeps,
  userId: Snowflake,
): Promise<Result<Authorized<'moderation.act'>, Denied>> => {
  const roleIds = await deps.fetchInvokerRoleIds(userId);
  const actor: Actor = {
    type: 'member',
    id: userId,
    roleIds: roleIds.map((id) => parseSnowflakeId(id)),
  };
  return authorize({ store: deps.authz, guildId: deps.guildId, actor }, 'moderation.act');
};

const recordDirectRefusal = (
  deps: ModCommandDeps,
  input: {
    targetId: SnowflakeId;
    action: DirectAction;
    reason: string;
    actorId: Snowflake;
    now: number;
  },
): void => {
  const { caseId } = deps.cases.openOrResolveCase({
    memberId: input.targetId,
    now: input.now,
    countsAsViolation: false,
  });
  const escalationAction = ESCALATION_ACTION_FOR_DIRECT[input.action];
  deps.cases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: input.targetId,
    at: input.now,
    matchedCategory: input.action,
    matchedSnippet: input.reason,
    actionTaken: 'escalation_refused',
    ...(escalationAction !== undefined && { escalationAction }),
    refusalReason: 'unauthorized',
    actorId: input.actorId,
  });
};

const recordDirectOutcome = (
  deps: ModCommandDeps,
  input: {
    targetId: SnowflakeId;
    action: DirectAction;
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
  const escalationAction = ESCALATION_ACTION_FOR_DIRECT[input.action];
  deps.cases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: input.targetId,
    at: input.now,
    matchedCategory: input.action,
    matchedSnippet: input.reason,
    actionTaken: ACTION_TAKEN_FOR[input.outcome.status],
    ...(escalationAction !== undefined && { escalationAction }),
    ...(input.outcome.status === 'refused' && { refusalReason: input.outcome.reason }),
    actorId: input.actorId,
  });
};

/** One moderation request, whichever surface made it (ADR 0141 decision 6). */
export interface ModInput {
  readonly actorId: Snowflake;
  readonly targetId: SnowflakeId;
  readonly reason: string;
  /** `timeout` only. */
  readonly durationMinutes?: number;
  /** The interaction that asked: the slash command or the modal submit. Dedupe keys bind to it. */
  readonly interactionId: Snowflake;
}

const modInputFromSlash = (event: SlashCommandEvent): ModInput => {
  const durationRaw = optionValue(event.options, 'duration_minutes');
  return {
    actorId: event.userId,
    targetId: parseSnowflakeId(optionValue(event.options, 'target')),
    reason: stringOption(event.options, 'reason'),
    ...(typeof durationRaw === 'number' ? { durationMinutes: durationRaw } : {}),
    interactionId: event.interactionId,
  };
};

/** Every reply this module sends is a card. */
const reply = (deps: ModCommandDeps, ref: InteractionRef, message: CardMessage): Promise<void> =>
  deps.responder.respond(ref, toOutgoingMessage(message));

/** The slash command and the log-card modal submit share this one code path. */
export const runDirectAction = async (
  deps: ModCommandDeps,
  input: ModInput,
  ref: InteractionRef,
  action: DirectAction,
): Promise<void> => {
  const nowMs = deps.now();
  const targetId = input.targetId;
  const reason = input.reason;

  const authResult = await authorizeInvoker(deps, input.actorId);
  if (!authResult.ok) {
    recordDirectRefusal(deps, { targetId, action, reason, actorId: input.actorId, now: nowMs });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-commands',
        guildId: deps.guildId,
        actorId: input.actorId,
        targetId,
        action,
        outcome: 'unauthorized',
      }),
      '/mod command refused: caller lacks moderation.act',
    );
    await reply(deps, ref, errorCard('mod.not-allowed', { ref: refFor(input.interactionId) }));
    return;
  }

  let timeoutMs: number | undefined;
  if (action === 'timeout') {
    const minutes = input.durationMinutes ?? 0;
    timeoutMs = clampTimeoutMs(minutes * 60_000);
  }

  const outcome = await deps.moderationGateway.applyAction(authResult.value, {
    userId: targetId,
    action,
    timeoutMs,
    // Bound to this invocation's own interaction id, the same idempotency
    // idiom `warn.ts`'s escalation dedupe key uses: a resumed-replay of the
    // identical interaction (there is no such thing for a slash command
    // today, but the shape costs nothing) cannot double-execute.
    dedupeKey: `mod:${deps.guildId}:${action}:${input.interactionId}`,
    reason,
  });

  recordDirectOutcome(deps, {
    targetId,
    action,
    reason,
    actorId: input.actorId,
    now: nowMs,
    outcome,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-commands',
      guildId: deps.guildId,
      actorId: input.actorId,
      targetId,
      action,
      outcome: outcome.status,
    }),
    '/mod direct action handled',
  );

  await reply(
    deps,
    ref,
    modOutcomeCard({
      action,
      targetId,
      outcome,
      reason,
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      interactionId: input.interactionId,
    }),
  );
};

/** The slash command and the log-card modal submit share this one code path. */
export const runWarn = async (
  deps: ModCommandDeps,
  input: ModInput,
  ref: InteractionRef,
): Promise<void> => {
  const nowMs = deps.now();
  const targetId = input.targetId;
  const reason = input.reason;

  const authResult = await authorizeInvoker(deps, input.actorId);
  if (!authResult.ok) {
    // `issueWarn` records its `'warned'` event unconditionally — it takes no
    // refusal path of its own — so an unauthorized caller must never reach
    // it. The refusal is still durably recorded, on the target's case, the
    // same as the four direct actions above.
    const { caseId } = deps.cases.openOrResolveCase({
      memberId: targetId,
      now: nowMs,
      countsAsViolation: false,
    });
    deps.cases.recordCaseEvent({
      eventId: randomUUID(),
      caseId,
      ruleId: MANUAL_RULE_ID,
      memberId: targetId,
      at: nowMs,
      matchedCategory: 'warn',
      matchedSnippet: reason,
      actionTaken: 'escalation_refused',
      refusalReason: 'unauthorized',
      actorId: input.actorId,
    });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-commands',
        guildId: deps.guildId,
        actorId: input.actorId,
        targetId,
        action: 'warn',
        outcome: 'unauthorized',
      }),
      '/mod command refused: caller lacks moderation.act',
    );
    await reply(deps, ref, errorCard('mod.not-allowed', { ref: refFor(input.interactionId) }));
    return;
  }

  const result = await issueWarn(
    {
      guildId: deps.guildId,
      repo: deps.warnRepo,
      moderationGateway: deps.moderationGateway,
      logger: deps.logger,
    },
    {
      guildId: deps.guildId,
      memberId: targetId,
      actorId: input.actorId,
      // The parent event's id, per `IssueWarnInput.warnId`'s own docstring.
      warnId: input.interactionId,
      reason,
      now: nowMs,
      auth: authResult.value,
    },
  );

  // The logging module's hook (ADR 0123): the warning is the bot's own
  // action, so it cannot arrive as a gateway event — it is posted from here,
  // after the record exists and before the reply. A logging failure must
  // never fail the command: the warning itself is already recorded.
  if (deps.onWarned !== undefined) {
    try {
      await deps.onWarned({
        memberId: targetId,
        actorId: input.actorId,
        warnId: input.interactionId,
        reason,
        caseId: result.caseId,
        violationCount: result.violationCount,
      });
    } catch (err) {
      deps.logger.error(
        safeLogFields({ component: 'mod', guildId: deps.guildId, err }),
        'failed to log a warning; the warning itself is recorded',
      );
    }
  }

  await reply(
    deps,
    ref,
    warnOutcomeCard({
      targetId,
      reason,
      caseId: result.caseId,
      violationCount: result.violationCount,
      escalation: result.escalation,
    }),
  );
};

type NoteEvidenceKind = 'note' | 'evidence';

/** `mod_case_events.action_taken` for a successful write of each kind. */
const NOTE_EVIDENCE_ACTION_TAKEN: Record<NoteEvidenceKind, 'note' | 'evidence_added'> = {
  note: 'note',
  evidence: 'evidence_added',
};

/** Which STRING option on the subcommand carries the content. */
const NOTE_EVIDENCE_CONTENT_OPTION: Record<NoteEvidenceKind, string> = {
  note: 'text',
  evidence: 'url',
};

/**
 * `/mod note` and `/mod evidence` (Task 8, ADR 0037 points 4/5): a note's
 * `matchedSnippet` is the note text itself; evidence's is the URL.
 * `matchedCategory` is the subcommand name for both — `'evidence'` per the
 * plan's exact wording, and `'note'` to match it (rather than reusing
 * `MANUAL_RULE_ID` the way `issueWarn`'s own success write does): every
 * other manual case event in this module (`recordDirectRefusal`,
 * `recordDirectOutcome`, and `handleWarn`'s own refusal write) already uses
 * the subcommand/action name as `matchedCategory`, so `'note'` keeps this
 * event readable the same way and symmetric with `'evidence'`, rather than
 * introducing the one place a note event's category says "manual" instead
 * of "note".
 *
 * Neither subcommand calls `ModerationGatewayPort` — there is no Discord
 * side effect, so no hierarchy check and no idempotency dedupe key beyond
 * the ordinary interaction-replay dedupe the pipeline already handles
 * upstream (CLAUDE.md rule 6 is about durable Discord side effects; this
 * writes only a case-event row, and `recordCaseEvent`'s own `eventId`
 * primary key already makes a duplicate write of the same event a no-op).
 *
 * Per the plan: a note (or evidence link) on a member with no open case
 * opens one at count 0, non-counting — `openOrResolveCase` is called
 * unconditionally, with `countsAsViolation: false`, mirroring exactly what
 * `recordDirectRefusal`/`recordDirectOutcome` already do for a direct
 * action, not `issueWarn`'s `true` (a note is not itself a violation being
 * counted).
 */
const handleNoteOrEvidence = async (
  deps: ModCommandDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
  kind: NoteEvidenceKind,
): Promise<void> => {
  const nowMs = deps.now();
  const targetId = parseSnowflakeId(optionValue(event.options, 'target'));
  const content = stringOption(event.options, NOTE_EVIDENCE_CONTENT_OPTION[kind]);

  const authResult = await authorizeInvoker(deps, event.userId);
  if (!authResult.ok) {
    // Durably recorded even though unauthorized — the same pattern
    // `recordDirectRefusal` and `handleWarn`'s refusal path already follow
    // (Task 7's review caught and fixed the same gap for ban/purge): an
    // unauthorized attempt must be visible in case history, not log-only.
    const { caseId } = deps.noteEvidenceCases.openOrResolveCase({
      memberId: targetId,
      now: nowMs,
      countsAsViolation: false,
    });
    deps.noteEvidenceCases.recordCaseEvent({
      eventId: randomUUID(),
      caseId,
      ruleId: MANUAL_RULE_ID,
      memberId: targetId,
      at: nowMs,
      matchedCategory: kind,
      matchedSnippet: content,
      actionTaken: 'escalation_refused',
      refusalReason: 'unauthorized',
      actorId: event.userId,
    });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-commands',
        guildId: deps.guildId,
        actorId: event.userId,
        targetId,
        action: kind,
        outcome: 'unauthorized',
      }),
      '/mod command refused: caller lacks moderation.act',
    );
    await reply(deps, ref, errorCard('mod.not-allowed', { ref: refFor(event.interactionId) }));
    return;
  }

  const { caseId } = deps.noteEvidenceCases.openOrResolveCase({
    memberId: targetId,
    now: nowMs,
    countsAsViolation: false,
  });
  deps.noteEvidenceCases.recordCaseEvent({
    eventId: randomUUID(),
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: targetId,
    at: nowMs,
    matchedCategory: kind,
    matchedSnippet: content,
    actionTaken: NOTE_EVIDENCE_ACTION_TAKEN[kind],
    actorId: event.userId,
  });

  deps.logger.info(
    safeLogFields({
      component: 'mod-commands',
      guildId: deps.guildId,
      actorId: event.userId,
      targetId,
      action: kind,
      outcome: 'recorded',
    }),
    '/mod note/evidence recorded',
  );

  await reply(deps, ref, noteOutcomeCard({ kind, targetId, content }));
};

const isKnownSubcommand = (
  value: string,
): value is DirectAction | 'warn' | 'ban' | 'purge' | 'note' | 'evidence' | 'history' =>
  DIRECT_ACTIONS.has(value) ||
  value === 'warn' ||
  value === 'ban' ||
  value === 'purge' ||
  value === 'note' ||
  value === 'evidence' ||
  value === 'history';

export const createModCommandSubscriber = (deps: ModCommandDeps): Subscriber => ({
  name: 'mod-commands',
  async handle(event) {
    if (event.kind !== 'slashCommand') return;
    if (event.commandName !== MOD_COMMAND_NAME) return;

    const subcommand = event.subcommandPath[0];
    // Not one of the ten subcommands this subscriber knows — either a stale
    // registration or a subcommand a future task adds that this instance
    // does not yet handle. Identified before acknowledging, the same rule
    // `status-slash.ts` follows for a command that is not `/status`: never
    // swallow an interaction that belongs to code not wired in yet.
    if (subcommand === undefined || !isKnownSubcommand(subcommand)) return;

    const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
    await deps.responder.defer(ref, { ephemeral: true });

    try {
      if (subcommand === 'warn') {
        await runWarn(deps, modInputFromSlash(event), ref);
      } else if (subcommand === 'ban') {
        await handleBanPreview(deps.confirmations, event, ref);
      } else if (subcommand === 'purge') {
        await handlePurgePreview(deps.confirmations, event, ref);
      } else if (subcommand === 'note' || subcommand === 'evidence') {
        await handleNoteOrEvidence(deps, event, ref, subcommand);
      } else if (subcommand === 'history') {
        await handleHistory(deps.history, event, ref);
      } else {
        await runDirectAction(deps, modInputFromSlash(event), ref, subcommand);
      }
    } catch (err) {
      deps.logger.error(
        safeLogFields({
          component: 'mod-commands',
          guildId: deps.guildId,
          actorId: event.userId,
          subcommand,
          outcome: 'failed',
          err,
        }),
        'a /mod command failed unexpectedly',
      );
      await reply(deps, ref, errorCard('mod.unavailable', { ref: refFor(event.interactionId) }));
    }
  },
});
