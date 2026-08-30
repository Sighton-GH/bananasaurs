import type { RegisteredCommand } from './dispatch.js';
import { statusCommand } from './commands/status.js';

/**
 * The operator command surface, in one list.
 *
 * `docs/17` §1 is the specification; this is the implementation of it, and the
 * daemon and the CLI both read *this* rather than each keeping their own idea
 * of what commands exist. The CLI can therefore parse a command line, print
 * `--help`, and refuse an unknown command without a round trip, and it cannot
 * drift from what the daemon will actually accept.
 */
export const OPERATOR_COMMANDS: readonly RegisteredCommand[] = [statusCommand];
