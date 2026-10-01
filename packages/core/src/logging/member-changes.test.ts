import { describe, expect, it } from 'vitest';
import type { MemberEvent } from '../discord/events.js';
import {
  baselineFor,
  MEMBER_CHANGE_KINDS,
  memberChanges,
  type MemberSnapshotLike,
} from './member-changes.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const ROLE_A = '333333333333333333';
const ROLE_B = '444444444444444444';
const ROLE_C = '555555555555555555';

const updateEvent = (over: Partial<MemberEvent> = {}): MemberEvent => ({
  kind: 'memberUpdate',
  guildId: GUILD,
  receivedAtMs: 1_000,
  userId: USER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: undefined,
  profile: {
    username: 'member',
    globalName: 'Global',
    nickname: undefined,
    avatarHash: 'avatar1',
    guildAvatarHash: undefined,
  },
  previousMember: undefined,
  ...over,
});

const snapshot = (over: Partial<MemberSnapshotLike> = {}): MemberSnapshotLike => ({
  userId: USER,
  username: 'member',
  globalName: 'Global',
  nickname: undefined,
  avatarHash: 'avatar1',
  guildAvatarHash: undefined,
  roleIds: [],
  updatedAtMs: 900,
  ...over,
});

describe('MEMBER_CHANGE_KINDS', () => {
  it('holds the four actions that replace member_update', () => {
    expect([...MEMBER_CHANGE_KINDS].sort()).toEqual(
      [
        'member_roles_changed',
        'member_nickname_changed',
        'member_username_changed',
        'member_avatar_changed',
      ].sort(),
    );
  });
});

describe('baselineFor', () => {
  it('reads every field from the snapshot when there is one', () => {
    const baseline = baselineFor(
      snapshot({ nickname: 'Nick', roleIds: [ROLE_A], updatedAtMs: 123 }),
      updateEvent(),
    );
    expect(baseline).toMatchObject({
      username: 'member',
      globalName: 'Global',
      nickname: 'Nick',
      avatarHash: 'avatar1',
      knownUserFields: true,
      knownNickname: true,
      knownGuildAvatar: true,
      version: '123',
    });
    expect(baseline.roleIds).toEqual([ROLE_A]);
  });

  it('leaves user-level fields unknown without a snapshot', () => {
    const baseline = baselineFor(undefined, updateEvent({ previousMember: undefined }));
    expect(baseline.knownUserFields).toBe(false);
    expect(baseline.username).toBeUndefined();
    expect(baseline.version).toBe('first');
  });
});

describe('memberChanges without a snapshot', () => {
  it('a partial before produces no changes at all — the baseline is silently established', () => {
    const event = updateEvent({ previousRoleIds: undefined, previousMember: undefined });
    const changes = memberChanges(baselineFor(undefined, event), event);
    expect(changes).toEqual([]);
  });

  it('a non-partial before with a different nickname produces a nickname change', () => {
    const event = updateEvent({
      previousRoleIds: [],
      previousMember: { nickname: 'Old', guildAvatarHash: undefined },
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: 'New',
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(undefined, event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_nickname_changed']);
    expect(changes[0]?.render()).toContain('"Old"');
    expect(changes[0]?.render()).toContain('"New"');
  });

  it('differing previousRoleIds produce a roles change', () => {
    const event = updateEvent({
      previousRoleIds: [],
      roleIds: [ROLE_A],
      previousMember: { nickname: undefined, guildAvatarHash: undefined },
    });
    const changes = memberChanges(baselineFor(undefined, event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_roles_changed']);
    expect(changes[0]?.render()).toContain(`<@&${ROLE_A}>`);
  });

  it('an unknown username without a snapshot produces no username change', () => {
    // discord.js shares the user object between before and after, so there is
    // no previous username to compare against — even a "different" name is
    // unknowable without the stored record.
    const event = updateEvent({ previousRoleIds: [], previousMember: undefined });
    const changes = memberChanges(baselineFor(undefined, event), event);
    expect(changes.map((c) => c.eventKind)).not.toContain('member_username_changed');
  });
});

describe('memberChanges with a snapshot', () => {
  it('detects a nickname change with old → new', () => {
    const event = updateEvent({
      roleIds: [],
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: 'New',
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot({ nickname: 'Old' }), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_nickname_changed']);
    expect(changes[0]?.render()).toBe(
      `Nickname changed: <@${USER}>  "Old" → "New"`,
    );
  });

  it('uses (none) for an absent nickname on either side', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: undefined,
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot({ nickname: 'Old' }), event), event);
    expect(changes[0]?.render()).toContain('(none)');
  });

  it('detects a username change with old → new', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'renamed',
        globalName: 'Global',
        nickname: undefined,
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_username_changed']);
    expect(changes[0]?.render()).toContain('member → renamed');
  });

  it('detects a display-name change', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'New Display',
        nickname: undefined,
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_username_changed']);
    expect(changes[0]?.render()).toContain('Display name changed');
  });

  it('both username and display name changed produce one change with two lines', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'renamed',
        globalName: 'New Display',
        nickname: undefined,
        avatarHash: 'avatar1',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.eventKind).toBe('member_username_changed');
    const lines = changes[0]?.render().split('\n') ?? [];
    expect(lines).toHaveLength(2);
  });

  it('detects an account avatar change as a CDN link', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: undefined,
        avatarHash: 'avatar2',
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_avatar_changed']);
    expect(changes[0]?.render()).toContain(
      `https://cdn.discordapp.com/avatars/${USER}/avatar2.png`,
    );
  });

  it('detects a server avatar change as a guild CDN link', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: undefined,
        avatarHash: 'avatar1',
        guildAvatarHash: 'guild1',
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_avatar_changed']);
    expect(changes[0]?.render()).toContain(
      `https://cdn.discordapp.com/guilds/${GUILD}/users/${USER}/avatars/guild1.png`,
    );
  });

  it('a removed avatar names the removal rather than linking', () => {
    const event = updateEvent({
      previousRoleIds: [],
      profile: {
        username: 'member',
        globalName: 'Global',
        nickname: undefined,
        avatarHash: undefined,
        guildAvatarHash: undefined,
      },
    });
    const changes = memberChanges(baselineFor(snapshot(), event), event);
    expect(changes.map((c) => c.eventKind)).toEqual(['member_avatar_changed']);
    expect(changes[0]?.render().toLowerCase()).toContain('removed their avatar');
  });

  it('detects role grants and removals, added first', () => {
    const event = updateEvent({
      roleIds: [ROLE_A, ROLE_B],
      previousRoleIds: [ROLE_A, ROLE_C],
    });
    const changes = memberChanges(
      baselineFor(snapshot({ roleIds: [ROLE_A, ROLE_C] }), event),
      event,
    );
    expect(changes.map((c) => c.eventKind)).toEqual(['member_roles_changed']);
    expect(changes[0]?.render()).toBe(
      `Roles changed: <@${USER}>  +<@&${ROLE_B}>  −<@&${ROLE_C}>`,
    );
  });

  it('an identical profile produces no changes', () => {
    const event = updateEvent({ roleIds: [ROLE_A], previousRoleIds: [ROLE_A] });
    const changes = memberChanges(
      baselineFor(
        snapshot({
          username: 'member',
          globalName: 'Global',
          nickname: undefined,
          avatarHash: 'avatar1',
          guildAvatarHash: undefined,
          roleIds: [ROLE_A],
        }),
        event,
      ),
      event,
    );
    expect(changes).toEqual([]);
  });

  it('produces no changes when the event carries no profile', () => {
    const event = updateEvent({ profile: undefined });
    expect(memberChanges(baselineFor(snapshot(), event), event)).toEqual([]);
  });
});
