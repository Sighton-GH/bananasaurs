import type { MemberEvent } from '../discord/events.js';
import {
  formatMemberAvatarChanged,
  formatMemberNicknameChanged,
  formatMemberRolesChanged,
  formatMemberUsernameChanged,
} from './format.js';

/**
 * The four member-change actions that replace the vague `member_update`
 * (ADR 0123 decision 9). Each one carries its own old → new, diffed against
 * the per-member last-seen record (`baselineFor`/`memberChanges` below).
 */
export const MEMBER_CHANGE_KINDS = [
  'member_roles_changed',
  'member_nickname_changed',
  'member_username_changed',
  'member_avatar_changed',
] as const;

export type MemberChangeKind = (typeof MEMBER_CHANGE_KINDS)[number];

/** The snapshot fields this module reads. Structural so core never imports storage. */
export interface MemberSnapshotLike {
  userId: string;
  username: string;
  globalName: string | undefined;
  nickname: string | undefined;
  avatarHash: string | undefined;
  guildAvatarHash: string | undefined;
  roleIds: readonly string[];
  updatedAtMs: number;
}

export interface MemberBaseline {
  username: string | undefined;
  globalName: string | undefined;
  nickname: string | undefined;
  avatarHash: string | undefined;
  guildAvatarHash: string | undefined;
  roleIds: readonly string[] | undefined;
  knownUserFields: boolean;
  knownNickname: boolean;
  knownGuildAvatar: boolean;
  /** `snapshot.updatedAtMs` as a string, or `'first'` when there is no snapshot. */
  version: string;
}

export interface MemberChange {
  eventKind: MemberChangeKind;
  render(): string;
}

/**
 * Baseline from the stored snapshot when there is one; otherwise from the
 * event's non-partial `previousMember` / `previousRoleIds`; user-level
 * fields are unknown without a snapshot.
 *
 * discord.js hands `before.user` and `after.user` as the same object, so a
 * previous username, display name or account avatar is never observable on
 * the event — only the stored record knows them. Member-level fields
 * (nickname, server avatar) do have a real "before", but only when `before`
 * was not partial.
 */
export function baselineFor(
  snapshot: MemberSnapshotLike | undefined,
  event: MemberEvent,
): MemberBaseline {
  if (snapshot !== undefined) {
    return {
      username: snapshot.username,
      globalName: snapshot.globalName,
      nickname: snapshot.nickname,
      avatarHash: snapshot.avatarHash,
      guildAvatarHash: snapshot.guildAvatarHash,
      roleIds: snapshot.roleIds,
      knownUserFields: true,
      knownNickname: true,
      knownGuildAvatar: true,
      version: String(snapshot.updatedAtMs),
    };
  }
  return {
    username: undefined,
    globalName: undefined,
    nickname: event.previousMember?.nickname,
    avatarHash: undefined,
    guildAvatarHash: event.previousMember?.guildAvatarHash,
    roleIds: event.previousRoleIds,
    knownUserFields: false,
    knownNickname: event.previousMember !== undefined,
    knownGuildAvatar: event.previousMember !== undefined,
    version: 'first',
  };
}

/**
 * The changes between baseline and the event's profile/roles. A field whose
 * baseline is unknown produces no change — without a previous value the bot
 * cannot tell whether it changed at all, so the first sighting establishes
 * the baseline silently.
 */
export function memberChanges(baseline: MemberBaseline, event: MemberEvent): MemberChange[] {
  const profile = event.profile;
  if (profile === undefined) return [];
  const changes: MemberChange[] = [];

  if (baseline.roleIds !== undefined) {
    const before = new Set(baseline.roleIds);
    const after = new Set(event.roleIds);
    const added = event.roleIds.filter((id) => !before.has(id));
    const removed = baseline.roleIds.filter((id) => !after.has(id));
    if (added.length > 0 || removed.length > 0) {
      const text = formatMemberRolesChanged(event.userId, added, removed);
      changes.push({ eventKind: 'member_roles_changed', render: () => text });
    }
  }

  if (baseline.knownNickname && baseline.nickname !== profile.nickname) {
    const text = formatMemberNicknameChanged(event.userId, baseline.nickname, profile.nickname);
    changes.push({ eventKind: 'member_nickname_changed', render: () => text });
  }

  if (baseline.knownUserFields) {
    const usernameChanged =
      baseline.username !== undefined && baseline.username !== profile.username;
    const globalNameChanged = (baseline.globalName ?? undefined) !== (profile.globalName ?? undefined);
    if (usernameChanged || globalNameChanged) {
      const text = formatMemberUsernameChanged({
        userId: event.userId,
        oldUsername: baseline.username,
        newUsername: profile.username,
        oldGlobalName: baseline.globalName,
        newGlobalName: profile.globalName,
      });
      changes.push({ eventKind: 'member_username_changed', render: () => text });
    }
    const accountChanged = baseline.avatarHash !== (profile.avatarHash ?? undefined);
    const guildAvatarChanged =
      baseline.knownGuildAvatar &&
      baseline.guildAvatarHash !== (profile.guildAvatarHash ?? undefined);
    if (accountChanged || guildAvatarChanged) {
      const text = formatMemberAvatarChanged({
        userId: event.userId,
        guildId: event.guildId,
        accountChanged,
        newAvatarHash: profile.avatarHash,
        guildAvatarChanged,
        newGuildAvatarHash: profile.guildAvatarHash,
      });
      changes.push({ eventKind: 'member_avatar_changed', render: () => text });
    }
  } else if (baseline.knownGuildAvatar) {
    // No snapshot yet, but a non-partial `before` named the previous server
    // avatar: a guild-avatar change is still observable.
    if (baseline.guildAvatarHash !== (profile.guildAvatarHash ?? undefined)) {
      const text = formatMemberAvatarChanged({
        userId: event.userId,
        guildId: event.guildId,
        accountChanged: false,
        newAvatarHash: profile.avatarHash,
        guildAvatarChanged: true,
        newGuildAvatarHash: profile.guildAvatarHash,
      });
      changes.push({ eventKind: 'member_avatar_changed', render: () => text });
    }
  }

  return changes;
}
