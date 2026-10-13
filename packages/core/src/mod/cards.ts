import { ERROR_COPY } from '../copy/errors.js';
import { moderationRefusalCode, refFor } from '../copy/refusals.js';
import type {
  DeleteMessageOutcome,
  ModerationOutcome,
  ModerationRefusalReason,
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
  type Button,
  type ContainerChild,
  type Modal,
} from '../ui/discord/kit.js';
import { escapeInline, jumpUrl, subtext, truncate, ts } from '../ui/discord/text.js';
import { ICON, type IconName } from '../ui/discord/tokens.js';
import { buildModCancelCustomId, buildModConfirmCustomId } from './confirmations.js';
import { buildModCustomId } from './custom-ids.js';
import { isSelfAuthored, type HistoryCaseEvent, type HistoryPage } from './history.js';

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
const didPhrase = (
  action: DirectModAction | 'ban',
  who: string,
  minutes: number | undefined,
): string => {
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
const fitText = (raw: string, max: number, format: (value: string) => string): string => {
  const bounded = truncate(raw, max);
  const full = format(bounded);
  if (full.length <= max) return full;
  let low = 0;
  let high = bounded.length;
  let best = format('');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = format(truncate(bounded, mid));
    if (value.length <= max) {
      best = value;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
};
const REASON_LINE_MAX = 700;
const reasonLine = (reason: string): string[] =>
  reason.trim() === ''
    ? []
    : [`Reason: ${fitText(reason, REASON_LINE_MAX - 'Reason: '.length, escapeInline)}`];

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
    detail: fitText(input.content, 900, escapeInline),
    tone: 'ok',
  });

export const confirmRow = (intentId: string, confirmLabel: string): ActionRow =>
  actionRow([
    button({ customId: buildModConfirmCustomId(intentId), label: confirmLabel, style: 'danger' }),
    button({ customId: buildModCancelCustomId(intentId), label: 'Cancel' }),
  ]);

const NOTHING_YET = subtext('Nothing has happened yet. The confirmation lasts 15 minutes.');

export const banConfirmCard = (input: {
  targetId: string;
  reason: string;
  intentId: string;
}): CardMessage =>
  card({
    tone: 'danger',
    children: [
      text(
        [
          `**${ICON.ban} Ban <@${input.targetId}>?**`,
          ...reasonLine(input.reason),
          NOTHING_YET,
        ].join('\n'),
      ),
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
  const lines = [
    `**${ICON.bulkDelete} Delete ${input.total} messages from <#${input.channelId}>?**`,
  ];
  if (input.newestAtMs !== undefined) lines.push(`Newest ${ts(input.newestAtMs, 'R')}.`);
  lines.push(
    input.old === 0
      ? `All ${input.fresh} can go in bulk.`
      : `${input.fresh} can go in bulk. ${input.old} are older than 14 days and go one at a time.`,
  );
  lines.push(...reasonLine(input.reason), NOTHING_YET);
  return card({
    tone: 'danger',
    children: [
      text(lines.join('\n')),
      separator(),
      confirmRow(input.intentId, `Delete ${input.total} messages`),
    ],
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

/** Longest moderation reason Discord's audit log and case history accept. Server-enforced in `card-actions.ts`; the modal only hints. */
export const MOD_REASON_MAX = 500;

const reasonField = () =>
  label({
    label: 'Reason',
    description: 'Shown in case history and in Discord’s audit log.',
    component: textInput({
      customId: 'reason',
      style: 'paragraph',
      required: true,
      minLength: 1,
      maxLength: MOD_REASON_MAX,
    }),
  });

export const warnModal = (userId: string): Modal =>
  modal({
    customId: buildModCustomId({ action: 'warn', userId }),
    title: 'Warn member',
    components: [reasonField()],
  });

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

export const deleteOutcomeCard = (
  outcome: DeleteMessageOutcome,
  interactionId: string,
): CardMessage => {
  const ref = refFor(interactionId);
  switch (outcome.status) {
    case 'applied':
      return resultCard({ icon: 'deleted', title: 'Deleted the message', tone: 'ok' });
    case 'dry-run':
      return resultCard({
        icon: 'stop',
        title: 'Dry run is on, so nothing changed',
        detail: 'It would have deleted the message.',
        tone: 'hold',
      });
    case 'skipped':
      return outcome.reason === 'message-gone'
        ? resultCard({
            icon: 'done',
            title: 'That message was already gone',
            detail: 'Someone removed it before you confirmed. Nothing else changed.',
            tone: 'hold',
          })
        : resultCard({
            icon: 'done',
            title: 'Already done',
            detail: 'This exact action already ran, so it did not run twice.',
            tone: 'hold',
          });
    case 'refused':
      return errorCard(moderationRefusalCode(outcome.reason), { ref });
    case 'failed':
      return errorCard('mod.discord-error', { ref });
  }
};

/**
 * Case history as a paged card (P2 Task 8, ADR 0141 decision 9). One line per
 * event, in words — never a raw `actionTaken` code. Every moderator- or
 * member-controlled string on the line is either a snowflake mention (safe by
 * construction) or passed through `escapeInline`; the snippet is cut raw to
 * 120 characters first, then escaped, so escaping cannot push it over.
 */
const SNIPPET_MAX = 120;
const EVENT_LINE_MAX = 350;

/** The attempted action behind an escalation outcome, in words. */
const escalationNoun = (event: HistoryCaseEvent): string => {
  if (event.escalationAction !== undefined) return capitalise(event.escalationAction);
  if (event.matchedCategory === 'untimeout') return 'Timeout';
  return capitalise(event.matchedCategory.replaceAll('_', ' '));
};

/** Every refusal reason the gateway can store, for the defensive lookup below. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set<string>([
  'unauthorized',
  'guild-unknown',
  'killswitch',
  'breaker-open',
  'rate-cap',
  'discord-owner',
  'role-above-bot',
]);

/**
 * What a refusal reason reads as. `unauthorized` is shortened to `Not
 * allowed`; every other known reason reads as its catalogue title. An unknown
 * stored value falls back to humanised words rather than throwing on the
 * catalogue lookup.
 */
const refusalTitle = (reason: string | undefined): string => {
  if (reason === undefined || reason === 'unauthorized') return 'Not allowed';
  if (!KNOWN_REFUSALS.has(reason)) return capitalise(reason.replaceAll('_', ' '));
  return ERROR_COPY[moderationRefusalCode(reason as ModerationRefusalReason)].title;
};

const DELETE_BLOCKED_WORDS: Readonly<Record<string, string>> = {
  delete_blocked_killswitch: 'Delete blocked: the kill switch is on',
  delete_blocked_breaker: 'Delete blocked: the safety breaker is open',
  delete_blocked_dry_run: 'Delete blocked: dry run is on',
  delete_blocked_guild_unknown: "Delete blocked: the server isn't set up",
};

const manualWords = (event: HistoryCaseEvent): string => {
  if (event.escalationAction === 'timeout' || event.matchedCategory === 'timeout')
    return 'Timed out';
  if (event.escalationAction === 'kick' || event.matchedCategory === 'kick') return 'Kicked';
  if (event.escalationAction === 'ban' || event.matchedCategory === 'ban') return 'Banned';
  if (event.escalationAction === 'unban' || event.matchedCategory === 'unban') return 'Unbanned';
  if (event.matchedCategory === 'untimeout') return 'Timeout ended';
  return capitalise(event.actionTaken.replaceAll('_', ' '));
};

const eventWords = (event: HistoryCaseEvent): string => {
  switch (event.actionTaken) {
    case 'warned':
      return 'Warned';
    case 'manual_applied':
      return manualWords(event);
    case 'deleted':
    case 'deleted_and_escalated':
      return event.ruleId === 'manual' ? 'Message deleted' : 'Message deleted by automod';
    case 'would_delete':
      return 'Automod match (watch only)';
    case 'delete_blocked_killswitch':
    case 'delete_blocked_breaker':
    case 'delete_blocked_dry_run':
    case 'delete_blocked_guild_unknown':
      return (
        DELETE_BLOCKED_WORDS[event.actionTaken] ??
        capitalise(event.actionTaken.replaceAll('_', ' '))
      );
    case 'delete_failed':
      return "Delete didn't go through";
    case 'escalation_refused':
      return `${escalationNoun(event)} refused: ${refusalTitle(event.refusalReason)}`;
    case 'escalation_failed':
      return `${escalationNoun(event)} didn't go through`;
    case 'escalation_dry_run':
      return `${escalationNoun(event)} (dry run)`;
    case 'escalation_skipped':
      return `${escalationNoun(event)} (already done)`;
    case 'note':
      return 'Note';
    case 'evidence_added':
      return 'Evidence';
    case 'purged':
      return 'Ran a purge';
    case 'purge_refused':
      return 'Purge refused';
    case 'purge_failed':
      return "Purge didn't go through";
    case 'native_blocked':
      return 'Discord AutoMod blocked a message';
    case 'native_alerted':
      return 'Discord AutoMod sent an alert';
    case 'native_timeout':
      return 'Discord AutoMod timed them out';
    case 'native_blocked_interaction':
      return 'Discord AutoMod blocked an interaction';
    default:
      return capitalise(event.actionTaken.replaceAll('_', ' '));
  }
};

export const describeCaseEvent = (event: HistoryCaseEvent, caseMemberId: string): string => {
  const selfAuthored = isSelfAuthored(event, caseMemberId);
  const by = selfAuthored || event.actorId === undefined ? '' : ` by <@${event.actorId}>`;
  const snippet =
    event.matchedSnippet.trim() === ''
      ? ''
      : ` — "${escapeInline(truncate(event.matchedSnippet, SNIPPET_MAX))}"`;
  // A self-authored event is the case member acting as a moderator (a purge
  // they ran, a note they wrote), not something done to them — it reads with
  // the marker and no by-line at themself.
  return fitText(
    `${ts(event.at, 'd')} **${eventWords(event)}**${selfAuthored ? ' (as a moderator)' : ''}${by}${snippet}`,
    EVENT_LINE_MAX,
    (value) => value,
  );
};

const pluralCount = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The header's second counts line, in a fixed order; kinds with a zero count
 * are left out. The keys are `buildHistoryPage`'s counting buckets.
 */
const COUNT_LABELS: ReadonlyArray<{ key: string; one: string; many: string }> = [
  { key: 'warnings', one: 'warning', many: 'warnings' },
  { key: 'timeouts', one: 'timeout', many: 'timeouts' },
  { key: 'kicks', one: 'kick', many: 'kicks' },
  { key: 'bans', one: 'ban', many: 'bans' },
  { key: 'unbans', one: 'unban', many: 'unbans' },
  { key: 'automodDeletes', one: 'automod delete', many: 'automod deletes' },
  { key: 'nativeAutomod', one: 'Discord AutoMod action', many: 'Discord AutoMod actions' },
  { key: 'notes', one: 'note', many: 'notes' },
  { key: 'evidence', one: 'evidence link', many: 'evidence links' },
  { key: 'refused', one: 'refused action', many: 'refused actions' },
];

const countsLine = (page: HistoryPage): string | undefined => {
  const parts: string[] = [];
  for (const label of COUNT_LABELS) {
    const n = page.countsByKind[label.key] ?? 0;
    if (n > 0) parts.push(pluralCount(n, label.one, label.many));
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
};

/** The footer budget for the case list before it shortens to an and-more tail. */
const FOOTER_CASES_MAX = 400;

const caseSummaries = (page: HistoryPage): string => {
  const parts = page.cases.map(
    (c) =>
      `Case ${caseRef(c.caseId)} (${c.status}, ${c.violationCount} violations, tier ${c.escalationTier})`,
  );
  const kept: string[] = [];
  for (const part of parts) {
    if ([...kept, part].join(' · ').length > FOOTER_CASES_MAX) break;
    kept.push(part);
  }
  const dropped = parts.length - kept.length;
  if (dropped > 0) kept.push(`and ${dropped} more case${dropped === 1 ? '' : 's'}`);
  return kept.join(' · ');
};

export const historyCard = (page: HistoryPage): CardMessage => {
  const counts = countsLine(page);
  const children: ContainerChild[] = [
    text(
      [
        subtext(`${ICON.history} CASE HISTORY`),
        `**<@${page.targetId}>** · ${pluralCount(page.cases.length, 'case', 'cases')} · ${pluralCount(page.totalEvents, 'event', 'events')}`,
        ...(counts === undefined ? [] : [counts]),
      ].join('\n'),
    ),
    separator(),
    ...page.events.map((e) => text(describeCaseEvent(e, e.memberId))),
  ];
  if (page.pageCount > 1) {
    const buttons: Button[] = [];
    if (page.page > 0)
      buttons.push(
        button({
          customId: buildModCustomId({
            action: 'history',
            userId: page.targetId,
            page: page.page - 1,
          }),
          label: '← Newer',
        }),
      );
    if (page.page < page.pageCount - 1)
      buttons.push(
        button({
          customId: buildModCustomId({
            action: 'history',
            userId: page.targetId,
            page: page.page + 1,
          }),
          label: 'Older →',
        }),
      );
    children.push(separator(), actionRow(buttons));
  }
  const footer = [`Page ${page.page + 1} of ${page.pageCount}`, caseSummaries(page)]
    .filter((s) => s !== '')
    .join(' · ');
  children.push(text(subtext(footer)));
  return card({ tone: 'neutral', children });
};
