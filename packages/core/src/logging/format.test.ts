import { describe, expect, it } from 'vitest';
import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';
import {
  formatGapMarker,
  formatMemberJoin,
  formatMemberLeave,
  formatMessageDelete,
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
} from './format.js';

const CHANNEL = '111111111111111111';
const AUTHOR = '222222222222222222';
const MESSAGE = '333333333333333333';
const ROLE = '444444444444444444';

const messageEditEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageUpdate',
  guildId: '000000000000000000',
  receivedAtMs: 1,
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorIsBot: false,
  content: 'hello world',
  editedTimestampMs: 2,
  ...over,
});

describe('formatMessageEdit', () => {
  it('names the channel and author, and includes content when asked and available', () => {
    const text = formatMessageEdit(messageEditEvent(), true);
    expect(text).toContain(`<#${CHANNEL}>`);
    expect(text).toContain(`<@${AUTHOR}>`);
    expect(text).toContain('hello world');
  });

  it('omits content entirely when the route has content turned off', () => {
    const text = formatMessageEdit(messageEditEvent({ content: 'secret' }), false);
    expect(text).not.toContain('secret');
  });

  it('says content is unavailable rather than silently omitting it when the message was uncached', () => {
    const text = formatMessageEdit(messageEditEvent({ content: undefined }), true);
    expect(text.toLowerCase()).toContain('not available');
  });

  it('reports the author as unknown rather than mentioning nobody when uncached', () => {
    const text = formatMessageEdit(messageEditEvent({ authorId: undefined }), true);
    expect(text.toLowerCase()).toContain('unknown');
    expect(text).not.toContain('<@undefined>');
  });
});

const ACTOR = '999999999999999999';

describe('formatMessageDelete', () => {
  it('names the channel, the author, and the inferred actor', () => {
    const text = formatMessageDelete(
      { channelId: CHANNEL, authorId: AUTHOR, content: 'deleted text' },
      ACTOR,
    );
    expect(text).toContain(`<#${CHANNEL}>`);
    expect(text).toContain(`<@${AUTHOR}>`);
    expect(text).toContain(`<@${ACTOR}>`);
    expect(text).toContain('deleted text');
  });

  it('labels the actor as inferred — never plain attribution (docs/20 gate)', () => {
    const text = formatMessageDelete({ channelId: CHANNEL, authorId: AUTHOR }, ACTOR);
    expect(text.toLowerCase()).toContain('inferred');
  });

  it('says the actor is unknown rather than guessing when none was found', () => {
    const text = formatMessageDelete({ channelId: CHANNEL, authorId: AUTHOR }, undefined);
    expect(text.toLowerCase()).toContain('unknown');
    expect(text).not.toContain(`<@${ACTOR}>`);
  });

  it('reports the author as unknown when the message was uncached', () => {
    const text = formatMessageDelete({ channelId: CHANNEL, authorId: undefined }, undefined);
    expect(text.toLowerCase()).toContain('unknown');
    expect(text).not.toContain('<@undefined>');
  });

  it('omits the content line entirely when there is none to show', () => {
    const text = formatMessageDelete({ channelId: CHANNEL, authorId: AUTHOR }, ACTOR);
    expect(text.toLowerCase()).not.toContain('content');
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
    expect(formatMemberJoin(memberEvent('memberAdd'))).toContain(`<@${AUTHOR}>`);
  });
});

describe('formatMemberLeave', () => {
  it('mentions the member', () => {
    expect(formatMemberLeave(memberEvent('memberRemove'))).toContain(`<@${AUTHOR}>`);
  });

  it('says nothing about why — kick/ban attribution is not this release (ADR 0023)', () => {
    const text = formatMemberLeave(memberEvent('memberRemove')).toLowerCase();
    expect(text).not.toContain('kick');
    expect(text).not.toContain('ban');
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
  it('names the role', () => {
    expect(formatRoleCreate(roleEvent('roleCreate'))).toContain('moderators');
  });
});

describe('formatRoleUpdate', () => {
  it('names the role', () => {
    expect(formatRoleUpdate(roleEvent('roleUpdate'))).toContain('moderators');
  });
});

describe('formatRoleDelete', () => {
  it('names the role by its last-known name, not a bare id', () => {
    const text = formatRoleDelete(roleEvent('roleDelete', { name: 'old-name' }));
    expect(text).toContain('old-name');
  });
});

describe('formatGapMarker', () => {
  it('names the window with Discord timestamp markup, not a server-assumed timezone', () => {
    // 1_700_000_000_000 ms -> 1_700_000_000 s, 1_700_000_060_000 ms -> 1_700_000_060 s.
    const text = formatGapMarker(1_700_000_000_000, 1_700_000_060_000);
    expect(text).toContain('<t:1700000000:t>');
    expect(text).toContain('<t:1700000060:t>');
  });

  it('says what kind of events were missed, not only "logs"', () => {
    const text = formatGapMarker(1_700_000_000_000, 1_700_000_060_000).toLowerCase();
    expect(text).toContain('message');
    expect(text).toContain('member');
    expect(text).toContain('role');
  });

  it('is visibly a warning, not a routine notice', () => {
    expect(formatGapMarker(0, 1)).toMatch(/^⚠/);
  });
});
