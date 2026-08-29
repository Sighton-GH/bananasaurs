import { z } from 'zod';
import type { DiscordApiError } from '../discord/errors.js';
import type { DiscordMessageRef, Snowflake } from '../discord/port.js';
import { snowflakeIdSchema, type SnowflakeId } from '../ids.js';
import { safeLogFields } from '../obs/logger.js';
import type { EffectSource } from '../effects/rate-limit.js';
import { isEmptyPlan, planConvergence, type ConvergencePlan } from './convergence.js';
import type { AdoptionPassState, PanelConfig } from './model.js';
import {
  applyPlan,
  ReactionStateCache,
  reactorsIsolated,
  type ReactionSubscriberDeps,
} from './reactions.js';

/**
 * Adopting a panel that already has reactions on it.
 *
 * **Collision 2, `docs/19` §6.4.** A panel with 30 existing reactors needs 30
 * grants, and `docs/18` Layer 3 caps role mutations at 20/minute — tripping the
 * cap opens the breaker, which a human has to clear. So adopting any well-used
 * panel would halt partway through with roles half-applied.
 *
 * The fix is to distinguish **expected** bulk from **unexpected** bulk. This
 * pass computes its entire change list before touching anything, and then:
 *
 * - if an owner-approved allowance covers it, spends that allowance (which the
 *   token bucket consumes *before* the standing budget, so an approved batch
 *   does not finish late because members were clicking buttons meanwhile);
 * - otherwise **does nothing at all**, records the count, and leaves the panel
 *   `adoption_pass_state = 'pending'`.
 *
 * Refusing without an allowance is the finished behaviour for WP3, not a
 * placeholder. The CLI that lets the owner size and grant one is slice 13 in
 * WP5. There is deliberately no Discord-side confirmation: a mass-role-grant
 * trigger reachable from Discord is exactly the surface `docs/18` wants
 * smallest.
 */

/** Where the pass got to, so an interrupted run resumes instead of restarting. */
export const adoptionCursorSchema = z.object({
  computedAtMs: z.number().int().nonnegative(),
  /** The full change list, so the count the owner is shown is durable. */
  changes: z.array(
    z.object({
      userId: snowflakeIdSchema,
      roleId: snowflakeIdSchema,
      action: z.enum(['grant', 'revoke']),
    }),
  ),
  /** Members already converged in a previous attempt, by user id. */
  doneUserIds: z.array(snowflakeIdSchema).default([]),
});

export type AdoptionCursor = z.infer<typeof adoptionCursorSchema>;

export interface AdoptionPorts extends ReactionSubscriberDeps {
  /** Unconsumed owner-approved actions. Read, never granted, from here. */
  allowanceFor(source: EffectSource): number;
  setAdoptionPassState(panelId: string, state: AdoptionPassState): void;
}

export type AdoptionStatus =
  | 'adopted'
  /** The change list is computed and stored; it needs an owner's allowance. */
  | 'awaiting-allowance'
  | 'nothing-to-do';

export interface AdoptionOutcome {
  readonly status: AdoptionStatus;
  /** What the owner is asked to approve. */
  readonly changeCount: number;
  readonly memberCount: number;
  readonly applied: number;
  readonly skipped: number;
  readonly refused: number;
}

export interface AdoptionInput {
  readonly panelId: string;
  readonly cursor: string | null;
  saveCursor(cursor: string): void;
}

/**
 * Reads every reactor of every mapped emoji, once.
 *
 * The bot's own seeded reactions are excluded — adopting a panel must not grant
 * the bot the roles it just seeded.
 */
const selectionsByMember = async (
  panel: PanelConfig,
  ref: DiscordMessageRef,
  cache: ReactionStateCache,
  botUserId: Snowflake,
  onSkipped: (option: PanelConfig['options'][number], err: DiscordApiError) => void,
): Promise<Map<string, Set<string>>> => {
  const byMember = new Map<string, Set<string>>();
  for (const option of panel.options) {
    if (option.emojiKey === undefined) continue;
    const reactors = await reactorsIsolated(cache, ref, option.emojiKey, (err) =>
      onSkipped(option, err),
    );
    for (const userId of reactors) {
      if (userId === botUserId) continue;
      const existing = byMember.get(userId);
      if (existing) existing.add(option.optionId);
      else byMember.set(userId, new Set([option.optionId]));
    }
  }
  return byMember;
};

export async function runAdoptionPass(
  ports: AdoptionPorts,
  input: AdoptionInput,
): Promise<AdoptionOutcome> {
  const panel = ports.store.findPanel(input.panelId);
  if (panel === undefined) {
    throw new Error(`no panel '${input.panelId}' in this guild`);
  }
  if (panel.kind !== 'adopted') {
    // A managed panel is posted empty; there is nothing to adopt, and running
    // this against one would mean a bug upstream rather than a transient fault.
    throw new Error(`panel '${input.panelId}' is managed, so it has nothing to adopt`);
  }
  if (panel.messageId === undefined) {
    throw new Error(`adopted panel '${input.panelId}' has no message`);
  }

  const ref: DiscordMessageRef = { channelId: panel.channelId, messageId: panel.messageId };
  ports.setAdoptionPassState(panel.panelId, 'running');

  // --- 1. read the existing reaction state, once ------------------------
  // Existing reactions *are* the intended role state (docs/19 §6.4). One cache
  // for the whole pass, so a panel with five emoji costs five paged reads no
  // matter how many members reacted.
  const cache = new ReactionStateCache(ports.discord, ports.guildId);
  const selections = await selectionsByMember(panel, ref, cache, ports.botUserId, (option, err) => {
    ports.logger.warn(
      safeLogFields({
        component: 'panels',
        guildId: ports.guildId,
        panelId: panel.panelId,
        optionId: option.optionId,
        roleId: option.roleId,
        outcome: 'option-skipped',
        err,
      }),
      'skipping a panel option Discord refused to read reactions for',
    );
  });

  // Sorted so the pass is deterministic and a resumed run agrees with the run
  // that was interrupted.
  const members = [...selections.keys()].sort();

  const resumed = parseCursor(input.cursor);
  const alreadyDone = new Set(resumed?.doneUserIds ?? []);

  // --- 2. compute every member's plan before touching anything -----------
  const plans: { userId: SnowflakeId; plan: ConvergencePlan }[] = [];
  for (const userId of members) {
    if (!snowflakeIdSchema.safeParse(userId).success) continue;
    const parsed = snowflakeIdSchema.parse(userId);
    const member = await ports.discord.fetchMember(ports.guildId, userId);
    const plan = planConvergence({
      panel,
      selectedOptionIds: selections.get(userId) ?? new Set(),
      // Amendment 4: live Discord roles, so a member who already holds the role
      // costs nothing and does not inflate the count the owner is shown.
      currentRoleIds: new Set(member.roleIds),
    });
    if (!isEmptyPlan(plan)) plans.push({ userId: parsed, plan });
  }

  const changes = plans.flatMap(({ userId, plan }) => [
    ...plan.revokes.map((roleId) => ({ userId, roleId, action: 'revoke' as const })),
    ...plan.grants.map((roleId) => ({ userId, roleId, action: 'grant' as const })),
  ]);

  if (changes.length === 0) {
    ports.setAdoptionPassState(panel.panelId, 'done');
    ports.logger.info(
      safeLogFields({
        component: 'panels',
        guildId: ports.guildId,
        panelId: panel.panelId,
        count: 0,
        outcome: 'nothing-to-do',
      }),
      'adoption pass found every reactor already holding the right roles',
    );
    return {
      status: 'nothing-to-do',
      changeCount: 0,
      memberCount: members.length,
      applied: 0,
      skipped: 0,
      refused: 0,
    };
  }

  // The change list is stored before the allowance is checked, so the count an
  // owner is asked to approve is durable rather than living in a log line.
  input.saveCursor(
    JSON.stringify({
      computedAtMs: ports.now(),
      changes,
      doneUserIds: [...alreadyDone],
    } satisfies AdoptionCursor),
  );

  // --- 3. the allowance gate --------------------------------------------
  const allowance = ports.allowanceFor('adoption');
  if (allowance < changes.length) {
    ports.setAdoptionPassState(panel.panelId, 'pending');
    ports.logger.warn(
      safeLogFields({
        component: 'panels',
        guildId: ports.guildId,
        panelId: panel.panelId,
        count: changes.length,
        limit: allowance,
        total: members.length,
        outcome: 'awaiting-allowance',
      }),
      'adoption pass computed its change list and is waiting for an owner-sized allowance',
    );
    return {
      status: 'awaiting-allowance',
      changeCount: changes.length,
      memberCount: members.length,
      applied: 0,
      skipped: 0,
      refused: 0,
    };
  }

  // --- 4. spend it ------------------------------------------------------
  // One batch for the whole pass, so `bananasaurs undo <batch>` can reverse an
  // adoption that turned out to be wrong in a single call.
  const batchId = ports.effects.openBatch('adoption');
  const done = new Set(alreadyDone);
  let applied = 0;
  let skipped = 0;
  let refused = 0;

  try {
    for (const { userId, plan } of plans) {
      if (done.has(userId)) continue;
      const result = await applyPlan(ports, {
        panel,
        userId,
        selectedOptionIds: selections.get(userId) ?? new Set(),
        source: 'adoption',
        reason: `adopting panel ${panel.panelId}`,
        batchId,
        plan,
      });
      applied += result.applied;
      skipped += result.skipped;
      refused += result.refused;

      // Saved per member: an interrupted pass resumes rather than re-converging
      // everyone. Re-converging would be harmless — the gateway's no-op check
      // makes it free — but it would still cost a REST call each.
      done.add(userId);
      input.saveCursor(
        JSON.stringify({
          computedAtMs: ports.now(),
          changes,
          doneUserIds: [...done],
        } satisfies AdoptionCursor),
      );
    }
  } finally {
    ports.effects.closeBatch(batchId);
  }

  ports.setAdoptionPassState(panel.panelId, 'done');
  ports.logger.info(
    safeLogFields({
      component: 'panels',
      guildId: ports.guildId,
      panelId: panel.panelId,
      batchId,
      count: changes.length,
      applied,
      skipped,
      total: members.length,
      outcome: 'adopted',
    }),
    'adoption pass complete',
  );

  return {
    status: 'adopted',
    changeCount: changes.length,
    memberCount: members.length,
    applied,
    skipped,
    refused,
  };
}

/**
 * A cursor written by an earlier attempt is untrusted input, exactly like a job
 * payload (`CLAUDE.md` rule 3). An unparseable one means starting over, which
 * is safe because convergence is idempotent — not a crash loop.
 */
const parseCursor = (cursor: string | null): AdoptionCursor | undefined => {
  if (cursor === null) return undefined;
  try {
    return adoptionCursorSchema.parse(JSON.parse(cursor));
  } catch {
    return undefined;
  }
};
