import { describe, expect, it } from 'vitest';
import { resolveChannelRef, resolveRoleRef } from './resolve.js';
import type { McpGuildChannel, McpGuildRole } from './tools/guild.js';

const channels: readonly McpGuildChannel[] = [
  {
    id: '200000000000000001',
    name: 'help',
    type: 'GuildText',
    parentId: undefined,
    parentName: undefined,
    topic: undefined,
    archiveEnabled: true,
  },
  {
    id: '200000000000000002',
    name: 'general',
    type: 'GuildText',
    parentId: undefined,
    parentName: undefined,
    topic: undefined,
    archiveEnabled: true,
  },
  {
    id: '200000000000000003',
    name: 'general',
    type: 'GuildText',
    parentId: undefined,
    parentName: undefined,
    topic: undefined,
    archiveEnabled: true,
  },
  {
    id: '200000000000000004',
    name: 'Tech-Tasks',
    type: 'GuildText',
    parentId: undefined,
    parentName: undefined,
    topic: undefined,
    archiveEnabled: true,
  },
];

const roles: readonly McpGuildRole[] = [
  {
    id: '300000000000000001',
    name: 'Car Team A',
    position: 1,
    color: 0,
    managedByBananasaurs: false,
  },
  {
    id: '300000000000000002',
    name: 'club member',
    position: 2,
    color: 0,
    managedByBananasaurs: false,
  },
  {
    id: '300000000000000003',
    name: 'Club Member',
    position: 3,
    color: 0,
    managedByBananasaurs: false,
  },
];

describe('resolveChannelRef', () => {
  it('passes a snowflake through unchanged', () => {
    expect(resolveChannelRef(channels, '200000000000000009')).toEqual({
      ok: true,
      id: '200000000000000009',
    });
  });

  it('resolves #help by name', () => {
    expect(resolveChannelRef(channels, '#help')).toEqual({
      ok: true,
      id: '200000000000000001',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(resolveChannelRef(channels, '  help ')).toEqual({
      ok: true,
      id: '200000000000000001',
    });
  });

  it('compares case-insensitively', () => {
    expect(resolveChannelRef(channels, 'tech-tasks')).toEqual({
      ok: true,
      id: '200000000000000004',
    });
  });

  it('refuses an ambiguous name with candidates', () => {
    const result = resolveChannelRef(channels, 'general');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('(200000000000000002)');
    expect(result.message).toContain('(200000000000000003)');
    expect(result.message.endsWith('Pass an id.')).toBe(true);
  });

  it('refuses an unknown name exactly', () => {
    expect(resolveChannelRef(channels, 'nope')).toEqual({
      ok: false,
      message: 'No channel named "nope" in this guild.',
    });
  });
});

describe('resolveRoleRef', () => {
  it('strips one leading @', () => {
    expect(resolveRoleRef(roles, '@Car Team A')).toEqual({
      ok: true,
      id: '300000000000000001',
    });
  });

  it('refuses an ambiguous role name with both candidates', () => {
    const result = resolveRoleRef(roles, 'club member');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('(300000000000000002)');
    expect(result.message).toContain('(300000000000000003)');
    expect(result.message.endsWith('Pass an id.')).toBe(true);
  });
});
