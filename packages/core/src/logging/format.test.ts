import { describe, expect, it } from 'vitest';
import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';
import type { AutomodActionTaken } from '../automod/subscriber.js';
import {
  formatAutomodMatch,
  formatGapMarker,
  formatMemberAvatarChanged,
  formatMemberJoin,
  formatMemberLeave,
  formatMemberNicknameChanged,
  formatMemberRolesChanged,
  formatMemberUsernameChanged,
  formatMessageCreate,
  formatMessageDelete,
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
  formatWarn,
} from './format.js';

const CHANNEL = '111111111111111111';
const AUTHOR = '222222222222222222';
const MESSAGE = '333333333333333333';
const ROLE = '444444444444444444';
const AT = 1_760_000_000_000;

const messageEditEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageUpdate',
  guildId: '000000000000000000',
  receivedAtMs: 1,
  channelId: CHANNEL,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'hello world',
  editedTimestampMs: 2,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('formatMessageCreate', () => {
  it('names the author and channel, quotes the content, and carries the target', () => {
    const view = formatMessageCreate(messageEditEvent({ kind: 'messageCreate' }), true, AT);
    expect(view.kind).toBe('message_create');
    expect(view.headline).toBe(`<@${AUTHOR}> sent a message in <#${CHANNEL}>`);
    expect(view.quote).toEqual({ label: 'Message', text: 'hello world' });
    expect(view.memberId).toBe(AUTHOR);
    expect(view.message).toEqual({ channelId: CHANNEL, messageId: MESSAGE, exists: true });
    expect(view.at).toBe(AT);
  });

  it('omits the quote when the route has content turned off', () => {
    const view = formatMessageCreate(
      messageEditEvent({ kind: 'messageCreate', content: 'secret' }),
      false,
      AT,
    );
    expect(view.quote).toBeUndefined();
  });
});

describe('formatMessageEdit', () => {
  it('names the author and channel, quotes the new content, and carries the target', () => {
    const view = formatMessageEdit(messageEditEvent(), true, AT);
    expect(view.kind).toBe('message_edit');
    expect(view.headline).toBe(`<@${AUTHOR}> edited a message in <#${CHANNEL}>`);
    expect(view.quote).toEqual({ label: 'Now reads', text: 'hello world' });
    expect(view.memberId).toBe(AUTHOR);
    expect(view.message).toEqual({ channelId: CHANNEL, messageId: MESSAGE, exists: true });
    expect(view.at).toBe(AT);
  });

  it('omits the quote and says content is not logged when the route has content off', () => {
    const view = formatMessageEdit(messageEditEvent({ content: 'secret' }), false, AT);
    expect(view.quote).toBeUndefined();
    expect(view.details).toEqual(['-# Content is not logged on this route.']);
  });

  it('says the new content was not available when the message was uncached', () => {
    const view = formatMessageEdit(messageEditEvent({ content: undefined }), true, AT);
    expect(view.quote).toBeUndefined();
    expect(view.details).toEqual(['-# The new content was not available.']);
  });

  it('reports the author as unknown rather than mentioning nobody when uncached', () => {
    const view = formatMessageEdit(messageEditEvent({ authorId: undefined }), true, AT);
    expect(view.headline.toLowerCase()).toContain('unknown');
    expect(view.headline).not.toContain('<@undefined>');
    expect(view.memberId).toBeUndefined();
  });
});

const ACTOR = '999999999999999999';

describe('formatMessageDelete', () => {
  it('names the author, the channel, the inferred actor, and quotes the content', () => {
    const view = formatMessageDelete(
      { channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR, content: 'deleted text' },
      ACTOR,
      AT,
    );
    expect(view.kind).toBe('message_delete');
    expect(view.headline).toBe(`Message by <@${AUTHOR}> deleted in <#${CHANNEL}>`);
    expect(view.details).toEqual([`Deleted by <@${ACTOR}> (inferred)`]);
    expect(view.quote).toEqual({ label: 'It read', text: 'deleted text' });
    expect(view.memberId).toBe(AUTHOR);
    expect(view.message).toEqual({ channelId: CHANNEL, messageId: MESSAGE, exists: false });
    expect(view.at).toBe(AT);
  });

  it('says the actor is unknown rather than guessing when none was found', () => {
    const view = formatMessageDelete(
      { channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR },
      undefined,
      AT,
    );
    expect(view.details).toEqual(['Deleted by: unknown']);
    expect(view.headline).not.toContain(`<@${ACTOR}>`);
  });

  it('reports the author as unknown when the message was uncached', () => {
    const view = formatMessageDelete(
      { channelId: CHANNEL, messageId: MESSAGE, authorId: undefined },
      undefined,
      AT,
    );
    expect(view.headline.toLowerCase()).toContain('unknown');
    expect(view.headline).not.toContain('<@undefined>');
    expect(view.memberId).toBeUndefined();
  });

  it('omits the quote entirely when there is no content to show', () => {
    const view = formatMessageDelete(
      { channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR },
      ACTOR,
      AT,
    );
    expect(view.quote).toBeUndefined();
  });
});

const memberEvent = (kind: MemberEvent['kind'], over: Partial<MemberEvent> = {}): MemberEvent => ({
  kind,
  guildId: '000000000000000000',
  receivedAtMs: 1,
  userId: AUTHOR,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: undefined,
  ...over,
});

describe('formatMemberJoin', () => {
  it('mentions the member', () => {
    const view = formatMemberJoin(memberEvent('memberAdd'), AT);
    expect(view.kind).toBe('member_join');
    expect(view.headline).toBe(`<@${AUTHOR}> joined`);
    expect(view.at).toBe(AT);
  });
});

describe('formatMemberRolesChanged', () => {
  it('names added roles first, then removed ones', () => {
    const view = formatMemberRolesChanged(AUTHOR, ['111', '222'], ['333'], AT);
    expect(view.kind).toBe('member_roles_changed');
    expect(view.headline).toBe(`<@${AUTHOR}>'s roles changed`);
    expect(view.details).toEqual(['Added <@&111> <@&222>', 'Removed <@&333>']);
  });

  it('omits an empty side', () => {
    expect(formatMemberRolesChanged(AUTHOR, ['111'], [], AT).details).toEqual(['Added <@&111>']);
    expect(formatMemberRolesChanged(AUTHOR, [], ['333'], AT).details).toEqual(['Removed <@&333>']);
  });
});

describe('formatMemberNicknameChanged', () => {
  it('renders old → new escaped', () => {
    const view = formatMemberNicknameChanged(AUTHOR, 'Old', 'New', AT);
    expect(view.kind).toBe('member_nickname_changed');
    expect(view.headline).toBe(`<@${AUTHOR}> changed nickname`);
    expect(view.details).toEqual(['Old → New']);
  });

  it('escapes markdown and uses (none) for an absent nickname on either side', () => {
    expect(formatMemberNicknameChanged(AUTHOR, 'a*', undefined, AT).details).toEqual([
      'a\\* → (none)',
    ]);
    expect(formatMemberNicknameChanged(AUTHOR, undefined, 'New', AT).details).toEqual([
      '(none) → New',
    ]);
  });
});

describe('formatMemberUsernameChanged', () => {
  it('renders a username change', () => {
    const view = formatMemberUsernameChanged(
      {
        userId: AUTHOR,
        oldUsername: 'old_name',
        newUsername: 'new_name',
        oldGlobalName: 'Global',
        newGlobalName: 'Global',
      },
      AT,
    );
    expect(view.kind).toBe('member_username_changed');
    expect(view.details).toEqual(['Username: old\\_name → new\\_name']);
  });

  it('renders a display-name change', () => {
    const view = formatMemberUsernameChanged(
      {
        userId: AUTHOR,
        oldUsername: 'member',
        newUsername: 'member',
        oldGlobalName: undefined,
        newGlobalName: 'New Display',
      },
      AT,
    );
    expect(view.details).toEqual(['Display name: (none) → New Display']);
  });

  it('renders both lines when both changed', () => {
    const view = formatMemberUsernameChanged(
      {
        userId: AUTHOR,
        oldUsername: 'old_name',
        newUsername: 'new_name',
        oldGlobalName: 'Old Display',
        newGlobalName: 'New Display',
      },
      AT,
    );
    expect(view.details).toHaveLength(2);
  });

  it('escapes markdown in names', () => {
    const view = formatMemberUsernameChanged(
      {
        userId: AUTHOR,
        oldUsername: '**x**',
        newUsername: 'new_name',
        oldGlobalName: 'Global',
        newGlobalName: 'Global',
      },
      AT,
    );
    expect(view.details).toEqual(['Username: \\*\\*x\\*\\* → new\\_name']);
  });
});

describe('formatMemberAvatarChanged', () => {
  const GUILD = '000000000000000001';

  it('links the new account avatar', () => {
    const view = formatMemberAvatarChanged(
      {
        userId: AUTHOR,
        guildId: GUILD,
        accountChanged: true,
        newAvatarHash: 'abc',
        guildAvatarChanged: false,
        newGuildAvatarHash: undefined,
      },
      AT,
    );
    expect(view.details).toEqual([`Avatar: https://cdn.discordapp.com/avatars/${AUTHOR}/abc.png`]);
  });

  it('links the new server avatar', () => {
    const view = formatMemberAvatarChanged(
      {
        userId: AUTHOR,
        guildId: GUILD,
        accountChanged: false,
        newAvatarHash: undefined,
        guildAvatarChanged: true,
        newGuildAvatarHash: 'ghi',
      },
      AT,
    );
    expect(view.details).toEqual([
      `Server avatar: https://cdn.discordapp.com/guilds/${GUILD}/users/${AUTHOR}/avatars/ghi.png`,
    ]);
  });

  it('names a removal rather than linking', () => {
    const view = formatMemberAvatarChanged(
      {
        userId: AUTHOR,
        guildId: GUILD,
        accountChanged: true,
        newAvatarHash: undefined,
        guildAvatarChanged: false,
        newGuildAvatarHash: undefined,
      },
      AT,
    );
    expect(view.details?.join('\n').toLowerCase()).toContain('removed');
    expect(view.details?.join('\n')).not.toContain('cdn.discordapp.com');
  });
});

describe('formatMemberLeave', () => {
  it('mentions the member', () => {
    const view = formatMemberLeave(memberEvent('memberRemove'), AT);
    expect(view.kind).toBe('member_leave');
    expect(view.headline).toBe(`<@${AUTHOR}> left`);
  });

  it('says nothing about why — kick/ban attribution is not this release (ADR 0023)', () => {
    const headline = formatMemberLeave(memberEvent('memberRemove'), AT).headline.toLowerCase();
    expect(headline).not.toContain('kick');
    expect(headline).not.toContain('ban');
  });
});

const roleEvent = (kind: RoleEvent['kind'], over: Partial<RoleEvent> = {}): RoleEvent => ({
  kind,
  guildId: '000000000000000000',
  receivedAtMs: 1,
  roleId: ROLE,
  name: 'moderators',
  ...over,
});

describe('formatRoleCreate', () => {
  it('names the escaped role and the id', () => {
    const view = formatRoleCreate(roleEvent('roleCreate'), AT);
    expect(view.kind).toBe('role_create');
    expect(view.headline).toBe('Role **moderators** created');
    expect(view.details).toEqual([`-# ${ROLE}`]);
  });

  it('escapes markdown in the name', () => {
    expect(formatRoleCreate(roleEvent('roleCreate', { name: '**x**' }), AT).headline).toBe(
      'Role **\\*\\*x\\*\\*** created',
    );
  });
});

describe('formatRoleUpdate', () => {
  it('names the role as changed', () => {
    const view = formatRoleUpdate(roleEvent('roleUpdate'), AT);
    expect(view.kind).toBe('role_update');
    expect(view.headline).toBe('Role **moderators** changed');
    expect(view.details).toEqual([`-# ${ROLE}`]);
  });
});

describe('formatRoleDelete', () => {
  it('names the role by its last-known name, not a bare id', () => {
    const view = formatRoleDelete(roleEvent('roleDelete', { name: 'old-name' }), AT);
    expect(view.kind).toBe('role_delete');
    expect(view.headline).toBe('Role **old-name** deleted');
    expect(view.details).toEqual([`-# ${ROLE}`]);
  });
});

describe('formatWarn', () => {
  it('names the member, the moderator, the reason, the case and the count', () => {
    const view = formatWarn(
      {
        memberId: '333333333333333333',
        actorId: '222222222222222222',
        reason: 'spam',
        caseId: 'case-1-23456789',
        violationCount: 2,
      },
      AT,
    );
    expect(view.kind).toBe('member_warn');
    expect(view.headline).toBe('<@333333333333333333> was warned by <@222222222222222222>');
    expect(view.quote).toEqual({ label: 'Reason', text: 'spam' });
    expect(view.details).toEqual(['Case case-1-2 · warning 2']);
    expect(view.at).toBe(AT);
  });

  it('caps a long reason at 300 characters', () => {
    const view = formatWarn(
      {
        memberId: '333333333333333333',
        actorId: '222222222222222222',
        reason: 'r'.repeat(400),
        caseId: 'case-1',
        violationCount: 1,
      },
      AT,
    );
    expect(view.quote).toEqual({ label: 'Reason', text: 'r'.repeat(300) });
  });
});

describe('formatGapMarker', () => {
  it('names the window with Discord timestamp markup, not a server-assumed timezone', () => {
    // 1_700_000_000_000 ms -> 1_700_000_000 s, 1_700_000_060_000 ms -> 1_700_000_060 s.
    const view = formatGapMarker(1_700_000_000_000, 1_700_000_060_000, AT);
    expect(view.kind).toBe('gap');
    expect(view.headline).toBe(
      'Bananasaurs was disconnected from <t:1700000000:t> to <t:1700000060:t>.',
    );
    expect(view.at).toBe(AT);
  });

  it('says what kind of events were missed, not only "logs"', () => {
    const details = formatGapMarker(1_700_000_000_000, 1_700_000_060_000, AT)
      .details?.join('\n')
      .toLowerCase();
    expect(details).toContain('message');
    expect(details).toContain('member');
    expect(details).toContain('role');
  });
});

describe('formatAutomodMatch', () => {
  const base = {
    ruleId: 'rule-1',
    ruleKind: 'keyword_filter',
    memberId: AUTHOR,
    channelId: CHANNEL,
    messageId: MESSAGE,
    snippet: 'badword',
    at: AT,
  };

  it('a watch match names the rule, the member and the channel, spoilered', () => {
    const view = formatAutomodMatch({ ...base, actionTaken: 'would_delete' }, true);
    expect(view.kind).toBe('automod_match');
    expect(view.headline).toBe(
      `<@${AUTHOR}> matched a **keyword\\_filter** rule in <#${CHANNEL}>`,
    );
    expect(view.details).toEqual(['Watch only — nothing was done.']);
    expect(view.quote).toEqual({ label: 'Matched', text: 'badword', spoiler: true });
    expect(view.message).toEqual({ channelId: CHANNEL, messageId: MESSAGE, exists: true });
    expect(view.memberId).toBe(AUTHOR);
    expect(view.at).toBe(AT);
  });

  it('a deleted match says the message was deleted and drops the button', () => {
    const view = formatAutomodMatch({ ...base, actionTaken: 'deleted' }, true);
    expect(view.details).toEqual(['The message was deleted.']);
    expect(view.message).toEqual({ channelId: CHANNEL, messageId: MESSAGE, exists: false });
  });

  it.each([
    ['delete_blocked_killswitch', 'Not deleted: the kill switch is on.', true],
    ['delete_blocked_breaker', 'Not deleted: the safety breaker is open.', true],
    ['delete_blocked_dry_run', 'Not deleted: dry run is on.', true],
    ["delete_failed", "Not deleted: Discord didn't accept the delete.", true],
  ] as const)('%s → %s', (actionTaken, words, exists) => {
    const view = formatAutomodMatch({ ...base, actionTaken }, true);
    expect(view.details).toEqual([words]);
    expect(view.message?.exists).toBe(exists);
  });

  it.each(['deleted_and_escalated', 'escalation_refused', 'native_blocked'] as const)(
    '%s says Recorded.',
    (actionTaken: AutomodActionTaken) => {
      expect(formatAutomodMatch({ ...base, actionTaken }, true).details).toEqual(['Recorded.']);
    },
  );

  it('omits the quote when the route has content off', () => {
    expect(formatAutomodMatch({ ...base, actionTaken: 'would_delete' }, false).quote).toBeUndefined();
  });
});
