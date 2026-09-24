import type { Capability } from './authz.js';

/**
 * Plain-language account permissions (ADR 0069, spec A2).
 *
 * The single source of truth for how capabilities read in the dashboard:
 * labels in plain words, capability ids only as secondary text. Copy is
 * Canadian English, taken word for word from the spec's permission table —
 * except the `accounts.manage` row, whose spec cell wraps the trust warning
 * in markdown emphasis (`*High trust …*`); the emphasis is dropped here so
 * the description stays a plain sentence, and the machine-readable marker
 * lives on `highTrust` instead.
 */
export interface CapabilityInfo {
  readonly label: string;
  readonly description: string;
  readonly highTrust?: true;
}

export const CAPABILITY_INFO: Readonly<Record<Capability, CapabilityInfo>> = {
  'config.read': {
    label: 'View settings',
    description: "See this server's settings, rules and assistant setup.",
  },
  'audit.read': {
    label: 'View activity logs',
    description: 'See the audit log and assistant history.',
  },
  'config.write': {
    label: 'Change settings',
    description: 'Edit rules, logging, assistant behaviours, prompts and resources.',
  },
  'panels.manage': {
    label: 'Manage role panels',
    description: 'Create and edit self-assign role panels.',
  },
  'roles.mutate': {
    label: 'Change member roles',
    description: 'Add or remove roles on members.',
  },
  'logging.manage': {
    label: 'Manage logging',
    description: 'Choose which channels log messages, members and roles.',
  },
  'moderation.act': {
    label: 'Moderate members',
    description: 'Time out, kick or ban, and let automod take those actions.',
  },
  'undo.execute': {
    label: 'Undo actions',
    description: 'Reverse a recent Bananasaurs action.',
  },
  'killswitch.toggle': {
    label: 'Emergency stop',
    description: 'Turn all Bananasaurs actions off, or back on.',
  },
  'mcp.authorize': {
    label: 'Connect apps',
    description: 'Approve outside apps (MCP connectors) to read this server.',
  },
  'accounts.manage': {
    label: 'Manage accounts',
    description: 'Add, edit and remove dashboard accounts. High trust — can reset passwords.',
    highTrust: true,
  },
};

export type AccountRoleId = 'viewer' | 'moderator' | 'server-manager' | 'custom';

export interface AccountRole {
  readonly id: Exclude<AccountRoleId, 'custom'>;
  readonly label: string;
  readonly description: string;
  readonly capabilities: readonly Capability[];
}

/**
 * Role presets, Cloudflare-style (spec A2). No preset grants
 * `accounts.manage` or `mcp.authorize`: those stay Custom-only, picked
 * permission by permission. Descriptions are the spec's role sentences.
 */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  {
    id: 'viewer',
    label: 'Viewer',
    description: 'Sees settings, logs and history. Changes nothing.',
    capabilities: ['config.read', 'audit.read'],
  },
  {
    id: 'moderator',
    label: 'Moderator',
    description: 'Viewer, plus moderation actions, undo, and role changes.',
    capabilities: ['config.read', 'audit.read', 'moderation.act', 'undo.execute', 'roles.mutate'],
  },
  {
    id: 'server-manager',
    label: 'Server manager',
    description: 'Everything on this server except managing accounts and connecting apps.',
    capabilities: [
      'roles.mutate',
      'panels.manage',
      'logging.manage',
      'config.read',
      'config.write',
      'audit.read',
      'killswitch.toggle',
      'undo.execute',
      'moderation.act',
    ],
  },
];

/**
 * Maps a capability set back to its preset, or `'custom'` when the set
 * matches no preset. Order-free: `['audit.read', 'config.read']` is the
 * viewer, whichever way the checkboxes were ticked.
 */
export const roleForCapabilities = (caps: readonly Capability[]): AccountRoleId => {
  const key = [...new Set(caps)].sort().join('\0');
  for (const role of ACCOUNT_ROLES) {
    if ([...role.capabilities].sort().join('\0') === key) return role.id;
  }
  return 'custom';
};
