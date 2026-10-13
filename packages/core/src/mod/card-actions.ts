import { refFor } from '../copy/refusals.js';
import type { InteractionRef } from '../discord/port.js';
import type { GuildId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import { deleteConfirmCard, TIMEOUT_CHOICES, timeoutModal, warnModal } from './cards.js';
import { runDirectAction, runWarn, type ModCommandDeps } from './commands.js';
import {
  authorizeForCard,
  recordCardRefusal,
  writeDeleteIntent,
  type ModConfirmationDeps,
} from './confirmations.js';
import { parseModCustomId } from './custom-ids.js';

/**
 * Delete, Warn and Timeout on log cards (ADR 0141 decisions 4–7). A shortcut
 * into the same deterministic code `/mod` runs; nothing here decides anything
 * a slash command would not. No model is involved, and there is no MCP
 * equivalent (spec §3).
 */
export interface ModCardActionDeps {
  readonly guildId: GuildId;
  readonly commands: ModCommandDeps;
  readonly confirmations: ModConfirmationDeps;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
}

const DEFAULT_MINUTES = 60;
const ALLOWED_MINUTES: ReadonlySet<number> = new Set(TIMEOUT_CHOICES.map((c) => c.minutes));

export const createModCardActionSubscriber = (deps: ModCardActionDeps): Subscriber => ({
  name: 'mod-card-actions',
  async handle(event) {
    if (event.kind === 'interaction') {
      const parsed = parseModCustomId(event.customId);
      if (parsed === undefined || parsed.action === 'history') return; // history: Task 8
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };

      if (parsed.action === 'warn' || parsed.action === 'timeout') {
        try {
          // A modal must be the first response. Authority is checked on submit (ADR 0141 decision 6).
          await deps.responder.showModal(
            ref,
            parsed.action === 'warn' ? warnModal(parsed.userId) : timeoutModal(parsed.userId),
          );
        } catch {
          // Expired or already answered; the moderator can press the button again.
        }
        return;
      }

      // Delete: defer, authorise, write the intent, show the confirm card.
      await deps.responder.defer(ref, { ephemeral: true });
      try {
        const auth = await authorizeForCard(deps.confirmations, event.userId);
        if (!auth.ok) {
          recordCardRefusal(deps.confirmations, {
            memberId: parseSnowflakeId(parsed.authorId),
            actorId: event.userId,
            now: deps.now(),
          });
          await deps.responder.respond(
            ref,
            toOutgoingMessage(errorCard('mod.not-allowed', { ref: refFor(event.interactionId) })),
          );
          return;
        }
        const intentId = writeDeleteIntent(deps.confirmations, {
          actorId: event.userId,
          channelId: parseSnowflakeId(parsed.channelId),
          messageId: parseSnowflakeId(parsed.messageId),
          authorId: parseSnowflakeId(parsed.authorId),
        });
        await deps.responder.respond(
          ref,
          toOutgoingMessage(
            deleteConfirmCard({
              guildId: deps.guildId,
              channelId: parsed.channelId,
              messageId: parsed.messageId,
              authorId: parsed.authorId,
              intentId,
            }),
          ),
        );
      } catch (err) {
        deps.logger.error(
          safeLogFields({
            component: 'mod-card-actions',
            guildId: deps.guildId,
            action: 'delete',
            err,
          }),
          'a log-card delete click failed',
        );
        await deps.responder.respond(
          ref,
          toOutgoingMessage(errorCard('mod.unavailable', { ref: refFor(event.interactionId) })),
        );
      }
      return;
    }

    if (event.kind === 'modalSubmit') {
      const parsed = parseModCustomId(event.customId);
      if (parsed === undefined || (parsed.action !== 'warn' && parsed.action !== 'timeout')) return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      try {
        await deps.responder.defer(ref, { ephemeral: true });
      } catch {
        return;
      }
      const reason = (event.fields['reason'] ?? '').trim();
      try {
        if (reason === '') {
          await deps.responder.respond(ref, toOutgoingMessage(errorCard('mod.reason-required')));
          return;
        }
        const base = {
          actorId: event.userId,
          targetId: parseSnowflakeId(parsed.userId),
          reason,
          interactionId: event.interactionId,
        };
        if (parsed.action === 'warn') {
          await runWarn(deps.commands, base, ref);
          return;
        }
        const chosen = Number(event.fields['minutes']);
        const durationMinutes = ALLOWED_MINUTES.has(chosen) ? chosen : DEFAULT_MINUTES;
        await runDirectAction(deps.commands, { ...base, durationMinutes }, ref, 'timeout');
      } catch (err) {
        deps.logger.error(
          safeLogFields({
            component: 'mod-card-actions',
            guildId: deps.guildId,
            action: parsed.action,
            err,
          }),
          'a log-card moderation form failed',
        );
        await deps.responder.respond(
          ref,
          toOutgoingMessage(errorCard('mod.unavailable', { ref: refFor(event.interactionId) })),
        );
      }
    }
  },
});
