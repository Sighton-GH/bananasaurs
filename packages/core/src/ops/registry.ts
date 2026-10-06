import type { RegisteredCommand } from './dispatch.js';
import {
  archiveDeleteChannelCommand,
  archiveEnableCategoryCommand,
  archiveDeleteCategoryCommand,
  archivePauseCategoryCommand,
  archivePauseChannelCommand,
  archiveResumeCategoryCommand,
  archiveResumeChannelCommand,
  archiveSetThreadsCommand,
  archiveThreadsCommand,
  archiveEnableChannelCommand,
  archiveLinkCaseCommand,
  archivePreserveCommand,
  archiveReindexCommand,
  archiveSearchCommand,
  archiveStatusCommand,
} from './commands/archive.js';
import {
  automodDomainAddCommand,
  automodDomainRmCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodReviewCommand,
  automodVerdictCommand,
} from './commands/automod.js';
import {
  accountDeleteCommand,
  accountDisableCommand,
  accountEnableCommand,
  accountGrantCommand,
  accountGrantGuildCommand,
  accountListCommand,
  accountRevokeCredentialsCommand,
  accountRevokeGuildCommand,
  accountSetPasswordCommand,
} from './commands/account.js';
import { providerReviewCommand } from './commands/provider.js';
import { backupListCommand, backupNowCommand } from './commands/backup.js';
import { bootstrapReissueCommand } from './commands/bootstrap.js';
import {
  mcpCleanupCommand,
  mcpClientsCommand,
  mcpConnectionsCommand,
  mcpDeleteConnectionCommand,
  mcpDeleteTokenCommand,
  mcpDisconnectCommand,
  mcpRevokeClientCommand,
  mcpRevokeCommand,
  mcpTokensCommand,
} from './commands/mcp.js';
import {
  mcpAllowChannelCommand,
  mcpAllowCategoryCommand,
  mcpDisallowCategoryCommand,
  mcpAllowlistCommand,
  mcpDisallowChannelCommand,
  mcpSendsCommand,
} from './commands/mcp-allowlist.js';
import {
  readScopeDisableCategoryCommand,
  readScopeDisableChannelCommand,
  readScopeEnableCategoryCommand,
  readScopeEnableChannelCommand,
  readScopeListCommand,
} from './commands/read-scope.js';
import {
  mcpAllowRoleCommand,
  mcpDisallowRoleCommand,
  mcpRolePolicyCommand,
} from './commands/mcp-role-policy.js';
import { killswitchCommand } from './commands/killswitch.js';
import {
  auditTailCommand,
  configGetCommand,
  doctorCommand,
  jobsListCommand,
  logRoutingListCommand,
  panelListCommand,
  panelShowCommand,
} from './commands/reads.js';
import { statusCommand } from './commands/status.js';
import { adoptionAllowCommand, panelSyncCommand, undoCommand } from './commands/effects.js';
import { panelCreateCommand } from './commands/panel-create.js';
import { panelDeleteCommand } from './commands/panel-delete.js';
import { panelEditCommand } from './commands/panel-edit.js';
import {
  configSetCommand,
  jobsRetryCommand,
  logRoutingCreateCommand,
  logRoutingDeleteCommand,
  logRoutingExcludeCommand,
  logRoutingOffCommand,
  logRoutingOnCommand,
  logRoutingUnexcludeCommand,
  logRoutingUpdateCommand,
} from './commands/writes.js';

/**
 * The operator command surface, in one list.
 *
 * `docs/17` §1 is the specification; this is the implementation of it, and the
 * daemon and the CLI both read *this* rather than each keeping their own idea
 * of what commands exist. The CLI can therefore parse a command line, print
 * `--help`, and refuse an unknown command without a round trip, and it cannot
 * drift from what the daemon will actually accept.
 */
export const OPERATOR_COMMANDS: readonly RegisteredCommand[] = [
  statusCommand,
  doctorCommand,
  configGetCommand,
  panelListCommand,
  panelShowCommand,
  logRoutingListCommand,
  auditTailCommand,
  jobsListCommand,
  backupListCommand,
  automodReviewCommand,
  archiveStatusCommand,
  archiveSearchCommand,
  mcpAllowlistCommand,
  mcpSendsCommand,
  readScopeListCommand,

  // Writes. Each needs `--confirm` and each records an audit row; the
  // dispatcher enforces both, so the ordering here is for `--help` only.
  configSetCommand,
  automodVerdictCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodDomainAddCommand,
  automodDomainRmCommand,
  logRoutingCreateCommand,
  logRoutingUpdateCommand,
  logRoutingOnCommand,
  logRoutingOffCommand,
  logRoutingDeleteCommand,
  logRoutingExcludeCommand,
  logRoutingUnexcludeCommand,
  jobsRetryCommand,
  backupNowCommand,
  archiveEnableChannelCommand,
  archiveDeleteChannelCommand,
  archivePauseChannelCommand,
  archiveResumeChannelCommand,
  archiveEnableCategoryCommand,
  archiveDeleteCategoryCommand,
  archivePauseCategoryCommand,
  archiveResumeCategoryCommand,
  archiveSetThreadsCommand,
  archiveThreadsCommand,
  archivePreserveCommand,
  archiveLinkCaseCommand,
  archiveReindexCommand,
  mcpClientsCommand,
  mcpTokensCommand,
  mcpRevokeCommand,
  mcpRevokeClientCommand,
  mcpConnectionsCommand,
  mcpDisconnectCommand,
  mcpDeleteConnectionCommand,
  mcpDeleteTokenCommand,
  mcpCleanupCommand,
  mcpAllowChannelCommand,
  mcpAllowCategoryCommand,
  mcpDisallowCategoryCommand,
  mcpDisallowChannelCommand,
  readScopeEnableChannelCommand,
  readScopeEnableCategoryCommand,
  readScopeDisableCategoryCommand,
  readScopeDisableChannelCommand,
  mcpRolePolicyCommand,
  mcpAllowRoleCommand,
  mcpDisallowRoleCommand,
  panelCreateCommand,
  panelEditCommand,

  // Writes that reach Discord. Each queues the unbounded part as a job rather
  // than holding the socket open past the CLI's timeout (ADR 0026).
  panelSyncCommand,
  panelDeleteCommand,
  adoptionAllowCommand,
  undoCommand,
  killswitchCommand,

  // The dashboard's recovery path (ADR 0012). Authorized by the socket like
  // every other command here, which is the point: it exists for the case where
  // nobody can log in, so gating it on a dashboard credential would make it
  // useless in the only situation it is for.
  bootstrapReissueCommand,
  // The ADR 0028 grant path: granting a dashboard account a capability.
  // Authorised by the socket like everything here.
  accountListCommand,
  accountDisableCommand,
  accountEnableCommand,
  accountDeleteCommand,
  accountRevokeCredentialsCommand,
  accountGrantCommand,
  accountGrantGuildCommand,
  accountRevokeGuildCommand,
  accountSetPasswordCommand,
  providerReviewCommand,
];
