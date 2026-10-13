import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type {
  DeleteMessageIntent,
  DeleteMessageOutcome,
  ModerationIntent,
  ModerationOutcome,
  ModerationSafetyState,
} from '../effects/moderation-gateway.js';
import type { Authorized } from '../authz.js';
import { DiscordApiError } from '../discord/errors.js';
import { parseSnowflakeId } from '../ids.js';
import {
  createPredicateCache,
  evaluateRule,
  predicateInputFrom,
  type PredicateCache,
} from './evaluate.js';
import type { AutomodRule, MatchTrace } from './predicates/types.js';

/**
 * The automod subscriber (ADR 0035, Task 9; rewired onto the predicate
 * registry by ADR 0040, Task 5): the decision logic that turns a predicate
 * match into a moderation outcome, and — the thing Task 9 existed to fix
 * relative to Release 1 — a *durable* record even when the moderation
 * gateway refuses.
 *
 * Every dependency arrives as a port on `AutomodSubscriberDeps`. This module
 * never imports `@bananasaurs/storage` (ADR 0014); the concrete repo calls
 * are wired in Task 10.
 */

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
  deleteMessage(
    auth: Authorized<'moderation.act'>,
    intent: DeleteMessageIntent,
  ): Promise<DeleteMessageOutcome>;
}

/**
 * What actually happened on one match, in `mod_case_events.action_taken`'s
 * vocabulary (`packages/storage/src/repos/mod-cases.ts` holds the same union
 * and `schema.ts` holds the CHECK constraint that enforces it).
 *
 * Declared here rather than imported, per this module's `@bananasaurs/storage`
 * boundary rule (ADR 0014) — the same way `AutomodRule` is.
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

/**
 * Everything the automod subscriber needs from the guild's safety row —
 * `ModerationSafetyState`'s three fields, plus ADR 0121's guild-wide switch.
 *
 * A distinct interface that *extends* `ModerationSafetyState` rather than a
 * field added to `ModerationSafetyState` itself (ruling PR-33, coordinator
 * decision — the plan's own Task 5 wording said "add it to the state
 * `readSafetyState` returns", which read literally would mean widening
 * `ModerationSafetyState`). `ModerationGatewayDeps.state.read()` and
 * `purge.ts`'s `classifyRefusal` both take a bare `ModerationSafetyState`,
 * and both must never be gated by whether automod is switched on for the
 * guild — widening the shared type would hand them a field only this module
 * may read, and a comment saying "don't read this" is caller discipline,
 * which CLAUDE.md rule 2 treats as the bug, not the guard. Storage's
 * `SafetyState` (`guilds.ts`) already carries `automodState` and is
 * structurally assignable to this interface without a second read —
 * `automod/wiring.ts` passes the same `guildRepo.readSafetyState(scope)`
 * call through unchanged.
 */
/** ADR 0121: re-declared here because core may not import storage. */
export type AutomodSwitchState = 'off' | 'watch' | 'on';
export interface AutomodSafetyState extends ModerationSafetyState {
  readonly automodState: AutomodSwitchState;
}

/**
 * One automod match, posted to log routes through `onMatchRecorded`
 * (ADR 0141 decision 3). Fired after the case event is written, never throws
 * into the subscriber. `parentChannelId`/`categoryId` travel along so
 * excluded channels are respected, the way the logging subscriber's own
 * `LogSource` carries them.
 */
export interface AutomodMatchInfo {
  readonly ruleId: string;
  readonly ruleKind: string;
  readonly memberId: string;
  readonly channelId: string;
  readonly parentChannelId: string | undefined;
  readonly categoryId: string | undefined;
  readonly messageId: string;
  readonly snippet: string;
  readonly actionTaken: AutomodActionTaken;
  readonly at: number;
}

export interface AutomodSubscriberDeps {
  readonly logger: Logger;
  /** Re-verified inside the gateway on every call; held here only to pass through. */
  readonly moderationAuth: Authorized<'moderation.act'>;
  listRules(): readonly AutomodRule[];
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
  isExempt(
    ruleId: string,
    input: {
      authorRoleIds: readonly string[];
      channelId: string;
      parentChannelId: string | undefined;
      categoryId: string | undefined;
    },
  ): boolean;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;
  /**
   * Resolves the member's case so an event can be attached to it, and — only
   * when `countsAsViolation` — moves the per-member violation counter the
   * escalation ladder reads.
   *
   * The counter is what `nextEscalationTier` turns into a timeout or a kick,
   * so it must only ever count violations that were actually *enforced*.
   * Counting a Watch match (ADR 0121) would quietly push ordinary members up
   * the ladder while nothing is being enforced, and the first real match after
   * switching On could go straight to a kick. Counting a match a safety layer blocked has the same
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
    channelId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: AutomodActionTaken;
    escalationAction: 'timeout' | 'kick' | undefined;
    refusalReason: string | undefined;
    /** Why the predicate matched (ADR 0040, ADR 0041 §4). */
    trace: MatchTrace;
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
  readSafetyState(): AutomodSafetyState | undefined;
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
  /**
   * Posted after the case event is written (ADR 0141 decision 3); the daemon
   * wires it to `createLogPoster`. Never throws into the subscriber: a
   * rejection is logged and the match itself stays recorded.
   */
  readonly onMatchRecorded?: ((info: AutomodMatchInfo) => Promise<void>) | undefined;
}

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

export const createAutomodSubscriber = (deps: AutomodSubscriberDeps): Subscriber => {
  const predicateCache: PredicateCache = createPredicateCache();
  return {
    name: 'automod',
    async handle(event) {
      if (event.kind !== 'messageCreate' && event.kind !== 'messageUpdate') return;
      // Never moderate a bot — this one included. discord.js emits
      // `MessageCreate` for our own messages, and the `message_delete` logging
      // route quotes the deleted content, so a rule that deletes
      // a message would then match the log entry about that deletion, delete
      // that, and loop — opening a case against the bot's own user id every
      // lap. Every bot and webhook is skipped, not only this bot's own id:
      // another bot's output is not a member's speech to moderate either.
      if (event.authorIsBot) return;
      const input = predicateInputFrom({ from: 'message', event });
      if (input === undefined) return;
      const authorId = input.authorId;

      // ADR 0121: one switch for the guild. Off — and an unknown guild,
      // which fails closed — means automod does nothing at all: no rule is
      // listed, no member fetched, nothing recorded.
      const state = deps.readSafetyState();
      if (state === undefined || state.automodState === 'off') return;

      // Before anything else that costs something: a guild with no enabled
      // keyword-filter rule has nothing to check and nothing to fetch.
      const rules = deps.listRules();
      if (rules.length === 0) return;

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
        if (
          deps.isExempt(rule.ruleId, {
            authorRoleIds,
            channelId: event.channelId,
            parentChannelId: event.parentChannelId,
            categoryId: event.categoryId,
          })
        ) {
          continue;
        }

        // `evaluation`, not `outcome`: this block shares a scope with the
        // moderation `outcome` further down, and the two are different kinds
        // of answer — one is "did the rule match", the other is "did Discord
        // apply the punishment". Naming them alike is how a later edit reaches
        // for the wrong one.
        const evaluation = evaluateRule(predicateCache, rule, input);
        if (evaluation.kind === 'unusable') {
          if (evaluation.firstSeen) {
            // Emitted once per broken configuration rather than once per
            // message, and again if the operator edits the rule — an edit
            // changes the fingerprint, which is what `firstSeen` tracks
            // (ADR 0040 §4). `doctor` reports the same rules as a failing
            // check, because a log line nobody is watching is how ADR 0039's
            // silent non-matching survived to production.
            deps.logger.error(
              safeLogFields({
                component: 'automod',
                guildId: event.guildId,
                ruleId: rule.ruleId,
                outcome: evaluation.reason,
                compileError: evaluation.detail,
              }),
              'the rule could not be compiled; it will not match until it is fixed',
            );
          }
          continue;
        }
        if (evaluation.kind === 'threw') {
          deps.logger.error(
            safeLogFields({
              component: 'automod',
              guildId: event.guildId,
              ruleId: rule.ruleId,
              err: evaluation.error,
            }),
            'the predicate threw; message left unmatched for this rule',
          );
          continue;
        }
        if (evaluation.kind === 'no-match') continue;
        const hit = evaluation.match;

        const record = async (
          caseId: string,
          actionTaken: AutomodActionTaken,
          escalationAction?: 'timeout' | 'kick',
          refusalReason?: string,
        ): Promise<void> => {
          deps.recordCaseEvent({
            caseId,
            ruleId: rule.ruleId,
            memberId: authorId,
            channelId: event.channelId,
            matchedCategory: hit.categoryId,
            matchedSnippet: hit.snippet,
            actionTaken,
            escalationAction,
            refusalReason,
            trace: hit.trace,
          });
          if (deps.onMatchRecorded !== undefined) {
            try {
              await deps.onMatchRecorded({
                ruleId: rule.ruleId,
                ruleKind: rule.kind,
                memberId: authorId,
                channelId: event.channelId,
                parentChannelId: event.parentChannelId,
                categoryId: event.categoryId,
                messageId: event.messageId,
                snippet: hit.snippet,
                actionTaken,
                at: event.receivedAtMs,
              });
            } catch (err) {
              deps.logger.error(
                safeLogFields({
                  component: 'automod',
                  guildId: event.guildId,
                  ruleId: rule.ruleId,
                  err,
                }),
                'failed to post an automod match to the log; the match itself is recorded',
              );
            }
          }
        };

        // Watch records what automod would have done and touches no one.
        // `would_delete`, never `deleted` (ADR 0036).
        if (state.automodState === 'watch') {
          await record(
            deps.openOrResolveCase(authorId, { countsAsViolation: false }).caseId,
            'would_delete',
          );
          continue;
        }

        // docs/18: every Discord side effect passes the safety layers first,
        // and a message deletion is a Discord side effect. Checked here rather
        // than only inside `ModerationActionGateway` because the deletion does
        // not go through that gateway — it is a direct `DiscordPort` call.
        const blocked: AutomodActionTaken | undefined = state.killswitch
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
          await record(
            deps.openOrResolveCase(authorId, { countsAsViolation: false }).caseId,
            blocked,
          );
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
          // ADR 0042 §2: a property of the rule, not a constant — a
          // delete-only rule (`countsAsViolation: false`) still deletes the
          // message but must not push the member up the escalation ladder.
          countsAsViolation: rule.countsAsViolation,
        });

        // A deletion Discord actually refused. Recorded rather than thrown —
        // an escaping rejection lost the case event entirely and skipped every
        // remaining rule for this message — and *not* escalated from: a timeout
        // or a kick on top of a message still sitting in the channel is the
        // wrong half of the action to have succeeded.
        if (!deleted) {
          await record(caseId, 'delete_failed');
          continue;
        }

        // A delete-only rule stops here, whatever the member's counter says.
        //
        // Not feeding the counter (`countsAsViolation: false`, above) is not the
        // same as not *reading* it: `openOrResolveCase` returns the member's
        // existing count, earned by other rules, and escalating on that would
        // time out or kick a member this rule never advanced — again on every
        // subsequent match, since the dedupe key includes `messageId`.
        //
        // ADR 0042 §4 holds a delete-only rule to a 5% false-positive rate
        // rather than zero **because removing the message is its only
        // consequence**. One wrong match in twenty is a tolerable price for a
        // deletion and not for a timeout, so a rule that could escalate has not
        // earned the looser tier it was admitted under.
        if (!rule.countsAsViolation) {
          await record(caseId, 'deleted');
          continue;
        }

        const tier = deps.nextEscalationTier(violationCount);

        // Enforce mode, but the violation count has not crossed a tier: the
        // message really was deleted and nothing was escalated.
        if (tier.action === undefined) {
          await record(caseId, 'deleted');
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
        await record(
          caseId,
          ESCALATION_ACTION_TAKEN[outcome.status],
          tier.action,
          outcome.status === 'refused' ? outcome.reason : undefined,
        );
      }
    },
  };
};
