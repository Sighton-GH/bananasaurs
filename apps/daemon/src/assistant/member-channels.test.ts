import { describe, expect, it, vi } from 'vitest';
import { memberChannels, type MemberChannelsGuild } from './member-channels.js';

const channel = (id: string, name: string, over: { text?: boolean; thread?: boolean } = {}) => ({
  id,
  name,
  isTextBased: () => over.text ?? true,
  isThread: () => over.thread ?? false,
});

const fetchMember = vi.fn();
const guildWith = (canSee: (channelId: string) => boolean): MemberChannelsGuild => ({
  channels: {
    cache: new Map([
      ['1', channel('1', 'general')],
      ['2', channel('2', 'staff')],
      ['3', channel('3', 'voice', { text: false })],
      ['4', channel('4', 'a-thread', { thread: true })],
    ]),
  },
  members: {
    fetch: fetchMember.mockImplementation(async () => ({
      permissionsIn: (c: { id: string }) => ({ has: () => canSee(c.id) }),
    })),
  },
});

describe('memberChannels (ADR 0067)', () => {
  it('returns text channels the member can view and read, never threads', async () => {
    const guild = guildWith((id) => id !== '2');
    await expect(memberChannels(guild, '9')).resolves.toEqual([{ id: '1', name: 'general' }]);
    expect(fetchMember).toHaveBeenCalledWith('9');
  });

  it('fails closed when the guild is not cached or the member cannot be fetched', async () => {
    await expect(memberChannels(undefined, '9')).resolves.toEqual([]);
    const guild = guildWith(() => true);
    guild.members.fetch = vi.fn(async () => {
      throw new Error('Unknown Member');
    });
    await expect(memberChannels(guild, '9')).resolves.toEqual([]);
  });
});
