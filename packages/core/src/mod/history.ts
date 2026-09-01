import { randomUUID } from 'node:crypto';
import {
  authorize,
  type Actor,
  type Authorized,
  type AuthzStore,
  type Denied,
  type Result,
} from '../authz.js';
import type { SlashCommandEvent, SlashCommandOption } from '../discord/events.js';
import type { InteractionRef, Snowflake } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/status-slash.js';
import { MANUAL_RULE_ID } from './warn.js';

/**
 * `/mod history` (Task 9) — the last `/mod` subcommand: a read-only search
 * over one member's case(s), rendered as an ephemeral reply. Unlike every
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
 * — `describeEvent` below already treats an empty snippet as "nothing to
 * show" for any event, so this renders identically to how a reason-less
 * refusal would.
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

const formatTimestamp = (atMs: number): string => new Date(atMs).toISOString();

/**
 * Whether `event` is something `caseMemberId` **did** as a moderator,
 * landing on their own case (a purge, a note, an evidence link, a warning
 * they issued that resolved onto their own open case, an unauthorized
 * attempt of any of the above) rather than something that happened **to**
 * them.
 *
 * `actorId === caseMemberId` is the whole signal — per the Task 9 brief
 * (point 5, backed by two separate task reviews): purge and
 * unauthorized-refusal events attach to the *initiating moderator's own
 * case*, since a purge has no single target member. Rendering by raw event
 * count, or assuming every event on a case is a violation committed by that
 * case's member, would show "Bryan ran a purge" as "Bryan was purged" —
 * exactly the mistake this split exists to avoid. An event with no
 * `actorId` at all (an automod match, for instance) is never self-authored.
 */
const isSelfAuthored = (event: HistoryCaseEvent, caseMemberId: string): boolean =>
  event.actorId !== undefined && event.actorId === caseMemberId;

const describeEvent = (event: HistoryCaseEvent): string => {
  const parts = [`\`${formatTimestamp(event.at)}\``, `**${event.actionTaken}**`];
  if (event.matchedCategory) parts.push(`(${event.matchedCategory})`);
  if (event.escalationAction !== undefined) parts.push(`→ ${event.escalationAction}`);
  if (event.refusalReason !== undefined) parts.push(`— refused: ${event.refusalReason}`);
  if (event.actorId !== undefined) parts.push(`by <@${event.actorId}>`);
  if (event.matchedSnippet) parts.push(`— "${event.matchedSnippet}"`);
  return `- ${parts.join(' ')}`;
};

/**
 * Renders one case's block: header (status, opened, violation count,
 * escalation tier — `violationCount` comes straight off the case row, never
 * computed from `events.length`, because `purge`/`note`/`evidence`/an
 * unauthorized refusal all write events that never touch it — see
 * `isSelfAuthored`'s own docstring) followed by two event groups.
 */
const describeCase = (caseRow: HistoryCase, events: readonly HistoryCaseEvent[]): string => {
  const header =
    `**Case ${caseRow.caseId}** (${caseRow.status}) — opened ${formatTimestamp(caseRow.openedAt)}, ` +
    `violations: ${caseRow.violationCount}, escalation tier: ${caseRow.escalationTier}`;

  const against = events.filter((e) => !isSelfAuthored(e, caseRow.memberId));
  const own = events.filter((e) => isSelfAuthored(e, caseRow.memberId));

  const sections: string[] = [header];
  if (against.length > 0) {
    sections.push('Actions and violations recorded against this member:');
    sections.push(...against.map(describeEvent));
  }
  if (own.length > 0) {
    sections.push('Actions this member took as a moderator, recorded on this case:');
    sections.push(...own.map(describeEvent));
  }
  if (against.length === 0 && own.length === 0) {
    sections.push('(no events recorded on this case)');
  }
  return sections.join('\n');
};

/** Discord's ceiling on a message's `content` field. */
const MAX_CONTENT_LENGTH = 2000;

const renderContent = (
  targetId: SnowflakeId,
  cases: readonly HistoryCase[],
  eventsByCase: ReadonlyMap<string, readonly HistoryCaseEvent[]>,
  omittedCount: number,
): string => {
  const blocks = cases.map((caseRow) =>
    describeCase(caseRow, eventsByCase.get(caseRow.caseId) ?? []),
  );
  const lines = [`Case history for <@${targetId}> — ${cases.length} case(s):`, '', ...blocks];
  if (omittedCount > 0) {
    lines.push(
      `_(${omittedCount} older event${omittedCount === 1 ? '' : 's'} omitted to stay under ` +
        `Discord's ${MAX_CONTENT_LENGTH}-character message limit — showing the most recent.)_`,
    );
  }
  return lines.join('\n\n');
};

/**
 * The case (if any) still holding the globally-oldest unrendered event.
 *
 * Each case's array is oldest-first (`listCaseEvents`'s own contract), so a
 * case's current oldest remaining event is always its head (`events[0]`).
 * Comparing heads across cases and returning the smallest `at` is therefore
 * enough to find the single oldest event across every case without
 * re-sorting anything.
 */
const caseWithOldestRemainingEvent = (
  eventsByCase: ReadonlyMap<string, readonly HistoryCaseEvent[]>,
): string | undefined => {
  let oldest: { caseId: string; at: number } | undefined;
  for (const [caseId, events] of eventsByCase) {
    const head = events[0];
    if (head === undefined) continue;
    if (oldest === undefined || head.at < oldest.at) oldest = { caseId, at: head.at };
  }
  return oldest?.caseId;
};

/**
 * A case's open-ended event log has no upper bound — there is no
 * case-closing feature, so an actively-moderated member's single open case
 * can accumulate automod strikes, warns, notes, evidence, and purge events
 * indefinitely. `renderContent`'s full, untruncated output can therefore
 * legitimately exceed Discord's 2000-character message-content ceiling, and
 * an over-length response is not degraded gracefully by Discord — the
 * interaction fails outright.
 *
 * The fix: render fully, and if that overflows, repeatedly drop the single
 * globally-oldest remaining event (`caseWithOldestRemainingEvent`) and
 * re-render, until the content fits or there is nothing left to drop. "Drop
 * the oldest" rather than any other strategy because a moderator running
 * `/mod history` almost always cares most about a member's *current*
 * standing — the most recent warning, the most recent purge they ran — not
 * their oldest recorded event; the omitted-count notice
 * (`renderContent`'s own `omittedCount` line) makes the truncation visible
 * rather than silent. Re-rendering per drop (rather than computing a byte
 * budget up front) is O(n²) in the event count, but `n` here is a single
 * moderator's `/mod history` query, not a hot path — simplicity over
 * cleverness.
 */
const buildTruncatedContent = (
  targetId: SnowflakeId,
  cases: readonly HistoryCase[],
  eventsByCase: Map<string, HistoryCaseEvent[]>,
): string => {
  let omitted = 0;
  let content = renderContent(targetId, cases, eventsByCase, omitted);
  while (content.length > MAX_CONTENT_LENGTH) {
    const caseId = caseWithOldestRemainingEvent(eventsByCase);
    if (caseId === undefined) break; // Nothing left to drop — render as-is (best effort).
    eventsByCase.get(caseId)?.shift();
    omitted += 1;
    content = renderContent(targetId, cases, eventsByCase, omitted);
  }
  return content;
};

/**
 * `/mod history` — read-only, but still gated on `moderation.act` (the Task
 * 9 brief's explicit instruction: "`history` without `moderation.act`
 * refused"). An unauthorized attempt is durably recorded on the target's own
 * case (`recordUnauthorizedRefusal`, above) — reconnaissance against a
 * specific member's disciplinary history is worth a case event, even though
 * `history` itself never writes one on success.
 */
export const handleHistory = async (
  deps: HistoryDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
): Promise<void> => {
  const nowMs = deps.now();
  const targetId = parseSnowflakeId(optionValue(event.options, 'target'));

  const authResult = await authorizeInvoker(deps, event.userId);
  if (!authResult.ok) {
    recordUnauthorizedRefusal(deps, { targetId, actorId: event.userId, now: nowMs });
    deps.logger.warn(
      safeLogFields({
        component: 'mod-commands',
        guildId: deps.guildId,
        actorId: event.userId,
        targetId,
        action: 'history',
        outcome: 'unauthorized',
      }),
      '/mod command refused: caller lacks moderation.act',
    );
    await deps.responder.respond(ref, {
      content: 'You do not have permission to view member case history.',
    });
    return;
  }

  const cases = deps.cases.listCasesForMember(targetId);

  deps.logger.info(
    safeLogFields({
      component: 'mod-commands',
      guildId: deps.guildId,
      actorId: event.userId,
      targetId,
      action: 'history',
      outcome: 'recorded',
      caseCount: cases.length,
    }),
    '/mod history read',
  );

  if (cases.length === 0) {
    await deps.responder.respond(ref, {
      content: `No case history found for <@${targetId}>.`,
    });
    return;
  }

  const eventsByCase = new Map<string, HistoryCaseEvent[]>(
    cases.map((caseRow) => [caseRow.caseId, [...deps.cases.listCaseEvents(caseRow.caseId)]]),
  );
  const content = buildTruncatedContent(targetId, cases, eventsByCase);

  await deps.responder.respond(ref, { content });
};
