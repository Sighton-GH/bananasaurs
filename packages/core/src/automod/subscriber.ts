import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type {
  ModerationIntent,
  ModerationOutcome,
  ModerationSafetyState,
} from '../effects/moderation-gateway.js';
import type { Authorized } from '../authz.js';
import { DiscordApiError } from '../discord/errors.js';
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

/**
 * What actually happened on one match, in `mod_case_events.action_taken`'s
 * vocabulary (`packages/storage/src/repos/mod-cases.ts` holds the same union
 * and `schema.ts` holds the CHECK constraint that enforces it).
 *
 * Declared here rather than imported, per this module's `@bananasaurs/storage`
 * boundary rule (ADR 0014) — the same way `RuleWithWordList` is.
 */
export type AutomodActionTaken =
  | 'deleted'
  | 'deleted_and_escalated'
  | 'escalation_refused'
  | 'escalation_failed'
  | 'escalation_dry_run'
  | 'escalation_skipped'
  | 'would_delete'
  | 'delete_failed'
  | 'delete_blocked_killswitch'
  | 'delete_blocked_breaker'
  | 'delete_blocked_dry_run'
  | 'delete_blocked_guild_unknown'
  /**
   * Native Discord AutoMod acted (ADR 0038). Recorded, never counted.
   */
  | 'native_blocked'
  | 'native_alerted'
  | 'native_timeout'
  | 'native_blocked_interaction';

export interface AutomodSubscriberDeps {
  readonly logger: Logger;
  /** Re-verified inside the gateway on every call; held here only to pass through. */
  readonly moderationAuth: Authorized<'moderation.act'>;
  listRules(): readonly RuleWithWordList[];
  /**
   * Whether this rule has a **role**-type exemption at all — a local read,
   * unlike the role ids it decides whether to fetch.
   *
   * `isExempt` needs the author's role ids, and getting those is a REST call
   * (`authorRoleIds` below). Asking this first means a guild whose rules
   * exempt only channels — or nothing — never makes that call, which is
   * otherwise one uncached `GET /guilds/{g}/members/{u}` per message in the
   * guild, on the latency path in front of a deletion.
   */
  hasRoleExemption(ruleId: string): boolean;
  isExempt(ruleId: string, input: { authorRoleIds: readonly string[]; channelId: string }): boolean;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;
  /**
   * Resolves the member's case so an event can be attached to it, and — only
   * when `countsAsViolation` — moves the per-member violation counter the
   * escalation ladder reads.
   *
   * The counter is what `nextEscalationTier` turns into a timeout or a kick,
   * so it must only ever count violations that were actually *enforced*.
   * Counting a `test`/`observe` match defeats the documented rollout (spec
   * §8: ship in test mode, review and tune, then flip to enforce) — every
   * match during the observation period would have quietly pushed ordinary
   * members up the ladder, and the first real match after the flip could go
   * straight to a kick. Counting a match a safety layer blocked has the same
   * failure the moment the kill switch or dry run is turned off.
   */
  openOrResolveCase(
    memberId: string,
    options: { countsAsViolation: boolean },
  ): { caseId: string; violationCount: number };
  recordCaseEvent(input: {
    caseId: string;
    ruleId: string;
    memberId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: AutomodActionTaken;
    escalationAction: 'timeout' | 'kick' | undefined;
    refusalReason: string | undefined;
  }): void;
  /**
   * The guild's live safety state — the *same* read
   * `ModerationActionGateway.deps.state.read()` performs
   * (`guildRepo.readSafetyState(scope)`, bound in `automod/wiring.ts`), so the
   * deletion and the escalation can never disagree about whether this guild is
   * stopped or in dry run. `undefined` means the guild is not in the database,
   * which the gateway refuses as `'guild-unknown'` and this subscriber treats
   * as "do not touch Discord" for the same reason.
   *
   * Without this the enforce-mode delete was the one Discord side effect in
   * the process with no safety layer in front of it: an unconfigured guild
   * defaults to dry run (docs/18 Layer 4) and would still have had real
   * members' messages really deleted.
   */
  readSafetyState(): ModerationSafetyState | undefined;
  nextEscalationTier(violationCount: number): {
    action: 'timeout' | 'kick' | undefined;
    timeoutMs: number | undefined;
  };
  readonly moderationGateway: ModerationGatewayPort;
  /**
   * Async, unlike the rest of this interface's synchronous lookups
   * (`isExempt`, `openOrResolveCase`, `nextEscalationTier`) — corrected during
   * Task 10's wiring. `DiscordPort.fetchMember` (`discord/port.ts`) is the
   * only real source of a member's role ids and it is a REST call; there is
   * no synchronous path to them. `handle` below already awaits everything
   * else it calls that can fail or take time, so awaiting this too costs
   * nothing this module wasn't already paying.
   */
  authorRoleIds(userId: string): Promise<readonly string[]>;
}

/**
 * One matcher per `(guildId, ruleId)`, cached and rebuilt whenever a new key
 * is seen.
 *
 * Module-level, per the design spec's instruction to keep this "a plain Map
 * in the subscriber's own module state, not a new abstraction". Module-level
 * state is shared by every guild in the process, though, which is exactly why
 * the key must carry the guild id (CLAUDE.md rule 2): the daemon supports N
 * allowlisted guilds, one subscriber instance each, all reading this one Map,
 * and every seeded guild names its default rule `'default-word-filter'`.
 *
 * It still has no invalidation: a rule whose word list changes after its
 * matcher has been built keeps matching on the stale list until the process
 * restarts. That is out of scope per the implementation plan, but it is a
 * real gap a later slice should close — most plausibly by extending the key
 * with a content hash/version, or by having the rule-editing command bump a
 * version the subscriber checks.
 */
const matcherCache = new Map<string, ReturnType<typeof buildMatcher>>();

/**
 * One `action_taken` value per `ModerationOutcome` variant, after a deletion
 * that really happened.
 *
 * `'skipped'` gets its own value rather than folding into
 * `'deleted_and_escalated'`: the two are different facts about the member's
 * history. `'skipped'` means the gateway's idempotency claim (layer 9) found
 * the identical action already recorded, so *this* event applied nothing — a
 * moderator counting timeouts from case history would otherwise count the
 * same timeout twice, and a replayed gateway event (CLAUDE.md rule 6 assumes
 * replays) is exactly how that happens.
 */
const ESCALATION_ACTION_TAKEN: Record<ModerationOutcome['status'], AutomodActionTaken> = {
  applied: 'deleted_and_escalated',
  refused: 'escalation_refused',
  failed: 'escalation_failed',
  'dry-run': 'escalation_dry_run',
  skipped: 'escalation_skipped',
};

export const createAutomodSubscriber = (deps: AutomodSubscriberDeps): Subscriber => ({
  name: 'automod',
  async handle(event) {
    if (event.kind !== 'messageCreate' && event.kind !== 'messageUpdate') return;
    // Never moderate a bot — this one included. discord.js emits
    // `MessageCreate` for our own messages, and the `message_delete` logging
    // route quotes the deleted content, so an enforce-mode rule that deletes
    // a message would then match the log entry about that deletion, delete
    // that, and loop — opening a case against the bot's own user id every
    // lap. Every bot and webhook is skipped, not only this bot's own id:
    // another bot's output is not a member's speech to moderate either.
    if (event.authorIsBot) return;
    if (event.authorId === undefined || event.content === undefined) return;

    // Before anything else that costs something: a guild with no enabled
    // keyword-filter rule has nothing to check and nothing to fetch.
    const rules = deps.listRules();
    if (rules.length === 0) return;

    const authorId = event.authorId;
    const normalized = stripZeroWidth(event.content);

    /**
     * The author's role ids, fetched at most once per message and only if a
     * rule actually has a role exemption to check them against.
     *
     * A failure resolves to "no roles" rather than propagating: `fetchMember`
     * throws for an author who is not a guild member (a webhook, an
     * application-owned message, somebody who left between posting and
     * processing), and such a message must still be evaluated — with no
     * role-based exemption applying — rather than crashing the handler and
     * skipping every rule.
     */
    let fetchedRoleIds: readonly string[] | undefined;
    const roleIdsOnce = async (): Promise<readonly string[]> => {
      if (fetchedRoleIds === undefined) {
        try {
          fetchedRoleIds = await deps.authorRoleIds(authorId);
        } catch (err) {
          fetchedRoleIds = [];
          deps.logger.warn(
            safeLogFields({ component: 'automod', guildId: event.guildId, err }),
            'could not read the author’s roles; evaluating with no role exemptions',
          );
        }
      }
      return fetchedRoleIds;
    };

    for (const rule of rules) {
      const authorRoleIds = deps.hasRoleExemption(rule.ruleId) ? await roleIdsOnce() : [];
      if (deps.isExempt(rule.ruleId, { authorRoleIds, channelId: event.channelId })) {
        continue;
      }

      // Building and running the matcher are both wrapped here — not just
      // `match()` — so a rule whose word list fails to compile (a malformed
      // pattern) is skipped the same way a matcher that throws mid-match is:
      // logged, and every other rule still runs for this message.
      let hit: { categoryId: string; snippet: string } | undefined;
      try {
        // Guild-scoped, per CLAUDE.md rule 2 — a bare `ruleId` is not a key.
        // `daemon.ts` seeds every guild's default rule under the same id
        // (`'default-word-filter'`), so with a bare key whichever guild spoke
        // first decided what every other guild was matched against.
        const cacheKey = `${event.guildId}:${rule.ruleId}`;
        let matcher = matcherCache.get(cacheKey);
        if (matcher === undefined) {
          matcher = buildMatcher(rule.terms, rule.allowlist);
          matcherCache.set(cacheKey, matcher);
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

      const record = (
        caseId: string,
        actionTaken: AutomodActionTaken,
        escalationAction?: 'timeout' | 'kick',
        refusalReason?: string,
      ): void => {
        deps.recordCaseEvent({
          caseId,
          ruleId: rule.ruleId,
          memberId: authorId,
          matchedCategory: hit.categoryId,
          matchedSnippet: hit.snippet,
          actionTaken,
          escalationAction,
          refusalReason,
        });
      };

      // Non-enforce modes never touch Discord at all: test/observe record
      // what *would* have happened. `'would_delete'`, not `'deleted'` — the
      // old vocabulary reused the deletion value here, so case history could
      // not tell an observation apart from a real removal.
      if (rule.mode !== 'enforce') {
        record(
          deps.openOrResolveCase(authorId, { countsAsViolation: false }).caseId,
          'would_delete',
        );
        continue;
      }

      // docs/18: every Discord side effect passes the safety layers first,
      // and a message deletion is a Discord side effect. Checked here rather
      // than only inside `ModerationActionGateway` because the deletion does
      // not go through that gateway — it is a direct `DiscordPort` call.
      const state = deps.readSafetyState();
      const blocked: AutomodActionTaken | undefined =
        state === undefined
          ? 'delete_blocked_guild_unknown'
          : state.killswitch
            ? 'delete_blocked_killswitch'
            : state.breakerOpen
              ? 'delete_blocked_breaker'
              : state.dryRun
                ? 'delete_blocked_dry_run'
                : undefined;

      if (blocked !== undefined) {
        // Durably recorded, not merely logged — the same requirement ADR 0035
        // imposes on a refused escalation. A moderator reading the case sees
        // "this would have been deleted but was not, and why".
        record(deps.openOrResolveCase(authorId, { countsAsViolation: false }).caseId, blocked);
        deps.logger.warn(
          safeLogFields({
            component: 'automod',
            guildId: event.guildId,
            ruleId: rule.ruleId,
            outcome: blocked,
          }),
          'a safety layer stopped the automod deletion; nothing was sent to Discord',
        );
        continue;
      }

      // Delete first, then decide escalation. A refused escalation must never
      // leave the offending message in place — the two are independent
      // outcomes, and deletion has already succeeded by the time escalation
      // is even attempted.
      let deleted = true;
      try {
        await deps.deleteMessage(event.channelId, event.messageId, `automod: ${rule.ruleId}`);
      } catch (err) {
        // The design spec (§6): a message already deleted by the time
        // Bananasaurs tries "is treated as success, not a failure — the
        // outcome (message gone) is what the rule wanted". `isGone` is the
        // established idiom for this in `panels/reconcile.ts`; for a message
        // deletion the only code in that set Discord can return is 10008,
        // Unknown Message.
        if (err instanceof DiscordApiError && err.isGone) {
          deps.logger.info(
            safeLogFields({
              component: 'automod',
              guildId: event.guildId,
              ruleId: rule.ruleId,
              outcome: 'already-deleted',
            }),
            'the message was already gone; treating the deletion as done',
          );
        } else {
          deleted = false;
          deps.logger.error(
            safeLogFields({
              component: 'automod',
              guildId: event.guildId,
              ruleId: rule.ruleId,
              outcome: 'delete_failed',
              err,
            }),
            'the automod deletion failed',
          );
        }
      }

      const { caseId, violationCount } = deps.openOrResolveCase(authorId, {
        countsAsViolation: true,
      });

      // A deletion Discord actually refused. Recorded rather than thrown —
      // an escaping rejection lost the case event entirely and skipped every
      // remaining rule for this message — and *not* escalated from: a timeout
      // or a kick on top of a message still sitting in the channel is the
      // wrong half of the action to have succeeded.
      if (!deleted) {
        record(caseId, 'delete_failed');
        continue;
      }

      const tier = deps.nextEscalationTier(violationCount);

      // Enforce mode, but the violation count has not crossed a tier: the
      // message really was deleted and nothing was escalated.
      if (tier.action === undefined) {
        record(caseId, 'deleted');
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
      // merely logged (Release 1's role-effect refusals were log-only). One
      // value per `ModerationOutcome` variant — the previous mapping wrote
      // `'deleted_and_escalated'` for a dry-run, a skip and a failure too,
      // recording a punishment that had not happened.
      record(
        caseId,
        ESCALATION_ACTION_TAKEN[outcome.status],
        tier.action,
        outcome.status === 'refused' ? outcome.reason : undefined,
      );
    }
  },
});
