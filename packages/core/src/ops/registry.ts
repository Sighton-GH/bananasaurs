import type { RegisteredCommand } from './dispatch.js';
import {
  archiveDisableChannelCommand,
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
  automodDryRunCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodReadyCommand,
  automodReviewCommand,
  automodSignoffCommand,
  automodVerdictCommand,
} from './commands/automod.js';
import {
  accountDeleteCommand,
  accountDisableCommand,
  accountEnableCommand,
  accountGrantCommand,
  accountListCommand,
  accountRevokeCredentialsCommand,
} from './commands/account.js';
import { providerReviewCommand } from './commands/provider.js';
import { backupListCommand, backupNowCommand } from './commands/backup.js';
import { bootstrapReissueCommand } from './commands/bootstrap.js';
import {
  mcpClientsCommand,
  mcpRevokeClientCommand,
  mcpRevokeCommand,
  mcpTokensCommand,
} from './commands/mcp.js';
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
import {
  configSetCommand,
  jobsRetryCommand,
  logRoutingExcludeCommand,
  logRoutingOffCommand,
  logRoutingSetCommand,
  logRoutingUnexcludeCommand,
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
  automodDryRunCommand,
  automodReviewCommand,
  archiveStatusCommand,
  archiveSearchCommand,

  // Writes. Each needs `--confirm` and each records an audit row; the
  // dispatcher enforces both, so the ordering here is for `--help` only.
  configSetCommand,
  automodVerdictCommand,
  automodReadyCommand,
  automodSignoffCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodDomainAddCommand,
  automodDomainRmCommand,
  logRoutingSetCommand,
  logRoutingOffCommand,
  logRoutingExcludeCommand,
  logRoutingUnexcludeCommand,
  jobsRetryCommand,
  backupNowCommand,
  archiveEnableChannelCommand,
  archiveDisableChannelCommand,
  archivePreserveCommand,
  archiveLinkCaseCommand,
  archiveReindexCommand,
  mcpClientsCommand,
  mcpTokensCommand,
  mcpRevokeCommand,
  mcpRevokeClientCommand,

  // Writes that reach Discord. Each queues the unbounded part as a job rather
  // than holding the socket open past the CLI's timeout (ADR 0026).
  panelSyncCommand,
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
  providerReviewCommand,
];
