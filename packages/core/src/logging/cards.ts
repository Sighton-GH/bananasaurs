import { buildModCustomId } from '../mod/custom-ids.js';
import { card, type CardMessage } from '../ui/discord/card.js';
import {
  actionRow,
  button,
  separator,
  text,
  type ActionRow,
  type ContainerChild,
} from '../ui/discord/kit.js';
import { escapeText, jumpUrl, subtext, truncate, ts } from '../ui/discord/text.js';
import { ICON, type IconName, type Tone } from '../ui/discord/tokens.js';

export type LogCardKind = string;

/**
 * Every event kind a log route can carry (`LOG_EVENT_KINDS` in
 * `./subscriber.js`, verified 2026-10-13 to be exactly these 37 values). No
 * union type is exported anywhere in the logging module — `LOG_EVENT_KINDS`
 * and `AUDIT_EVENT_KINDS` are both `readonly string[]` — so the union lives
 * here, next to the table it keeps exhaustive. Adding a value here without a
 * `LOG_KIND_META` row fails `tsc`; so does removing a row.
 */
export type LogEventKind =
  | 'automod_action'
  | 'automod_match'
  | 'channel_create'
  | 'channel_delete'
  | 'channel_update'
  | 'emoji_create'
  | 'emoji_delete'
  | 'emoji_update'
  | 'guild_available'
  | 'guild_unavailable'
  | 'guild_update'
  | 'invite_create'
  | 'invite_delete'
  | 'member_avatar_changed'
  | 'member_ban'
  | 'member_join'
  | 'member_kick'
  | 'member_leave'
  | 'member_nickname_changed'
  | 'member_roles_changed'
  | 'member_timeout'
  | 'member_timeout_removed'
  | 'member_unban'
  | 'member_username_changed'
  | 'member_warn'
  | 'message_bulk_delete'
  | 'message_create'
  | 'message_delete'
  | 'message_edit'
  | 'role_create'
  | 'role_delete'
  | 'role_update'
  | 'sticker_create'
  | 'sticker_delete'
  | 'sticker_update'
  | 'thread_create'
  | 'thread_delete';

export interface LogCardView {
  readonly kind: LogCardKind;
  /** One line of already-safe Markdown: mentions and escaped names only. */
  readonly headline: string;
  /** Further already-safe lines. */
  readonly details?: readonly string[];
  /** Untrusted text shown as a quote, escaped here. */
  readonly quote?: { readonly label: string; readonly text: string; readonly spoiler?: boolean };
  /** Audit change lines, shown in a code block. */
  readonly changes?: readonly string[];
  readonly at: number;
  /** Enables Warn/Timeout when set and the kind allows actions. */
  readonly memberId?: string;
  /** Enables Delete and the jump link when set and the kind allows it. */
  readonly message?: {
    readonly channelId: string;
    readonly messageId: string;
    readonly exists: boolean;
  };
}

type Meta = { icon: IconName; label: string; tone: Tone };

/** One row per kind (ADR 0141 decision 1), plus `gap`. Labels are upper-cased in the eyebrow. */
export const LOG_KIND_META: Readonly<Record<LogEventKind | 'gap', Meta>> = {
  message_create: { icon: 'message', label: 'Message sent', tone: 'neutral' },
  message_edit: { icon: 'edited', label: 'Message edited', tone: 'neutral' },
  message_delete: { icon: 'deleted', label: 'Message deleted', tone: 'neutral' },
  message_bulk_delete: { icon: 'bulkDelete', label: 'Messages purged', tone: 'danger' },
  member_join: { icon: 'joined', label: 'Member joined', tone: 'neutral' },
  member_leave: { icon: 'left', label: 'Member left', tone: 'neutral' },
  member_roles_changed: { icon: 'roles', label: 'Roles changed', tone: 'neutral' },
  member_nickname_changed: { icon: 'member', label: 'Nickname changed', tone: 'neutral' },
  member_username_changed: { icon: 'member', label: 'Name changed', tone: 'neutral' },
  member_avatar_changed: { icon: 'member', label: 'Avatar changed', tone: 'neutral' },
  member_warn: { icon: 'warned', label: 'Member warned', tone: 'danger' },
  member_kick: { icon: 'kick', label: 'Member kicked', tone: 'danger' },
  member_ban: { icon: 'ban', label: 'Member banned', tone: 'danger' },
  member_unban: { icon: 'unban', label: 'Member unbanned', tone: 'neutral' },
  member_timeout: { icon: 'timeout', label: 'Member timed out', tone: 'danger' },
  member_timeout_removed: { icon: 'timeout', label: 'Timeout removed', tone: 'neutral' },
  role_create: { icon: 'roles', label: 'Role created', tone: 'neutral' },
  role_update: { icon: 'roles', label: 'Role changed', tone: 'neutral' },
  role_delete: { icon: 'roles', label: 'Role deleted', tone: 'neutral' },
  channel_create: { icon: 'channel', label: 'Channel created', tone: 'neutral' },
  channel_update: { icon: 'channel', label: 'Channel changed', tone: 'neutral' },
  channel_delete: { icon: 'channel', label: 'Channel deleted', tone: 'neutral' },
  thread_create: { icon: 'channel', label: 'Thread created', tone: 'neutral' },
  thread_delete: { icon: 'channel', label: 'Thread deleted', tone: 'neutral' },
  guild_update: { icon: 'server', label: 'Server changed', tone: 'neutral' },
  guild_available: { icon: 'server', label: 'Server available', tone: 'neutral' },
  guild_unavailable: { icon: 'server', label: 'Server unavailable', tone: 'hold' },
  invite_create: { icon: 'invite', label: 'Invite created', tone: 'neutral' },
  invite_delete: { icon: 'invite', label: 'Invite deleted', tone: 'neutral' },
  emoji_create: { icon: 'emoji', label: 'Emoji added', tone: 'neutral' },
  emoji_update: { icon: 'emoji', label: 'Emoji changed', tone: 'neutral' },
  emoji_delete: { icon: 'emoji', label: 'Emoji removed', tone: 'neutral' },
  sticker_create: { icon: 'emoji', label: 'Sticker added', tone: 'neutral' },
  sticker_update: { icon: 'emoji', label: 'Sticker changed', tone: 'neutral' },
  sticker_delete: { icon: 'emoji', label: 'Sticker removed', tone: 'neutral' },
  automod_action: { icon: 'automod', label: 'Discord AutoMod', tone: 'hold' },
  automod_match: { icon: 'automod', label: 'Automod match', tone: 'hold' },
  gap: { icon: 'gap', label: 'Logging paused', tone: 'hold' },
};

const FALLBACK: Meta = { icon: 'server', label: 'Server event', tone: 'neutral' };

/** ADR 0141 decision 4: conduct kinds only. */
const ACTION_KINDS: ReadonlySet<string> = new Set([
  'message_create',
  'message_edit',
  'message_delete',
  'automod_match',
  'automod_action',
]);

const HEAD_FINAL_MAX = 1000;
const QUOTE_FINAL_MAX = 1500;
const CHANGES_FINAL_MAX = 1300;
/** The fence lines around a changes block: "```\n" and "\n```". */
const CHANGES_FENCE_OVERHEAD = '```\n'.length + '\n```'.length;

/** Delete (when the message exists), Warn and Timeout. Undefined when there is nothing to offer. */
export const modActionRow = (input: {
  memberId?: string;
  message?: { channelId: string; messageId: string; exists: boolean };
}): ActionRow | undefined => {
  const buttons = [];
  if (input.message?.exists === true && input.memberId !== undefined)
    buttons.push(
      button({
        customId: buildModCustomId({
          action: 'delete',
          channelId: input.message.channelId,
          messageId: input.message.messageId,
          authorId: input.memberId,
        }),
        label: 'Delete message',
        style: 'danger',
      }),
    );
  if (input.memberId !== undefined) {
    buttons.push(
      button({
        customId: buildModCustomId({ action: 'warn', userId: input.memberId }),
        label: 'Warn',
      }),
    );
    buttons.push(
      button({
        customId: buildModCustomId({ action: 'timeout', userId: input.memberId }),
        label: 'Timeout',
      }),
    );
  }
  return buttons.length === 0 ? undefined : actionRow(buttons);
};

/**
 * The quote block, capped as a final rendered string: escaping (a backslash
 * per Markdown character) and the `> ` prefix on every line both add
 * characters, so truncating before them can roughly double past the cap.
 * `truncate` only removes from the end, so every line keeps its prefix; when
 * the cut lands inside a spoiler, the closing `||` is re-added within budget.
 */
const quoteBlock = (q: NonNullable<LogCardView['quote']>): string => {
  const body = escapeText(q.text.trim() === '' ? '(empty)' : q.text);
  const wrapped = q.spoiler === true ? `||${body}||` : body;
  const full = [`**${q.label}**`, ...wrapped.split('\n').map((line) => `> ${line}`)].join('\n');
  if (full.length <= QUOTE_FINAL_MAX) return full;
  // Slack for the two repairs below, both kept within budget: `truncate`'s
  // trimEnd can eat the space of a `> ` prefix when the cut lands right
  // after it (leaving a bare `>` line), and a cut spoiler needs its closing
  // `||` re-added.
  const budget = QUOTE_FINAL_MAX - (q.spoiler === true ? 3 : 1);
  let out = truncate(full, budget);
  const lines = out.split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (lines.length > 1 && !last.startsWith('> ')) out = `${lines.slice(0, -1).join('\n')}\n> …`;
  if (q.spoiler !== true) return out;
  // The body is escaped, so the wrapper holds the only raw `||`: an odd
  // count means the cut landed inside the spoiler, which is closed here.
  return (out.split('||').length - 1) % 2 === 1 ? `${out}||` : out;
};

/**
 * The changes block, capped as a final rendered string including both fence
 * lines: the content is truncated first, then the closing fence is added, so
 * the fence can never be cut off. Backticks that would close the block early
 * are already neutralised before the cap.
 */
const changesBlock = (lines: readonly string[]): string =>
  [
    '```',
    truncate(lines.join('\n').replaceAll('```', 'ˋˋˋ'), CHANGES_FINAL_MAX - CHANGES_FENCE_OVERHEAD),
    '```',
  ].join('\n');

export const renderLogCard = (view: LogCardView, guildId: string): CardMessage => {
  // `view.kind` is a plain string (audit items and the subscriber build views
  // from one), so a value outside `LogEventKind | 'gap'` can still reach this
  // lookup — the fallback stays for exactly that case.
  const meta = (LOG_KIND_META as Readonly<Record<string, Meta>>)[view.kind] ?? FALLBACK;
  const head = truncate(
    [
      subtext(`${ICON[meta.icon]} ${meta.label.toUpperCase()}`),
      view.headline,
      ...(view.details ?? []),
    ].join('\n'),
    HEAD_FINAL_MAX,
  );
  const children: ContainerChild[] = [text(head)];
  if (view.quote !== undefined) children.push(text(quoteBlock(view.quote)));
  if (view.changes !== undefined && view.changes.length > 0)
    children.push(text(changesBlock(view.changes)));
  const row = ACTION_KINDS.has(view.kind)
    ? modActionRow({
        ...(view.memberId === undefined ? {} : { memberId: view.memberId }),
        ...(view.message === undefined ? {} : { message: view.message }),
      })
    : undefined;
  if (row !== undefined) children.push(separator(), row);
  const footer = [ts(view.at, 'R')];
  if (view.message !== undefined && view.message.exists)
    footer.push(
      `[Jump to message](${jumpUrl(guildId, view.message.channelId, view.message.messageId)})`,
    );
  children.push(text(subtext(footer.join(' · '))));
  return card({ tone: meta.tone, children });
};
