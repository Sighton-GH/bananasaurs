import { taskPostsState } from '@bananasaurs/core';
import { guildRepo, type GuildScope } from '@bananasaurs/storage';

/** ADR 0131: whether this guild's task posts send on this pass — the live row AND install-wide dry run off. */
export const taskPostsEnabledFor = (scope: GuildScope, dryRun: boolean): boolean =>
  taskPostsState({ switchOn: guildRepo.readTaskPostsEnabled(scope), dryRun }).enabled;
