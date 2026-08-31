import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { ModerationIntent, ModerationOutcome } from '../effects/moderation-gateway.js';
import type { Authorized } from '../authz.js';
import { parseSnowflakeId } from '../ids.js';
import { buildMatcher, stripZeroWidth } from './matcher.js';

/**
 * The automod subscriber (ADR 0035, Task 9): the decision logic that turns a
 * matcher hit into a moderation outcome, and — the thing this task exists to
 * fix relative to Release 1 — a *durable* record even when the moderation
 * gateway refuses.
 *
 * Every dependency arrives as a port on `AutomodSubscriberDeps`. This module
 * never imports `@bananasaurs/storage` (ADR 0014); the concrete repo calls
 * are wired in Task 10.
 */

/**
 * Mirrors `packages/storage/src/repos/automod-rules.ts`'s `RuleWithWordList`
 * field for field (confirmed against that file while implementing this
 * task). Declared again here rather than imported, per the boundary rule
 * above — packages/core depends on the shape, not the package.
 */
export interface RuleWithWordList {
  readonly ruleId: string;
  readonly mode: 'test' | 'observe' | 'enforce';
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
}

/**
 * The narrow slice of `ModerationActionGateway` this subscriber calls.
 *
 * An interface rather than the concrete class from `effects/moderation-gateway.js`
 * on purpose: `ModerationActionGateway` has a private field, so TypeScript's
 * structural typing would refuse any test fake that isn't literally an
 * instance of that class, forcing every subscriber test to build a real
 * gateway (a `DiscordPort` fake, safety state, claims store) just to satisfy
 * the type. A real `ModerationActionGateway` instance already satisfies this
 * interface structurally, so Task 10's wiring is unaffected; only the tests
 * get to fake something this small.
 */
export interface ModerationGatewayPort {
  applyAction(
    auth: Authorized<'moderation.act'>,
    intent: ModerationIntent,
  ): Promise<ModerationOutcome>;
}

export interface AutomodSubscriberDeps {
  readonly logger: Logger;
  /** Re-verified inside the gateway on every call; held here only to pass through. */
  readonly moderationAuth: Authorized<'moderation.act'>;
  listRules(): readonly RuleWithWordList[];
  isExempt(ruleId: string, input: { authorRoleIds: readonly string[]; channelId: string }): boolean;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;
  openOrResolveCase(memberId: string): { caseId: string; violationCount: number };
  recordCaseEvent(input: {
    caseId: string;
    ruleId: string;
    memberId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: 'deleted' | 'deleted_and_escalated' | 'escalation_refused';
    escalationAction: 'timeout' | 'kick' | undefined;
    refusalReason: string | undefined;
  }): void;
  nextEscalationTier(violationCount: number): {
    action: 'timeout' | 'kick' | undefined;
    timeoutMs: number | undefined;
  };
  readonly moderationGateway: ModerationGatewayPort;
  authorRoleIds(userId: string): readonly string[];
}

/**
 * One matcher per rule, cached and rebuilt whenever a new `ruleId` is seen.
 *
 * Module-level, per the design spec's instruction to keep this "a plain Map
 * in the subscriber's own module state, not a new abstraction" — appropriate
 * because Bananasaurs runs one process for one guild (ADR 0006, CLAUDE.md).
 * It has no invalidation: a rule whose word list changes after its matcher
 * has been built keeps matching on the stale list until the process
 * restarts. That is out of scope for this task per the implementation plan,
 * but it is a real gap Task 10 (or a later slice) should close — most
 * plausibly by keying the cache on a content hash/version rather than bare
 * `ruleId`, or by having the rule-editing command bump a version the
 * subscriber checks.
 */
const matcherCache = new Map<string, ReturnType<typeof buildMatcher>>();

export const createAutomodSubscriber = (deps: AutomodSubscriberDeps): Subscriber => ({
  name: 'automod',
  async handle(event) {
    if (event.kind !== 'messageCreate' && event.kind !== 'messageUpdate') return;
    if (event.authorId === undefined || event.content === undefined) return;

    const authorId = event.authorId;
    const normalized = stripZeroWidth(event.content);
    const roleIds = deps.authorRoleIds(authorId);

    for (const rule of deps.listRules()) {
      if (deps.isExempt(rule.ruleId, { authorRoleIds: roleIds, channelId: event.channelId })) {
        continue;
      }

      // Building and running the matcher are both wrapped here — not just
      // `match()` — so a rule whose word list fails to compile (a malformed
      // pattern) is skipped the same way a matcher that throws mid-match is:
      // logged, and every other rule still runs for this message.
      let hit: { categoryId: string; snippet: string } | undefined;
      try {
        let matcher = matcherCache.get(rule.ruleId);
        if (matcher === undefined) {
          matcher = buildMatcher(rule.terms, rule.allowlist);
          matcherCache.set(rule.ruleId, matcher);
        }
        hit = matcher.match(normalized);
      } catch (err) {
        deps.logger.error(
          safeLogFields({
            component: 'automod',
            guildId: event.guildId,
            ruleId: rule.ruleId,
            err,
          }),
          'matcher threw; message left unmatched for this rule',
        );
        continue;
      }
      if (hit === undefined) continue;

      const { caseId, violationCount } = deps.openOrResolveCase(authorId);

      // Delete first, then decide escalation. A refused escalation must never
      // leave the offending message in place — the two are independent
      // outcomes, and deletion has already succeeded by the time escalation
      // is even attempted.
      if (rule.mode === 'enforce') {
        await deps.deleteMessage(event.channelId, event.messageId, `automod: ${rule.ruleId}`);
      }

      const tier = deps.nextEscalationTier(violationCount);

      // Non-enforce modes never reach the moderation gateway — test/observe
      // record what would have happened without ever calling Discord. Same
      // for enforce mode when the violation count has not crossed a tier.
      if (rule.mode !== 'enforce' || tier.action === undefined) {
        deps.recordCaseEvent({
          caseId,
          ruleId: rule.ruleId,
          memberId: authorId,
          matchedCategory: hit.categoryId,
          matchedSnippet: hit.snippet,
          actionTaken: 'deleted',
          escalationAction: undefined,
          refusalReason: undefined,
        });
        continue;
      }

      const outcome = await deps.moderationGateway.applyAction(deps.moderationAuth, {
        userId: parseSnowflakeId(authorId),
        action: tier.action,
        timeoutMs: tier.timeoutMs,
        dedupeKey: `${event.guildId}:${caseId}:${rule.ruleId}:${event.messageId}`,
        reason: `automod escalation: ${rule.ruleId}`,
      });

      // ADR 0035's core requirement: a refusal is recorded durably, not
      // merely logged (Release 1's role-effect refusals were log-only). The
      // message deletion above already happened and is not undone here.
      deps.recordCaseEvent({
        caseId,
        ruleId: rule.ruleId,
        memberId: authorId,
        matchedCategory: hit.categoryId,
        matchedSnippet: hit.snippet,
        actionTaken: outcome.status === 'refused' ? 'escalation_refused' : 'deleted_and_escalated',
        escalationAction: tier.action,
        refusalReason: outcome.status === 'refused' ? outcome.reason : undefined,
      });
    }
  },
});
