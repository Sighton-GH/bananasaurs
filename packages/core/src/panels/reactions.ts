import type { DiscordMessageRef, EmojiKey, Snowflake } from '../discord/port.js';
import { isSnowflakeId, type GuildId, type SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import type { EffectSource } from '../effects/rate-limit.js';
import {
  intentsFor,
  isEmptyPlan,
  needsFullReactionState,
  planConvergence,
  type ConvergencePlan,
} from './convergence.js';
import { optionByEmoji, type PanelConfig } from './model.js';
import type { PanelDiscordReader, PanelEffects, PanelStore } from './ports.js';

/**
 * Reactions into role changes.
 *
 * A reaction event is **a hint that a message's reaction state may have
 * changed**, not an instruction. It carries no fingerprint and is not
 * deduplicated (`core/src/pipeline/fingerprint.ts`), because
 * `(message, user, emoji, action)` is not unique over time — a member may
 * react, un-react and react again, all legitimately.
 *
 * So the handler converges instead of applying a delta, and a replay is free:
 * the gateway's no-op check against the member's live roles runs *before* the
 * rate cap and *before* the idempotency claim, so a second pass over unchanged
 * state costs no budget and writes no row.
 */

export interface ReactionSubscriberDeps {
  readonly guildId: GuildId;
  /** Our own reactions are the seeded ones; reacting to them is not a request. */
  readonly botUserId: Snowflake;
  readonly store: PanelStore;
  readonly discord: PanelDiscordReader;
  readonly effects: PanelEffects;
  readonly logger: Logger;
  now(): number;
  /** `trigger_ref` for a reaction-driven effect. A fresh id per pass. */
  newPassId(): string;
}

/**
 * Reaction state for one message, fetched at most once per pass.
 *
 * **Per pass, and deliberately not shared between live events.** `docs/19` §6.4
 * describes memoising so "a burst on the same panel does not refetch", and for
 * the pass that matters — adoption or reconciliation walking many members
 * against one snapshot — that is exactly what this does. Carrying a cache
 * across separate live events would be a correctness bug rather than an
 * optimisation: the next event is *usually the very member whose reaction is
 * missing from the cached set*, and they would be denied the role they just
 * asked for. A stale read that silently withholds a role is worse than an extra
 * REST call on a 30-member server.
 */
export class ReactionStateCache {
  readonly #byEmoji = new Map<string, Promise<readonly Snowflake[]>>();

  constructor(
    private readonly discord: PanelDiscordReader,
    private readonly guildId: GuildId,
  ) {}

  reactors(ref: DiscordMessageRef, emoji: EmojiKey): Promise<readonly Snowflake[]> {
    const key = `${ref.channelId}/${ref.messageId}/${emoji}`;
    const existing = this.#byEmoji.get(key);
    if (existing) return existing;
    const fetched = pageReactors(this.discord, this.guildId, ref, emoji);
    this.#byEmoji.set(key, fetched);
    return fetched;
  }
}

/** Discord pages reaction users at 100, whatever you ask for. */
const MAX_REACTION_PAGES = 200;

export async function pageReactors(
  discord: PanelDiscordReader,
  guildId: GuildId,
  ref: DiscordMessageRef,
  emoji: EmojiKey,
): Promise<readonly Snowflake[]> {
  const users: Snowflake[] = [];
  let after: Snowflake | undefined;
  for (let page = 0; page < MAX_REACTION_PAGES; page += 1) {
    const result = await discord.fetchReactionUsers(guildId, ref, emoji, { after, limit: 100 });
    users.push(...result.userIds);
    if (result.nextAfter === undefined) return users;
    after = result.nextAfter;
  }
  // A message with 20,000 reactors is not a panel, it is an incident. Refusing
  // is better than paging forever inside a job that holds a worker slot.
  throw new Error(
    `refusing to page beyond ${MAX_REACTION_PAGES * 100} reactors on message ${ref.messageId}`,
  );
}

/** Which of a panel's options this member has reacted to, across every emoji. */
export async function selectionFromReactions(
  panel: PanelConfig,
  userId: Snowflake,
  ref: DiscordMessageRef,
  cache: ReactionStateCache,
): Promise<Set<string>> {
  const selected = new Set<string>();
  for (const option of panel.options) {
    if (option.emojiKey === undefined) continue;
    const reactors = await cache.reactors(ref, option.emojiKey);
    if (reactors.includes(userId)) selected.add(option.optionId);
  }
  return selected;
}

export interface ConvergeMemberInput {
  readonly panel: PanelConfig;
  readonly userId: SnowflakeId;
  readonly selectedOptionIds: ReadonlySet<string>;
  readonly limitToOptionIds?: ReadonlySet<string> | undefined;
  readonly source: EffectSource;
  readonly reason: string;
  /** Interaction id for a button; a fresh pass id for a reaction. */
  readonly triggerRef?: string | undefined;
  /** Reuses one batch across a multi-member pass. */
  readonly batchId?: string | undefined;
}

export interface ConvergeMemberResult {
  readonly plan: ConvergencePlan;
  readonly applied: number;
  readonly skipped: number;
  readonly refused: number;
}

/**
 * Converges one member against one panel, and records what happened.
 *
 * The live member fetch is what makes amendment 4 true in code: the diff is
 * against Discord's answer to "does this member have this role", never against
 * `managed_role_assignments`.
 */
export async function convergeMember(
  deps: ReactionSubscriberDeps,
  input: ConvergeMemberInput,
): Promise<ConvergeMemberResult> {
  const member = await deps.discord.fetchMember(deps.guildId, input.userId);

  const plan = planConvergence({
    panel: input.panel,
    selectedOptionIds: input.selectedOptionIds,
    currentRoleIds: new Set(member.roleIds),
    limitToOptionIds: input.limitToOptionIds,
  });

  return applyPlan(deps, { ...input, plan });
}

/**
 * Applies a plan that was computed earlier.
 *
 * Split out for the adoption pass, which computes every member's plan first so
 * it can show the owner one total before anything happens (`docs/19` §6.4). A
 * plan can be stale by the time it is applied — somebody may have left, or a
 * role may have been deleted — and that is safe: the gateway re-reads live
 * roles and degrades a stale intent to `skipped`, not to a wrong write.
 */
export async function applyPlan(
  deps: ReactionSubscriberDeps,
  input: ConvergeMemberInput & { plan: ConvergencePlan },
): Promise<ConvergeMemberResult> {
  const { plan } = input;

  if (isEmptyPlan(plan)) {
    deps.logger.debug(
      safeLogFields({
        component: 'panels',
        guildId: deps.guildId,
        panelId: input.panel.panelId,
        userId: input.userId,
        outcome: 'no-change',
        reason: plan.refusedBecause,
      }),
      'convergence found nothing to do',
    );
    return { plan, applied: 0, skipped: 0, refused: 0 };
  }

  // Opened only when there is work, so a quiet panel does not accumulate empty
  // batch rows that `undo` would offer as choices.
  const batchId = input.batchId ?? deps.effects.openBatch(input.source);
  const ownsBatch = input.batchId === undefined;
  const triggerRef = input.triggerRef ?? deps.newPassId();

  let applied = 0;
  let skipped = 0;
  let refused = 0;

  try {
    for (const intent of intentsFor(plan, {
      panelId: input.panel.panelId,
      userId: input.userId,
      triggerRef,
      source: input.source,
      batchId,
      reason: input.reason,
    })) {
      const outcome = await deps.effects.apply(intent);
      switch (outcome.status) {
        case 'applied':
          applied += 1;
          // Provenance, written after the fact and never read for state.
          if (intent.action === 'grant') {
            deps.effects.recordGranted({
              userId: intent.userId,
              roleId: intent.roleId,
              panelId: input.panel.panelId,
              effectId: outcome.effectId,
              now: deps.now(),
            });
          } else {
            deps.effects.forgetGranted({ userId: intent.userId, roleId: intent.roleId });
          }
          break;
        case 'dry-run':
        case 'skipped':
          skipped += 1;
          break;
        default:
          refused += 1;
          deps.logger.warn(
            safeLogFields({
              component: 'panels',
              guildId: deps.guildId,
              panelId: input.panel.panelId,
              userId: intent.userId,
              roleId: intent.roleId,
              action: intent.action,
              batchId,
              outcome: outcome.status,
              reason: outcome.status === 'refused' ? outcome.reason : outcome.code,
            }),
            'the gateway did not apply a panel change',
          );
      }
    }
  } finally {
    if (ownsBatch) deps.effects.closeBatch(batchId);
  }

  return { plan, applied, skipped, refused };
}

/**
 * The pipeline subscriber for adopted panels.
 *
 * Everything it ignores, it ignores for a stated reason — a reaction on a
 * message that is not a panel, an emoji the panel does not map, and above all
 * our own seeded reactions, which would otherwise grant the bot a role the
 * moment it seeded a panel.
 */
export const createReactionSubscriber = (deps: ReactionSubscriberDeps): Subscriber => ({
  name: 'panels',
  async handle(event) {
    if (event.kind !== 'reactionAdd' && event.kind !== 'reactionRemove') return;
    if (event.userId === deps.botUserId) return;

    const panel = deps.store.findPanelByMessage(event.channelId, event.messageId);
    if (panel === undefined) return;

    const option = optionByEmoji(panel, event.emoji);
    if (option === undefined) {
      deps.logger.debug(
        safeLogFields({
          component: 'panels',
          guildId: deps.guildId,
          panelId: panel.panelId,
          messageId: event.messageId,
          outcome: 'unmapped-emoji',
        }),
        'a reaction the panel does not offer',
      );
      return;
    }

    const ref = { channelId: event.channelId, messageId: event.messageId };
    const userId = asSnowflake(event.userId);

    // Amendment 6. `toggle`, `add_only` and `remove_only` decide each option on
    // its own, so the single emoji the event carried is enough and the pass is
    // limited to that option. Only `max_roles` needs the whole set.
    let selectedOptionIds: ReadonlySet<string>;
    let limitToOptionIds: ReadonlySet<string> | undefined;
    if (needsFullReactionState(panel)) {
      const cache = new ReactionStateCache(deps.discord, deps.guildId);
      selectedOptionIds = await selectionFromReactions(panel, event.userId, ref, cache);
      limitToOptionIds = undefined;
    } else {
      selectedOptionIds = event.kind === 'reactionAdd' ? new Set([option.optionId]) : new Set();
      limitToOptionIds = new Set([option.optionId]);
    }

    await convergeMember(deps, {
      panel,
      userId,
      selectedOptionIds,
      limitToOptionIds,
      source: 'reaction',
      reason: `role panel ${panel.panelId}`,
    });
  },
});

/**
 * A user id from a gateway event.
 *
 * The adapter has already validated it, but this module's own signatures take
 * `SnowflakeId` and a cast onto that type is banned by the lint tripwire — so
 * the narrowing happens through the predicate, which is what the ban is for.
 */
const asSnowflake = (value: string): SnowflakeId => {
  if (!isSnowflakeId(value)) {
    throw new Error(`a gateway event carried a user id that is not a snowflake: ${value}`);
  }
  return value;
};
