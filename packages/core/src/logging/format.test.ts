import { describe, expect, it } from 'vitest';
import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';
import {
  formatMemberJoin,
  formatMemberLeave,
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

  it('says nothing about why — kick/ban attribution is not this release (ADR 0022)', () => {
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
