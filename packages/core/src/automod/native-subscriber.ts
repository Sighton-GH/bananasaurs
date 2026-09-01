import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { AutoModerationEvent, NativeAutoModAction } from '../discord/events.js';
import type { AutomodActionTaken } from './subscriber.js';

/**
 * Records what Discord's own AutoMod did (ADR 0038).
 *
 * This subscriber makes **no Discord calls**. It therefore takes no
 * `DiscordPort`, no `ModerationActionGateway` and no safety state: there is
 * nothing for the kill switch or dry run to suppress, and suppressing a
 * *record* of something Discord already did would make the moderation log lie
 * about the guild's history. The kill switch stops side effects; this is an
 * observation.
 *
 * Every dependency arrives as a port, per ADR 0014 — this module never imports
 * `@bananasaurs/storage`.
 */

/** The reserved sentinel prefix, following ADR 0037's `manual` precedent. */
const NATIVE_RULE_PREFIX = 'native:';

const ACTION_TO_RECORDED: Record<NativeAutoModAction, AutomodActionTaken> = {
  block: 'native_blocked',
  alert: 'native_alerted',
  timeout: 'native_timeout',
  block_interaction: 'native_blocked_interaction',
};

/**
 * Clamp a matched snippet to a bounded length, consistent with what "snippet"
 * means elsewhere in this codebase. `matchedContent` can span most of the
 * message for a native rule using regex, and an 1,800-character snippet in a
 * single row would overflow the 2,000-char ceiling on `/mod history` and cause
 * every event on the case to be dropped.
 */
const clampMatchedSnippet = (text: string): string =>
  text.length <= 200 ? text : text.slice(0, 200) + '…';

export interface NativeAutomodSubscriberDeps {
  readonly logger: Logger;
  readonly openOrResolveCase: (
    memberId: string,
    options: { countsAsViolation: boolean },
  ) => { caseId: string };
  readonly recordCaseEvent: (input: {
    caseId: string;
    ruleId: string;
    memberId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: AutomodActionTaken;
  }) => void;
}

export const createNativeAutomodSubscriber = (deps: NativeAutomodSubscriberDeps): Subscriber => ({
  name: 'native-automod',
  handle: (event) => {
    if (event.kind !== 'autoModerationAction') return;
    const native: AutoModerationEvent = event;

    // `countsAsViolation: false` still opens or resolves the member's case, so
    // the observation is durably visible in history — it only leaves
    // `violation_count` alone (ADR 0038's reason).
    const { caseId } = deps.openOrResolveCase(native.userId, { countsAsViolation: false });

    // `native.channelId` is available but not yet recorded — this will be added
    // in a later slice when the schema extends modCaseEvents to include it.
    // That is an auditability improvement: "block commonly flagged words" firing
    // in one noisy channel versus guild-wide is a signal worth preserving. It is
    // deliberately not recorded now so this gap is not mistaken for an oversight.
    deps.recordCaseEvent({
      caseId,
      ruleId: `${NATIVE_RULE_PREFIX}${native.ruleId}`,
      memberId: native.userId,
      matchedCategory: native.triggerType,
      // Discord names a keyword for keyword rules, a matched substring for
      // some others, and neither for spam. An empty snippet is honest; not
      // recording the event at all would lose a decision that really happened.
      // Clamp matchedContent (member-authored text) to prevent a single
      // 1,800-character match from overflowing the 2,000-char ceiling on
      // `/mod history` and hiding every event on the case.
      matchedSnippet: clampMatchedSnippet(native.matchedKeyword ?? native.matchedContent ?? ''),
      actionTaken: ACTION_TO_RECORDED[native.actionType],
    });

    // `content` and `matchedContent` are member-authored text and never reach
    // a log line (CLAUDE.md rule 4: redaction is an allowlist). Every field
    // logged here — `component`, `guildId`, `ruleId`, `action` — is already on
    // `LOGGABLE_FIELDS`, so this call needs no allowlist change.
    deps.logger.info(
      safeLogFields({
        component: 'native-automod',
        guildId: native.guildId,
        ruleId: native.ruleId,
        action: native.actionType,
      }),
      'recorded a native AutoMod decision',
    );
  },
});
