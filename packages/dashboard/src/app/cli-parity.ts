/**
 * The CLI-to-web parity map (owner acceptance standard, 2026-09-20: every
 * operator action and every piece of operator information the CLI has, the
 * dashboard has). `cli-parity.test.ts` generates the command list from
 * OPERATOR_COMMANDS, so a future CLI command that nobody maps here fails the
 * build instead of silently lacking web handling. The prose version with
 * routes lives in `docs/webui-capability-map.md`; keep the two in step.
 */
export type CliParityEntry =
  | { readonly kind: 'covered'; readonly page: string; readonly control: string }
  | { readonly kind: 'exception'; readonly reason: string };

export const CLI_WEB_PARITY: Readonly<Record<string, CliParityEntry>> = {
  status: {
    kind: 'covered',
    page: 'Overview',
    control: 'guild, gateway, jobs, lag, safety and limits cards',
  },
  doctor: {
    kind: 'covered',
    page: 'Doctor',
    control: 'check list plus the public-surface probe button',
  },
  'config get': {
    kind: 'covered',
    page: 'Configuration',
    control: 'process configuration matrix (secrets stay redacted)',
  },
  'panel list': { kind: 'covered', page: 'Reaction roles', control: 'panels table' },
  'panel show': {
    kind: 'covered',
    page: 'Reaction roles',
    control: 'per-panel detail with options and limits',
  },
  'log routing list': {
    kind: 'covered',
    page: 'Logging',
    control: 'route cards',
  },
  'audit tail': { kind: 'covered', page: 'Audit', control: 'audit table, newest first' },
  'jobs list': { kind: 'covered', page: 'Jobs', control: 'queue table with state filters' },
  'backup list': {
    kind: 'covered',
    page: 'Backups',
    control: 'backup table with sizes and checksums',
  },
  'automod review': {
    kind: 'covered',
    page: 'Review',
    control: 'unreviewed matches and native hits with evidence',
  },
  'archive status': {
    kind: 'covered',
    page: 'Archive',
    control: 'per-channel backfill state and counts',
  },
  'archive search': {
    kind: 'covered',
    page: 'Search',
    control: 'query, channel and author filters, per-hit actions',
  },
  'mcp allowlist': { kind: 'covered', page: 'Connector', control: 'allowlisted channels' },
  'mcp sends': {
    kind: 'covered',
    page: 'Connector',
    control: 'recent sends, channels and outcomes only',
  },
  'config set': {
    kind: 'covered',
    page: 'Configuration',
    control: 'safety settings and limits controls, confirmed and audited',
  },
  'automod verdict': { kind: 'covered', page: 'Review', control: 'verdict buttons per match' },
  'automod invite-allow': {
    kind: 'covered',
    page: 'Automod rule',
    control: 'add invite code with label',
  },
  'automod invite-deny': { kind: 'covered', page: 'Automod rule', control: 'remove invite code' },
  'automod domain-add': {
    kind: 'covered',
    page: 'Automod rule',
    control: 'add domain to allow/deny list',
  },
  'automod domain-rm': { kind: 'covered', page: 'Automod rule', control: 'remove domain' },
  'log routing create': {
    kind: 'covered',
    page: 'Logging',
    control: 'New route form',
  },
  'log routing update': {
    kind: 'covered',
    page: 'Logging',
    control: 'Edit route form',
  },
  'log routing on': {
    kind: 'covered',
    page: 'Logging',
    control: 'route On switch',
  },
  'log routing off': {
    kind: 'covered',
    page: 'Logging',
    control: 'route Off switch',
  },
  'log routing delete': {
    kind: 'covered',
    page: 'Logging',
    control: 'route Delete button',
  },
  'log routing exclude': { kind: 'covered', page: 'Permissions', control: 'No access toggle' },
  'log routing unexclude': { kind: 'covered', page: 'Permissions', control: 'No access toggle' },
  'jobs retry': { kind: 'covered', page: 'Jobs', control: 'retry a failed job, confirmed' },
  'backup now': { kind: 'covered', page: 'Backups', control: 'take a backup now, confirmed' },
  'archive enable-channel': {
    kind: 'covered',
    page: 'Archive',
    control: 'enable and backfill a channel',
  },
  'archive disable-channel': {
    kind: 'covered',
    page: 'Archive',
    control: 'stop archiving, rows removed, confirmed',
  },
  'archive preserve': { kind: 'covered', page: 'Archive', control: 'preserve a hit indefinitely' },
  'archive link-case': { kind: 'covered', page: 'Archive', control: 'link a hit to an open case' },
  'archive reindex': { kind: 'covered', page: 'Archive', control: 'rebuild the index, confirmed' },
  'archive enable-category': {
    kind: 'covered',
    page: 'Archive',
    control: 'enable a category; its channels archive dynamically',
  },
  'archive disable-category': {
    kind: 'covered',
    page: 'Archive',
    control: 'remove a category, rows destroyed, confirmed',
  },
  'archive set-threads': {
    kind: 'covered',
    page: 'Archive',
    control: 'per-channel include/exclude threads toggle',
  },
  'archive threads': {
    kind: 'covered',
    page: 'Archive',
    control: 'threads progress column (done/found per channel)',
  },
  'mcp clients': { kind: 'covered', page: 'Connector', control: 'registered OAuth clients' },
  'mcp tokens': { kind: 'covered', page: 'Connector', control: 'token rows, live and revoked' },
  'mcp revoke': {
    kind: 'covered',
    page: 'Connector',
    control: 'revoke one token lineage, confirmed',
  },
  'mcp revoke-client': {
    kind: 'covered',
    page: 'Connector',
    control: 'remove a client and revoke its tokens, confirmed',
  },
  'mcp allow-channel': { kind: 'covered', page: 'Connector', control: 'allow sends to a channel' },
  'mcp disallow-channel': {
    kind: 'covered',
    page: 'Connector',
    control: 'remove a channel from the send allowlist',
  },
  'mcp allow-category': {
    kind: 'covered',
    page: 'Connector',
    control: 'allow sends to every channel under a category',
  },
  'mcp disallow-category': {
    kind: 'covered',
    page: 'Connector',
    control: 'remove a category from the send allowlist',
  },
  'mcp role-policy': {
    kind: 'covered',
    page: 'Connector',
    control: 'role policy modes and the role allowlist',
  },
  'mcp allow-role': {
    kind: 'covered',
    page: 'Connector',
    control: 'allowlist a role for grants or pings, with live refusals',
  },
  'mcp disallow-role': {
    kind: 'covered',
    page: 'Connector',
    control: 'remove a role from the role allowlist',
  },
  'panel sync': {
    kind: 'covered',
    page: 'Reaction roles',
    control: 'publish and reconcile with dry-run preview',
  },
  'panel create': {
    kind: 'covered',
    page: 'Reaction roles',
    control: 'role panel builder — channel, behaviour, options, review, then publish',
  },
  'panel edit': {
    kind: 'exception',
    reason:
      'Release scope keeps the role panel builder create-only: editing a panel definition and deleting a panel stay CLI (and MCP) operations, which share the panel edit / panel delete ops commands and their audit trail. The Reaction roles page links that scope rather than offering an edit control.',
  },
  'panel delete': {
    kind: 'exception',
    reason:
      'Release scope keeps the role panel builder create-only: deleting a panel (its Discord message, then its rows) stays a CLI (and MCP) operation through the panel delete ops command, confirmed and audited. The Reaction roles page links that scope rather than offering a delete control.',
  },
  'adoption allow': {
    kind: 'exception',
    reason:
      'Not yet on the web: no page offers it. The API route POST /api/adoption-allowance exists, and the Self-granted roles page shows the adoption state but cannot grant a batch. Terminal-only until a page offers it.',
  },
  undo: { kind: 'covered', page: 'Audit', control: 'reverse one batch from its audit row' },
  killswitch: {
    kind: 'covered',
    page: 'Safety',
    control: 'stop/resume every side effect, confirmed',
  },
  'account list': {
    kind: 'covered',
    page: 'Accounts',
    control: 'accounts table plus per-guild capability inventory',
  },
  'account disable': {
    kind: 'covered',
    page: 'Accounts',
    control: 'disable with pause-not-rotation scope, confirmed',
  },
  'account enable': { kind: 'covered', page: 'Accounts', control: 're-enable, confirmed' },
  'account delete': {
    kind: 'covered',
    page: 'Accounts',
    control: 'delete with cascade stated, danger-confirmed',
  },
  'account revoke-credentials': {
    kind: 'covered',
    page: 'Accounts',
    control: 'end sessions, tokens and codes, confirmed',
  },
  'account grant': {
    kind: 'covered',
    page: 'Accounts',
    control:
      'per-account capability chips and known-capability grant selector, confirmed and audited',
  },
  'account grant-guild': {
    kind: 'covered',
    page: 'Accounts',
    control: 'grant this guild, confirmed',
  },
  'account revoke-guild': {
    kind: 'covered',
    page: 'Accounts',
    control: 'revoke this guild with self-revoke warning, confirmed',
  },
  'account set-password': {
    kind: 'covered',
    page: 'Accounts',
    control: 'print-once password reset, confirmed',
  },
  'provider review': {
    kind: 'covered',
    page: 'Providers',
    control: 'review a provider, confirmed',
  },
  'bootstrap reissue': {
    kind: 'exception',
    reason:
      'Break-glass recovery: it re-arms the first-account setup page when NO dashboard account exists, a state in which nobody can sign in to reach a web button. Terminal-only by design; the Accounts empty state and lockout-recovery toasts say so.',
  },
};
