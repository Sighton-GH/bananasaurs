import { randomUUID } from 'node:crypto';
import {
  authorize,
  type Actor,
  type Authorized,
  type AuthzStore,
  type Denied,
  type Result,
} from '../authz.js';
import { refFor } from '../copy/refusals.js';
import type { SlashCommandEvent, SlashCommandOption } from '../discord/events.js';
import type { InteractionRef, Snowflake } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { errorCard, resultCard } from '../ui/discord/common-cards.js';
import { historyCard } from './cards.js';
import { MANUAL_RULE_ID } from './warn.js';

/**
 * `/mod history` (Task 9) — the last `/mod` subcommand: a read-only search
 * over one member's case(s), rendered as an ephemeral paged card (P2 Task 8,
 * ADR 0141 decision 9). Unlike every
 * write subcommand in this family it never touches the moderation gateway
 * and its *successful* path writes no `mod_case_events` row — reading is not
 * an action. An **unauthorized** attempt is different: per the fix round
 * after this task's first review, it durably records an `escalation_refused`
 * event on the target's case, the same as `warn`/the direct actions/`ban`/
 * `purge`/`note`/`evidence` already do for their own unauthorized attempts
 * (`recordUnauthorizedRefusal` below, mirroring `commands.ts`'s
 * `recordDirectRefusal`). An unauthorized probe of a *specific* member's
 * disciplinary history is itself reconnaissance worth a durable trace, not
 * only a log line.
 *
 * A sibling module to `confirmations.ts`, not a branch inside `commands.ts`:
 * this file defines its own `HistoryDeps` (mirroring `ModConfirmationDeps`)
 * and `commands.ts` imports `handleHistory` and the deps type from here,
 * the same direction `confirmations.ts` already established — never the
 * reverse, which would create a cycle.
 *
 * Never imports `@bananasaurs/storage` (ADR 0014). `HistoryCasePorts` below
 * re-declares the read shapes `mod-cases.ts`'s `listCasesForMember` and
 * `listCaseEvents` return, plus the same `openOrResolveCase`/`recordCaseEvent`
 * write shapes `NoteEvidenceCasePorts` (`commands.ts`) re-declares — needed
 * here only for the unauthorized-refusal path, and restricted to the single
 * `actionTaken`/`refusalReason` pair that path ever writes. The concrete
 * repo calls are wired in `apps/daemon/src/runtime/guild.ts`.
 */

/** Mirrors `packages/storage/src/repos/mod-cases.ts`'s `ModCase`. */
export interface HistoryCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly openedAt: number;
  readonly violationCount: number;
  readonly escalationTier: number;
  readonly status: 'open' | 'closed';
}

/** Mirrors `packages/storage/src/repos/mod-cases.ts`'s `ModCaseEvent`. */
export interface HistoryCaseEvent {
  readonly eventId: string;
  readonly caseId: string;
  readonly caseMemberId?: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  readonly escalationAction: string | undefined;
  readonly refusalReason: string | undefined;
  readonly actorId: string | undefined;
}

/**
 * The slice of the case repo `history` needs: the two reads plus, as of the
 * fix round, the two writes an unauthorized attempt uses to record its own
 * refusal. Narrower than `NoteEvidenceCasePorts`'s write pair — `actionTaken`
 * here is pinned to the single literal this module ever writes, not the
 * three-value union note/evidence needs.
 */
export interface HistoryCasePorts {
  listCasesForMember(memberId: string): readonly HistoryCase[];
  listCaseEvents(caseId: string): readonly HistoryCaseEvent[];
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
    actionTaken: 'escalation_refused';
    refusalReason: 'unauthorized';
    /** The moderator who invoked the command. Every manual event carries one (ADR 0037). */
    actorId: string;
  }): void;
}

export interface HistoryDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  /** A thunk over `DiscordPort.fetchMember`, mirrors `commands.ts`'s own field of the same name. */
  readonly fetchInvokerRoleIds: (userId: Snowflake) => Promise<readonly Snowflake[]>;
  readonly cases: HistoryCasePorts;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
}

const optionValue = (
  options: readonly SlashCommandOption[],
  name: string,
): string | number | boolean | undefined => options.find((o) => o.name === name)?.value;

/** Obtained honestly, from a live `fetchMember` — mirrors `commands.ts`'s own `authorizeInvoker`. */
const authorizeInvoker = async (
  deps: HistoryDeps,
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

/**
 * Records an unauthorized `/mod history` attempt on the target's own case —
 * mirrors `commands.ts`'s `recordDirectRefusal` exactly (same
 * `openOrResolveCase(..., countsAsViolation: false)` then
 * `recordCaseEvent(..., actionTaken: 'escalation_refused', refusalReason:
 * 'unauthorized')` shape). `matchedSnippet` is `''`: unlike a refused
 * timeout/kick/warn, `/mod history` carries no `reason` option to put there
 * — `describeCaseEvent` (`./cards.js`) already treats an empty snippet as
 * "nothing to show" for any event, so this renders identically to how a
 * reason-less refusal would.
 */
const recordUnauthorizedRefusal = (
  deps: HistoryDeps,
  input: { targetId: SnowflakeId; actorId: Snowflake; now: number },
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
    matchedCategory: 'history',
    matchedSnippet: '',
    actionTaken: 'escalation_refused',
    refusalReason: 'unauthorized',
    actorId: input.actorId,
  });
};

/** One page of a member's case history: at most `HISTORY_PAGE_SIZE` events, newest first. */
export const HISTORY_PAGE_SIZE = 8;

export interface HistoryPage {
  readonly targetId: string;
  readonly cases: readonly HistoryCase[];
  /** Newest first, across every case. */
  readonly events: readonly HistoryCaseEvent[];
  readonly page: number;
  readonly pageCount: number;
  readonly countsByKind: Readonly<Record<string, number>>;
  /** Every event across every case, counted or not — the header's event total. */
  readonly totalEvents: number;
}

/**
 * Which counting bucket an event belongs in (`historyCard`'s header line).
 * Events with no bucket — a purge that ran, a dry run, a watch-only match —
 * still appear as lines; they just add to no count.
 */
const kindOf = (event: HistoryCaseEvent): string | undefined => {
  switch (event.actionTaken) {
    case 'warned':
      return 'warnings';
    case 'manual_applied': {
      if (event.escalationAction === 'timeout' || event.matchedCategory === 'timeout')
        return 'timeouts';
      if (event.escalationAction === 'kick' || event.matchedCategory === 'kick') return 'kicks';
      if (event.escalationAction === 'ban' || event.matchedCategory === 'ban') return 'bans';
      if (event.escalationAction === 'unban' || event.matchedCategory === 'unban') return 'unbans';
      return undefined;
    }
    case 'deleted':
    case 'deleted_and_escalated':
      return 'automodDeletes';
    case 'native_blocked':
    case 'native_alerted':
    case 'native_timeout':
    case 'native_blocked_interaction':
      return 'nativeAutomod';
    case 'note':
      return 'notes';
    case 'evidence_added':
      return 'evidence';
    case 'escalation_refused':
    case 'purge_refused':
    case 'delete_blocked_killswitch':
    case 'delete_blocked_breaker':
    case 'delete_blocked_dry_run':
    case 'delete_blocked_guild_unknown':
      return 'refused';
    default:
      return undefined;
  }
};

export const buildHistoryPage = (
  targetId: string,
  cases: readonly HistoryCase[],
  eventsByCase: ReadonlyMap<string, readonly HistoryCaseEvent[]>,
  page: number,
): HistoryPage => {
  const all = cases.flatMap((caseRow) =>
    (eventsByCase.get(caseRow.caseId) ?? []).map((event) => ({
      ...event,
      caseMemberId: caseRow.memberId,
    })),
  );
  all.sort((a, b) => b.at - a.at || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  const pageCount = Math.max(1, Math.ceil(all.length / HISTORY_PAGE_SIZE));
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  const countsByKind: Record<string, number> = {};
  for (const evt of all) {
    const kind = kindOf(evt);
    if (kind !== undefined) countsByKind[kind] = (countsByKind[kind] ?? 0) + 1;
  }
  return {
    targetId,
    cases,
    events: all.slice(clamped * HISTORY_PAGE_SIZE, (clamped + 1) * HISTORY_PAGE_SIZE),
    page: clamped,
    pageCount,
    countsByKind,
    totalEvents: all.length,
  };
};

/**
 * `/mod history` — read-only, but still gated on `moderation.act` (the Task
 * 9 brief's explicit instruction: "`history` without `moderation.act`
 * refused"). An unauthorized attempt is durably recorded on the target's own
 * case (`recordUnauthorizedRefusal`, above) — reconnaissance against a
 * specific member's disciplinary history is worth a case event, even though
 * `history` itself never writes one on success.
 *
 * Paging replaces the old truncation: the card shows at most
 * `HISTORY_PAGE_SIZE` events, newest first, with `← Newer` / `Older →`
 * buttons that re-render it in place through `editOriginal`. A refused read
 * answers privately in both modes — after `deferUpdate`, `respond` is a
 * private follow-up, so the original card is never edited for a refusal.
 */
export const showHistoryPage = async (
  deps: HistoryDeps,
  input: { actorId: Snowflake; targetId: SnowflakeId; page: number; interactionId: string },
  ref: InteractionRef,
  mode: 'reply' | 'edit',
): Promise<void> => {
  const nowMs = deps.now();

  const authResult = await authorizeInvoker(deps, input.actorId);
  if (!authResult.ok) {
    recordUnauthorizedRefusal(deps, {
      targetId: input.targetId,
      actorId: input.actorId,
      now: nowMs,
    });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-commands',
        guildId: deps.guildId,
        actorId: input.actorId,
        targetId: input.targetId,
        action: 'history',
        outcome: 'unauthorized',
        page: input.page,
      }),
      '/mod command refused: caller lacks moderation.act',
    );
    await deps.responder.respond(
      ref,
      toOutgoingMessage(errorCard('mod.not-allowed', { ref: refFor(input.interactionId) })),
    );
    return;
  }

  const cases = deps.cases.listCasesForMember(input.targetId);

  deps.logger.info(
    safeLogFields({
      component: 'mod-commands',
      guildId: deps.guildId,
      actorId: input.actorId,
      targetId: input.targetId,
      action: 'history',
      outcome: 'recorded',
      caseCount: cases.length,
      page: input.page,
    }),
    '/mod history read',
  );

  const message =
    cases.length === 0
      ? toOutgoingMessage(
          resultCard({
            icon: 'history',
            title: `No case history for <@${input.targetId}>`,
            tone: 'neutral',
          }),
        )
      : toOutgoingMessage(
          historyCard(
            buildHistoryPage(
              input.targetId,
              cases,
              new Map(
                cases.map((caseRow) => [
                  caseRow.caseId,
                  [...deps.cases.listCaseEvents(caseRow.caseId)],
                ]),
              ),
              input.page,
            ),
          ),
        );
  if (mode === 'reply') await deps.responder.respond(ref, message);
  else await deps.responder.editOriginal(ref, message);
};

export const handleHistory = async (
  deps: HistoryDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
): Promise<void> =>
  showHistoryPage(
    deps,
    {
      actorId: event.userId,
      targetId: parseSnowflakeId(optionValue(event.options, 'target')),
      page: 0,
      interactionId: event.interactionId,
    },
    ref,
    'reply',
  );
