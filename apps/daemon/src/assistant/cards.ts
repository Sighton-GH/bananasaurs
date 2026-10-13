import {
  card,
  escapeText,
  ICON,
  jumpUrl,
  subtext,
  text,
  truncate,
  ts,
  type CardMessage,
} from '@bananasaurs/core';
import type { DeliverableReminder } from './reminder-delivery.js';
import { neutraliseMassMentions } from './reminder-summary.js';

const REMINDER_TEXT_MAX = 3_000;
const ESCALATION_HEAD_MAX = 1_000;
const ESCALATION_ANSWER_MAX = 1_500;

const fitText = (raw: string, max: number): string => {
  const value = truncate(raw, max);
  return value.length <= max ? value : value.slice(0, max);
};

/**
 * An assistant reminder as a card (ADR 0141 decision 10).
 *
 * The pings line lists exactly the stored, permission-checked targets (ADR
 * 0086 decision 6): `@everyone`, `@here`, `<@&role>` per stored role and
 * `<@user>` per stored member, in that order — omitted when there are no
 * pings. Only the code-built pings line carries live ping tokens: the
 * member-written text and context have `@everyone`/`@here` neutralised, and
 * the context collapses to one subtext line so it cannot break out of `-# `.
 * The "Set by" line names the creator without pinging them — their id
 * reaches `users` only when it is already in `mentions.userIds`. The
 * 3,000-character cap truncates the text, never the pings.
 *
 * `origin='mcp'` rows never carry `@everyone`/`@here`; a row that somehow
 * carries them is refused here rather than posted.
 */
export const renderAssistantReminderCard = (reminder: DeliverableReminder): CardMessage => {
  if (reminder.origin === 'mcp' && (reminder.mentions.everyone || reminder.mentions.here))
    throw new Error('mcp reminders cannot ping everyone or here');
  const pings: string[] = [];
  if (reminder.mentions.everyone) pings.push('@everyone');
  if (reminder.mentions.here) pings.push('@here');
  for (const roleId of reminder.mentions.roleIds) pings.push(`<@&${roleId}>`);
  for (const userId of reminder.mentions.userIds) pings.push(`<@${userId}>`);
  const context = reminder.context?.replace(/\s+/g, ' ').trim();
  const lines = [
    subtext(`${ICON.due} REMINDER`),
    ...(pings.length === 0 ? [] : [pings.join(' ')]),
    neutraliseMassMentions(truncate(reminder.text, REMINDER_TEXT_MAX)),
    ...(context === undefined || context === '' ? [] : [subtext(neutraliseMassMentions(context))]),
    subtext(`Set by <@${reminder.creatorId}>`),
  ];
  return card({
    tone: 'accent',
    children: [text(lines.join('\n'))],
    pingEveryone: reminder.mentions.everyone || reminder.mentions.here,
    pingRoles: reminder.mentions.roleIds,
    pingUsers: reminder.mentions.userIds,
  });
};

const quote = (body: string): string =>
  body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

export const renderEscalationCard = (input: {
  guildId: string;
  ticketId: string;
  reviewerRoleIds: readonly string[];
  userId: string;
  channelId: string;
  messageId: string | undefined;
  question: string;
  answer: string;
  at: number;
}): CardMessage => {
  const head = [
    subtext(`${ICON.escalate} NEEDS A PERSON · IT request ${escapeText(input.ticketId)}`),
    ...(input.reviewerRoleIds.length === 0
      ? []
      : [input.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ')]),
    `<@${input.userId}> asked in <#${input.channelId}>:`,
    quote(escapeText(truncate(input.question.trim() || '(empty)', 500))),
  ];
  const footer = [
    ...(input.messageId === undefined
      ? []
      : [`[Jump to the question](${jumpUrl(input.guildId, input.channelId, input.messageId)})`]),
    ts(input.at, 'R'),
  ];
  return card({
    tone: 'hold',
    children: [
      text(fitText(head.join('\n'), ESCALATION_HEAD_MAX)),
      text(
        fitText(
          `**The assistant replied**\n${quote(input.answer.trim() || '(empty)')}`,
          ESCALATION_ANSWER_MAX,
        ),
      ),
      text(subtext(footer.join(' · '))),
    ],
    pingRoles: input.reviewerRoleIds,
  });
};
