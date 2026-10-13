import type { InteractionRef, OutgoingMessage } from '../discord/port.js';
import { isSnowflakeId } from '../ids.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { panelRefusalCode } from '../copy/refusals.js';
import { card, toOutgoingMessage, type CardMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import { text } from '../ui/discord/kit.js';
import { isSelectCustomId, parseCustomId } from './components.js';
import { needsFullReactionState } from './convergence.js';
import { optionById, orderedOptions, type PanelConfig } from './model.js';
import {
  convergeMember,
  type ConvergeMemberResult,
  type ReactionSubscriberDeps,
} from './reactions.js';

/**
 * Buttons and select menus into role changes.
 *
 * The shape is fixed by Discord's clock, not by taste. **Three seconds to
 * acknowledge**, and a missed acknowledgement discards the token: the member
 * sees "This interaction failed" no matter what happens afterwards. A role
 * change is a member fetch, a role fetch and a REST call, which is comfortably
 * more than three seconds on a bad day.
 *
 * So the order is: identify (synchronous, microseconds) → **defer** → converge
 * → follow up. Identification comes first so we never acknowledge an
 * interaction that is not ours; everything after the defer has fifteen minutes.
 */

export interface PanelResponder {
  defer(ref: InteractionRef, options: { ephemeral: boolean }): Promise<void>;
  respond(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
}

export interface InteractionSubscriberDeps extends ReactionSubscriberDeps {
  readonly responder: PanelResponder;
}

/**
 * What the member is told, as a card.
 *
 * Built from what the gateway **did**, never from what the plan wanted. Under
 * dry run, a tripped breaker or a hierarchy refusal the plan is full of
 * intentions and nothing happened — and a message built from the plan would be
 * a confident lie to somebody who can see their own role list.
 *
 * Role mentions stay live so they render as the role's name. They do not ping:
 * the reply goes through `toOutgoingMessage`, whose `allowedMentions` is
 * `{ parse: [] }`.
 */
export const panelResultCard = (result: ConvergeMemberResult): CardMessage => {
  const refusal = result.plan.refusedBecause;
  if (refusal !== undefined) return errorCard(panelRefusalCode(refusal));

  const granted = result.appliedChanges.filter((c) => c.action === 'grant');
  const revoked = result.appliedChanges.filter((c) => c.action === 'revoke');

  if (granted.length > 0 || revoked.length > 0) {
    const lines = ['**Roles updated**'];
    if (granted.length > 0) {
      lines.push(`You now have ${granted.map((c) => `<@&${c.roleId}>`).join(', ')}.`);
    }
    if (revoked.length > 0) {
      lines.push(`Removed ${revoked.map((c) => `<@&${c.roleId}>`).join(', ')}.`);
    }
    const clamped = result.plan.declined.find((d) => d.reason === 'max-roles');
    if (clamped !== undefined) {
      lines.push(`💡 You've reached this panel's limit, so not every choice was added.`);
    }
    return card({ tone: 'ok', children: [text(lines.join('\n'))] });
  }

  // Nothing happened. Either there was nothing to do, or the gateway refused
  // everything — which one is an operator's question, not a member's.
  const declined = result.plan.declined[0];
  if (declined !== undefined) return errorCard(panelRefusalCode(declined.reason));
  if (result.refused > 0) return errorCard('panel.not-applied');
  return card({ tone: 'neutral', children: [text('**No change**\nYour roles already match.')] });
};

/**
 * Which options the member has selected, given what they clicked.
 *
 * A managed panel has no reactions, so the member's *current* selection is
 * simply which of the panel's roles they hold — no REST call beyond the member
 * fetch convergence already needs.
 */
export const selectionAfterClick = (
  panel: PanelConfig,
  currentRoleIds: ReadonlySet<string>,
  clickedOptionId: string,
): Set<string> => {
  const held = new Set(
    orderedOptions(panel)
      .filter((o) => currentRoleIds.has(o.roleId))
      .map((o) => o.optionId),
  );

  // Choosing is not toggling: on a single-choice panel, clicking B means "B",
  // not "B as well as whatever I had".
  if (panel.behaviour === 'single_choice') return new Set([clickedOptionId]);

  if (held.has(clickedOptionId)) held.delete(clickedOptionId);
  else held.add(clickedOptionId);
  return held;
};

/** A select menu's `values`, keeping only options this panel actually offers. */
const selectionFromValues = (
  panel: PanelConfig,
  values: readonly string[] | undefined,
): Set<string> => new Set((values ?? []).filter((value) => optionById(panel, value) !== undefined));

export const createInteractionSubscriber = (deps: InteractionSubscriberDeps): Subscriber => ({
  name: 'panel-interactions',
  async handle(event) {
    if (event.kind !== 'interaction') return;

    // --- identify, synchronously ------------------------------------------
    // Before the defer, because acknowledging an interaction that is not ours
    // would swallow another bot's component. Both lookups are in-process.
    const parsed = parseCustomId(event.customId);
    if (parsed === undefined) return;

    // The message is the authority, not the custom id: a crafted interaction
    // can name any panel it likes, so the panel is resolved from where the
    // click actually happened and the custom id must agree with it.
    const panel = deps.store.findPanelByMessage(event.channelId, event.messageId);
    if (panel === undefined) return;
    if (panel.panelId !== parsed.panelId) {
      deps.logger.warn(
        safeLogFields({
          component: 'panels',
          guildId: deps.guildId,
          panelId: panel.panelId,
          messageId: event.messageId,
          outcome: 'custom-id-mismatch',
        }),
        'an interaction named a different panel than the message it was on',
      );
      return;
    }
    if (panel.kind !== 'managed') return;
    if (!isSnowflakeId(event.userId)) return;

    const isSelect = isSelectCustomId(parsed);
    if (!isSelect && optionById(panel, parsed.optionId) === undefined) {
      // A button from an older version of this panel, still on the message.
      return;
    }

    const userId = event.userId;
    const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };

    // --- acknowledge, then work -------------------------------------------
    await deps.responder.defer(ref, { ephemeral: true });

    let result: ConvergeMemberResult;
    try {
      const member = await deps.discord.fetchMember(deps.guildId, userId);
      const currentRoleIds = new Set(member.roleIds);

      const selectedOptionIds = isSelect
        ? selectionFromValues(panel, event.values)
        : selectionAfterClick(panel, currentRoleIds, parsed.optionId);

      // A select menu speaks for the whole panel, and so does any panel whose
      // ceiling makes the options interdependent. A single button on an
      // independent-option panel touches only what it named (amendment 6).
      const limitToOptionIds =
        isSelect || needsFullReactionState(panel) || panel.behaviour === 'single_choice'
          ? undefined
          : new Set([parsed.optionId]);

      result = await convergeMember(deps, {
        panel,
        userId,
        selectedOptionIds,
        limitToOptionIds,
        source: 'interaction',
        reason: `panel ${panel.panelId}`,
        // The interaction id is a real snowflake, unique per click, so a
        // replayed interaction collides on `role_effects_dedupe` instead of
        // acting twice.
        triggerRef: event.interactionId,
      });
    } catch (err) {
      deps.logger.error(
        safeLogFields({
          component: 'panels',
          guildId: deps.guildId,
          panelId: panel.panelId,
          userId,
          outcome: 'failed',
          err,
        }),
        'a panel interaction could not be handled',
      );
      // Deferred already, so the member gets an answer rather than a spinner
      // that never resolves.
      await deps.responder.respond(ref, toOutgoingMessage(errorCard('panel.unavailable')));
      return;
    }

    await deps.responder.respond(ref, toOutgoingMessage(panelResultCard(result)));
  },
});
