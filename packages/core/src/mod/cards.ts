import { ERROR_COPY } from '../copy/errors.js';
import { moderationRefusalCode, refFor } from '../copy/refusals.js';
import type {
  DeleteMessageOutcome,
  ModerationOutcome,
} from '../effects/moderation-gateway.js';
import { card, type CardMessage } from '../ui/discord/card.js';
import { errorCard, resultCard } from '../ui/discord/common-cards.js';
import {
  actionRow,
  button,
  label,
  modal,
  radioGroup,
  separator,
  text,
  textInput,
  type ActionRow,
  type Modal,
} from '../ui/discord/kit.js';
import { escapeInline, jumpUrl, subtext, ts } from '../ui/discord/text.js';
import { ICON, type IconName } from '../ui/discord/tokens.js';
import { buildModCancelCustomId, buildModConfirmCustomId } from './confirmations.js';
import { buildModCustomId } from './custom-ids.js';

export type DirectModAction = 'timeout' | 'untimeout' | 'kick' | 'unban';

export const caseRef = (caseId: string): string => caseId.slice(0, 8);

export const durationLabel = (minutes: number): string => {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes >= 1440 && minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes >= 60 && minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
};

const ICON_FOR: Record<DirectModAction | 'ban', IconName> = {
  timeout: 'timeout',
  untimeout: 'timeout',
  kick: 'kick',
  ban: 'ban',
  unban: 'unban',
};

/** What was done, as a sentence fragment that starts lower-case. */
const didPhrase = (action: DirectModAction | 'ban', who: string, minutes: number | undefined): string => {
  switch (action) {
    case 'timeout':
      return `timed out ${who} for ${durationLabel(minutes ?? 0)}`;
    case 'untimeout':
      return `ended ${who}'s timeout`;
    case 'kick':
      return `kicked ${who}`;
    case 'ban':
      return `banned ${who}`;
    case 'unban':
      return `unbanned ${who}`;
  }
};

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const reasonLine = (reason: string): string[] =>
  reason.trim() === '' ? [] : [`Reason: ${escapeInline(reason)}`];

/**
 * `resultCard`'s shape, but the title is already-safe text the caller built
 * (it holds a `<@id>` or `<#id>` mention the plan's tests require verbatim,
 * and `resultCard` escapes titles). Only untrusted lines — the reason, note
 * content — are escaped, by the caller, before they reach this builder.
 */
const outcomeCard = (options: {
  icon: IconName;
  title: string;
  detail?: string;
  tone: 'ok' | 'hold' | 'neutral' | 'progress';
}): CardMessage => {
  const lines = [`**${ICON[options.icon]} ${options.title}**`];
  if (options.detail !== undefined && options.detail !== '') lines.push(options.detail);
  return card({ tone: options.tone, children: [text(lines.join('\n'))] });
};

export const modOutcomeCard = (input: {
  action: DirectModAction | 'ban';
  targetId: string;
  outcome: ModerationOutcome;
  reason: string;
  durationMinutes?: number;
  interactionId: string;
}): CardMessage => {
  const did = didPhrase(input.action, `<@${input.targetId}>`, input.durationMinutes);
  const ref = refFor(input.interactionId);
  switch (input.outcome.status) {
    case 'applied':
      return outcomeCard({
        icon: ICON_FOR[input.action],
        title: capitalise(did),
        ...(reasonLine(input.reason).join('\n') === ''
          ? {}
          : { detail: reasonLine(input.reason).join('\n') }),
        tone: 'ok',
      });
    case 'dry-run':
      return outcomeCard({
        icon: 'stop',
        title: 'Dry run is on, so nothing changed',
        detail: [`It would have ${did}.`, ...reasonLine(input.reason)].join('\n'),
        tone: 'hold',
      });
    case 'skipped':
      return outcomeCard({
        icon: 'done',
        title: 'Already done',
        detail: 'This exact action already ran, so it did not run twice.',
        tone: 'hold',
      });
    case 'refused':
      return errorCard(moderationRefusalCode(input.outcome.reason), { ref });
    case 'failed':
      return errorCard('mod.discord-error', { ref });
  }
};

const escalationLine = (o: ModerationOutcome): string => {
  switch (o.status) {
    case 'applied':
      return 'This reached an escalation step, and its consequence was applied.';
    case 'dry-run':
      return "This reached an escalation step. Dry run is on, so its consequence didn't run.";
    case 'skipped':
      return 'This reached an escalation step that had already run.';
    case 'refused':
      return `This reached an escalation step, but its consequence didn't run: ${ERROR_COPY[moderationRefusalCode(o.reason)].title}.`;
    case 'failed':
      return "This reached an escalation step, but Discord didn't accept its consequence.";
  }
};

export const warnOutcomeCard = (input: {
  targetId: string;
  reason: string;
  caseId: string;
  violationCount: number;
  escalation: ModerationOutcome | undefined;
}): CardMessage => {
  const lines = [
    ...reasonLine(input.reason),
    subtext(`Case ${caseRef(input.caseId)} · warning ${input.violationCount}`),
  ];
  if (input.escalation !== undefined) lines.push(escalationLine(input.escalation));
  const calm = input.escalation === undefined || input.escalation.status === 'applied';
  return outcomeCard({
    icon: 'warned',
    title: `Warned <@${input.targetId}>`,
    detail: lines.join('\n'),
    tone: calm ? 'ok' : 'hold',
  });
};

export const noteOutcomeCard = (input: {
  kind: 'note' | 'evidence';
  targetId: string;
  content: string;
}): CardMessage =>
  outcomeCard({
    icon: 'note',
    title:
      input.kind === 'note'
        ? `Added a note to <@${input.targetId}>'s case`
        : `Added an evidence link to <@${input.targetId}>'s case`,
    detail: escapeInline(input.content),
    tone: 'ok',
  });

export const confirmRow = (intentId: string, confirmLabel: string): ActionRow =>
  actionRow([
    button({ customId: buildModConfirmCustomId(intentId), label: confirmLabel, style: 'danger' }),
    button({ customId: buildModCancelCustomId(intentId), label: 'Cancel' }),
  ]);

const NOTHING_YET = subtext('Nothing has happened yet. The confirmation lasts 15 minutes.');

export const banConfirmCard = (input: { targetId: string; reason: string; intentId: string }): CardMessage =>
  card({
    tone: 'danger',
    children: [
      text([`**${ICON.ban} Ban <@${input.targetId}>?**`, ...reasonLine(input.reason), NOTHING_YET].join('\n')),
      separator(),
      confirmRow(input.intentId, 'Ban member'),
    ],
  });

export const purgeConfirmCard = (input: {
  channelId: string;
  total: number;
  fresh: number;
  old: number;
  newestAtMs: number | undefined;
  reason: string;
  intentId: string;
}): CardMessage => {
  const lines = [`**${ICON.bulkDelete} Delete ${input.total} messages from <#${input.channelId}>?**`];
  if (input.newestAtMs !== undefined) lines.push(`Newest ${ts(input.newestAtMs, 'R')}.`);
  lines.push(
    input.old === 0
      ? `All ${input.fresh} can go in bulk.`
      : `${input.fresh} can go in bulk. ${input.old} are older than 14 days and go one at a time.`,
  );
  lines.push(...reasonLine(input.reason), NOTHING_YET);
  return card({
    tone: 'danger',
    children: [text(lines.join('\n')), separator(), confirmRow(input.intentId, `Delete ${input.total} messages`)],
  });
};

export const purgeQueuedCard = (channelId: string): CardMessage =>
  outcomeCard({
    icon: 'bulkDelete',
    title: `Purging <#${channelId}>`,
    detail: 'It runs in the background. A large channel can take a few minutes.',
    tone: 'progress',
  });

export const cancelledCard = (): CardMessage =>
  resultCard({ icon: 'done', title: 'Cancelled', detail: 'Nothing was done.', tone: 'neutral' });

export const TIMEOUT_CHOICES = [
  { minutes: 10, label: '10 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '1 day' },
] as const;
const DEFAULT_TIMEOUT_MINUTES = 60;

const reasonField = () =>
  label({
    label: 'Reason',
    description: 'Shown in case history and in Discord’s audit log.',
    component: textInput({ customId: 'reason', style: 'paragraph', required: true, minLength: 1, maxLength: 500 }),
  });

export const warnModal = (userId: string): Modal =>
  modal({ customId: buildModCustomId({ action: 'warn', userId }), title: 'Warn member', components: [reasonField()] });

export const timeoutModal = (userId: string): Modal =>
  modal({
    customId: buildModCustomId({ action: 'timeout', userId }),
    title: 'Time out member',
    components: [
      label({
        label: 'How long',
        component: radioGroup({
          customId: 'minutes',
          required: true,
          options: TIMEOUT_CHOICES.map((c) => ({
            value: String(c.minutes),
            label: c.label,
            ...(c.minutes === DEFAULT_TIMEOUT_MINUTES ? { default: true } : {}),
          })),
        }),
      }),
      reasonField(),
    ],
  });

export const deleteConfirmCard = (input: {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  intentId: string;
}): CardMessage =>
  card({
    tone: 'danger',
    children: [
      text(
        [
          `**${ICON.deleted} Delete this message by <@${input.authorId}> in <#${input.channelId}>?**`,
          `[Open the message](${jumpUrl(input.guildId, input.channelId, input.messageId)})`,
          NOTHING_YET,
        ].join('\n'),
      ),
      separator(),
      confirmRow(input.intentId, 'Delete message'),
    ],
  });

export const deleteOutcomeCard = (outcome: DeleteMessageOutcome, interactionId: string): CardMessage => {
  const ref = refFor(interactionId);
  switch (outcome.status) {
    case 'applied':
      return resultCard({ icon: 'deleted', title: 'Deleted the message', tone: 'ok' });
    case 'dry-run':
      return resultCard({ icon: 'stop', title: 'Dry run is on, so nothing changed', detail: 'It would have deleted the message.', tone: 'hold' });
    case 'skipped':
      return outcome.reason === 'message-gone'
        ? resultCard({ icon: 'done', title: 'That message was already gone', detail: 'Someone removed it before you confirmed. Nothing else changed.', tone: 'hold' })
        : resultCard({ icon: 'done', title: 'Already done', detail: 'This exact action already ran, so it did not run twice.', tone: 'hold' });
    case 'refused':
      return errorCard(moderationRefusalCode(outcome.reason), { ref });
    case 'failed':
      return errorCard('mod.discord-error', { ref });
  }
};
