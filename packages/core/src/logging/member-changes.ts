import type { MemberEvent } from '../discord/events.js';

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
 */
export function baselineFor(
  _snapshot: MemberSnapshotLike | undefined,
  _event: MemberEvent,
): MemberBaseline {
  throw new Error('not implemented');
}

/** The changes between baseline and the event's profile/roles. A field whose baseline is unknown produces no change. */
export function memberChanges(
  _baseline: MemberBaseline,
  _event: MemberEvent,
): MemberChange[] {
  throw new Error('not implemented');
}
