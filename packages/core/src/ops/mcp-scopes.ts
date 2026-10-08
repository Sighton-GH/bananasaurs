/**
 * The one source of wording for the connector's OAuth scopes (ADR 0130 §5).
 * The sign-in page, the dashboard Connections card and `mcp connections` all
 * read this map, so the three never describe an approval differently.
 */
export const MCP_SCOPE_INFO: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  'bananasaurs:read': {
    label: 'Read',
    description: 'read messages, members, cases, tasks and settings',
  },
  'bananasaurs:send': {
    label: 'Post',
    description: 'post, edit and schedule messages, threads, forum posts, events and polls',
  },
  'bananasaurs:roles': {
    label: 'Roles',
    description: 'give and remove member roles and manage role panels',
  },
  'bananasaurs:tasks': {
    label: 'Tasks',
    description: 'create and change club tasks (needs the Manage club tasks permission)',
  },
};

/** A scope's short label; an unknown scope is shown as its raw name. */
export const mcpScopeLabel = (scope: string): string => MCP_SCOPE_INFO[scope]?.label ?? scope;
