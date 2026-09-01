import type { Authorized } from '../authz.js';
import type { Snowflake } from '../discord/port.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { ModerationGatewayPort } from '../automod/subscriber.js';

/**
 * The shared escalation counter — the owner's ladder-feeding decision
 * (ADR 0037). A moderator-issued warning is not a second subsystem with its
 * own counting: it resolves the member's existing case and increments the
 * same `violation_count` an automod strike increments (via
 * `openOrResolveCase` with `countsAsViolation: true`, the *same* call the
 * automod subscriber makes), so the two sources are indistinguishable to
 * `nextEscalationTier` by construction.
 *
 * Exactly like an automod strike, a warn that pushes the counter across a
 * tier triggers the ladder's automatic consequence (a timeout at 3, a kick
 * at 6) through `ModerationActionGateway` — the owner's decision, stated
 * plainly in ADR 0037: a moderator issuing the third warning and watching
 * the bot auto-timeout is the behaviour, not a bug. The escalation carries
 * its own durable dedupe key, so a replayed dispatch (CLAUDE.md rule 6)
 * cannot apply the consequence twice.
 *
 * This module never imports `@bananasaurs/storage` (ADR 0014); the concrete
 * repo calls are wired in the composition root, the same way the automod
 * subscriber's are.
 */

/** The reserved `rule_id` for every manual case event (ADR 0037). */
export const MANUAL_RULE_ID = 'manual';

/**
 * The narrow slice of the case repo `issueWarn` calls. Ports, not the
 * storage package — the boundary rule above.
 */
export interface WarnCasePorts {
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
    actionTaken: 'warned';
    actorId: string;
  }): void;
  nextEscalationTier(violationCount: number): {
    tier: number;
    action: 'timeout' | 'kick' | undefined;
    timeoutMs: number | undefined;
  };
  recordEscalationOutcome(input: {
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
    escalationAction: 'timeout' | 'kick';
    refusalReason: string | undefined;
    actorId: string;
  }): void;
}

export interface IssueWarnInput {
  readonly guildId: Snowflake;
  /** The warned member. */
  readonly memberId: Snowflake;
  /** The moderator issuing the warning. */
  readonly actorId: Snowflake;
  /**
   * The warning's stable identity — the parent event's id (the slash
   * command's interactionId). The escalation dedupe key binds to this, the
   * way the automod subscriber's binds to the message id: the counter can
   * advance across a crash-then-resume replay, and the key must not.
   */
  readonly warnId: Snowflake;
  readonly reason: string;
  readonly now: number;
  readonly auth: Authorized<'moderation.act'>;
}

export interface IssueWarnDeps {
  readonly guildId: Snowflake;
  readonly repo: WarnCasePorts;
  readonly moderationGateway: ModerationGatewayPort;
  readonly logger: Logger;
}

export interface IssueWarnResult {
  readonly caseId: string;
  readonly violationCount: number;
  /**
   * Present exactly when the warning pushed the counter across a tier and
   * the ladder's automatic consequence was attempted (applied, refused,
   * skipped, failed, or dry-run). Absent below the first tier.
   */
  readonly escalation: ModerationOutcome | undefined;
}

/**
 * One value per `ModerationOutcome` variant for the ladder's automatic
 * consequence, mirroring the automod subscriber's map but with
 * `'manual_applied'` for the applied case: nothing was deleted here, so
 * `'deleted_and_escalated'`'s name would claim a deletion (ADR 0036's whole
 * point) on a warn-escalated timeout that never deleted anything.
 */
const ESCALATION_ACTION_TAKEN: Record<
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

export const issueWarn = (deps: IssueWarnDeps, input: IssueWarnInput): Promise<IssueWarnResult> =>
  (async () => {
    // One counter, two sources (ADR 0037): this is the same call the automod
    // subscriber makes for an enforced strike, and the same "one open case
    // per member" index resolves into it.
    const { caseId, violationCount } = deps.repo.openOrResolveCase({
      memberId: input.memberId,
      now: input.now,
      countsAsViolation: true,
    });

    deps.repo.recordCaseEvent({
      eventId: crypto.randomUUID(),
      caseId,
      ruleId: MANUAL_RULE_ID,
      memberId: input.memberId,
      at: input.now,
      matchedCategory: MANUAL_RULE_ID,
      matchedSnippet: input.reason,
      actionTaken: 'warned',
      actorId: input.actorId,
    });

    const tier = deps.repo.nextEscalationTier(violationCount);
    if (tier.action === undefined) return { caseId, violationCount, escalation: undefined };

    const outcome = await deps.moderationGateway.applyAction(input.auth, {
      userId: input.memberId,
      action: tier.action,
      timeoutMs: tier.timeoutMs,
      // Bound to the warning's stable identity (the parent interaction id),
      // not to the counter: the claim survives a crash between claim and
      // REST call, and a resumed-replay of the same warn must skip, even
      // though the counter has since advanced (rule 6 — same shape as the
      // automod key's binding to the message id).
      dedupeKey: `mod:${deps.guildId}:warn-escalation:${caseId}:${input.warnId}`,
      reason: `automatic escalation after ${violationCount} violations (last: ${input.reason})`,
    } as ModerationIntent);

    deps.repo.recordEscalationOutcome({
      eventId: crypto.randomUUID(),
      caseId,
      ruleId: MANUAL_RULE_ID,
      memberId: input.memberId,
      at: input.now,
      matchedCategory: MANUAL_RULE_ID,
      matchedSnippet: input.reason,
      actionTaken: ESCALATION_ACTION_TAKEN[outcome.status],
      escalationAction: tier.action,
      refusalReason: outcome.status === 'refused' ? outcome.reason : undefined,
      actorId: input.actorId,
    });

    deps.logger.info(
      safeLogFields({
        component: 'moderation',
        guildId: deps.guildId,
        memberId: input.memberId,
        actorId: input.actorId,
        violationCount,
        escalation: outcome.status,
      }),
      'moderator warning issued; see the case event for the outcome',
    );

    return { caseId, violationCount, escalation: outcome };
  })();
