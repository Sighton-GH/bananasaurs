import type { RegisteredCommand } from './dispatch.js';
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

  // Writes. Each needs `--confirm` and each records an audit row; the
  // dispatcher enforces both, so the ordering here is for `--help` only.
  configSetCommand,
  logRoutingSetCommand,
  logRoutingOffCommand,
  logRoutingExcludeCommand,
  logRoutingUnexcludeCommand,
  jobsRetryCommand,
  killswitchCommand,
];
