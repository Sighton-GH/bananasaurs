import { randomUUID } from 'node:crypto';
import type { Logger, NativeAutomodSubscriberDeps } from '@bananasaurs/core';
import { type GuildScope, modCaseRepo } from '@bananasaurs/storage';

/**
 * Binds the native-AutoMod subscriber's ports to repositories (ADR 0038).
 *
 * Deliberately narrower than `automodPortsFor`: this subscriber performs no
 * Discord writes, so it needs no `DiscordPort`, no gateway and no safety
 * state.
 */
export const nativeAutomodPortsFor = (
  scope: GuildScope,
  logger: Logger,
  now: () => number,
): NativeAutomodSubscriberDeps => ({
  logger,
  openOrResolveCase: (memberId, options) =>
    modCaseRepo.openOrResolveCase(scope, {
      memberId,
      now: now(),
      countsAsViolation: options.countsAsViolation,
    }),
  recordCaseEvent: (input) =>
    modCaseRepo.recordCaseEvent(scope, {
      eventId: randomUUID(),
      at: now(),
      caseId: input.caseId,
      ruleId: input.ruleId,
      memberId: input.memberId,
      matchedCategory: input.matchedCategory,
      matchedSnippet: input.matchedSnippet,
      actionTaken: input.actionTaken,
    }),
});
