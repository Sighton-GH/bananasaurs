/** One audit action name per operation, shared by the CLI and the dashboard (ADR 0134). */
export const OPS_AUDIT_ACTIONS = {
  // Kill switch, config and jobs
  killswitchEnabled: 'killswitch.enabled',
  killswitchDisabled: 'killswitch.disabled',
  configSet: 'config.set',
  jobRetried: 'job.retried',
  backupCreated: 'backup.created',
  backupFailed: 'backup.failed',

  // Log routing
  logRouteCreated: 'log_route.created',
  logRouteUpdated: 'log_route.updated',
  logRouteDeleted: 'log_route.deleted',
  logRouteEnabled: 'log_route.enabled',
  logRouteDisabled: 'log_route.disabled',
  logExclusionAdded: 'log_exclusion.added',
  logExclusionRemoved: 'log_exclusion.removed',

  // Panels, read scope and providers
  panelCreated: 'panel.created',
  readScopeAllow: 'read_scope.allow',
  readScopeDisallow: 'read_scope.disallow',
  providerReviewed: 'provider.reviewed',

  // Archive
  archiveChannelEnabled: 'archive.channel_enabled',
  archiveChannelDisabled: 'archive.channel_disabled',
  archiveChannelPaused: 'archive.channel_paused',
  archiveChannelResumed: 'archive.channel_resumed',
  archiveCategoryEnabled: 'archive.category_enabled',
  archiveCategoryDisabled: 'archive.category_disabled',
  archiveCategoryPaused: 'archive.category_paused',
  archiveCategoryResumed: 'archive.category_resumed',
  archiveThreadsSet: 'archive.threads_set',
  archiveMessagePreserved: 'archive.message_preserved',
  archiveMessageLinkedToCase: 'archive.message_linked_to_case',
  archiveIndexRebuilt: 'archive.index_rebuilt',
  archiveBackfillEnqueued: 'archive.backfill_enqueued',

  // Batches and adoption
  batchUndoRequested: 'batch.undo_requested',
  adoptionAllowanceGranted: 'adoption.allowance_granted',

  // MCP send and role policy
  mcpSendChannelAllowed: 'mcp.send_channel.allowed',
  mcpSendChannelDisallowed: 'mcp.send_channel.disallowed',
  mcpSendCategoryAllowed: 'mcp.send_category.allowed',
  mcpSendCategoryDisallowed: 'mcp.send_category.disallowed',
  mcpRolePolicyUpdated: 'mcp.role_policy.updated',
  mcpRoleAllowlistAllowed: 'mcp.role_allowlist.allowed',
  mcpRoleAllowlistDisallowed: 'mcp.role_allowlist.disallowed',
  mcpTokenRevoked: 'mcp.token.revoked',
  mcpTokenDeleted: 'mcp.token.deleted',
  mcpTokensCleaned: 'mcp.tokens.cleaned',
  mcpClientRevoked: 'mcp.client.revoked',
  mcpConnectionRevoked: 'mcp.connection.revoked',
  mcpConnectionDeleted: 'mcp.connection.deleted',

  // Automod allowlists and verdicts
  automodVerdictRecorded: 'automod.verdict_recorded',
  automodInviteAllowlistAdded: 'automod.invite_allowlist_added',
  automodInviteAllowlistRemoved: 'automod.invite_allowlist_removed',
  automodLinkDomainAdded: 'automod.link_domain_added',
  automodLinkDomainRemoved: 'automod.link_domain_removed',

  // Accounts
  accountDisabled: 'account.disabled',
  accountEnabled: 'account.enabled',
  accountDeleted: 'account.deleted',
  accountCredentialsRevoked: 'account.credentials.revoked',
  accountPasswordChanged: 'account.password.changed',
  accountPasswordRevealed: 'account.password.revealed',
  accountGuildGranted: 'account.guild.granted',
  accountGuildRevoked: 'account.guild.revoked',
  accountCapabilityGranted: 'account.capability.granted',
  accountCapabilityRevoked: 'account.capability.revoked',
} as const;

/** Every name in {@link OPS_AUDIT_ACTIONS}. */
export type OpsAuditAction = (typeof OPS_AUDIT_ACTIONS)[keyof typeof OPS_AUDIT_ACTIONS];
