import { type TaskPosts } from '../../../ui/TaskPostsBanner.js';

export type SetupTeam = { teamId: string; name: string; categoryId: string; issues: string[] };
export type RoleCandidate = { roleId: string; name: string };
export type Setup = {
  teams: SetupTeam[];
  presidentRoleCandidates: RoleCandidate[];
  presidentRoleId: string | null;
  taskPosts?: TaskPosts;
};
export type GuildChannel = { channelId: string; name: string; kind: string; parentId?: string };
export type GuildRole = { roleId: string; name: string };
export type StoredMember = {
  discordUserId: string;
  kind: 'member' | 'lead';
  displayName: string | null;
};
export type DirectoryMember = {
  memberId: string;
  username: string;
  displayName: string;
  roleIds: string[];
};

/** Team setup for the owner and accounts with Manage club tasks (ADR 0130). Members use Discord; nothing here posts to Discord. */
