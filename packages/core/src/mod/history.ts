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
import type { GuildId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/status-slash.js';

/**
 * `/mod history` (Task 9) — the last `/mod` subcommand: a read-only search
 * over one member's case(s), rendered as an ephemeral reply. Unlike every
 * other subcommand in this family it writes nothing — no gateway call, no
 * `mod_case_events` row, not even for a refusal (there is no action to
 * record a refusal *against*; see `handleHistory`'s own comment on that).
 *
 * A sibling module to `confirmations.ts`, not a branch inside `commands.ts`:
 * this file defines its own `HistoryDeps` (mirroring `ModConfirmationDeps`)
 * and `commands.ts` imports `handleHistory` and the deps type from here,
 * the same direction `confirmations.ts` already established — never the
 * reverse, which would create a cycle.
 *
 * Never imports `@bananasaurs/storage` (ADR 0014). `HistoryCasePorts` below
 * re-declares the read shapes `mod-cases.ts`'s `listCasesForMember` and
 * `listCaseEvents` return, the same way `NoteEvidenceCasePorts` and
 * `ModCommandCasePorts` (`commands.ts`) re-declare their own write shapes
 * rather than importing the storage package's types directly. The concrete
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

/** The narrow, read-only slice of the case repo `history` needs. */
export interface HistoryCasePorts {
  listCasesForMember(memberId: string): readonly HistoryCase[];
  listCaseEvents(caseId: string): readonly HistoryCaseEvent[];
}

export interface HistoryDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  /** A thunk over `DiscordPort.fetchMember`, mirrors `commands.ts`'s own field of the same name. */
  readonly fetchInvokerRoleIds: (userId: Snowflake) => Promise<readonly Snowflake[]>;
  readonly cases: HistoryCasePorts;
  readonly responder: SlashResponder;
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

/**
 * `/mod history` — read-only, but still gated on `moderation.act` (the Task
 * 9 brief's explicit instruction: "`history` without `moderation.act`
 * refused"). An unauthorized attempt gets a plain ephemeral refusal with no
 * `recordCaseEvent` call: unlike every write subcommand in this family,
 * nothing happened to any case here — there is no action to durably record a
 * refusal *against*. The brief's own Step 1 asks only for "refused",
 * matching this reading.
 */
export const handleHistory = async (
  deps: HistoryDeps,
  event: SlashCommandEvent,
  ref: InteractionRef,
): Promise<void> => {
  const targetId = parseSnowflakeId(optionValue(event.options, 'target'));

  const authResult = await authorizeInvoker(deps, event.userId);
  if (!authResult.ok) {
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

  const blocks = cases.map((caseRow) =>
    describeCase(caseRow, deps.cases.listCaseEvents(caseRow.caseId)),
  );
  const content = [
    `Case history for <@${targetId}> — ${cases.length} case(s):`,
    '',
    ...blocks,
  ].join('\n\n');

  await deps.responder.respond(ref, { content });
};
