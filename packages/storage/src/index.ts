export {
  openDatabase,
  openTestDatabase,
  applyPragmas,
  runMigrations,
  type Db,
  type OpenedDatabase,
} from './db.js';
export { claimDatabaseLock, DatabaseLockedError, type DbLock, type LockInfo } from './lock.js';
export {
  createScopeFactory,
  type AnyScope,
  type GuildPartitionedTable,
  type GuildScope,
  type InstanceScope,
  type ScopeFactory,
} from './scope.js';
export {
  read,
  write,
  readInstance,
  writeInstance,
  ReadonlyError,
  type InstanceTx,
  type WriteTx,
} from './write.js';
export { SnowflakeTypeError } from './columns.js';
export {
  BACKUP_FILENAME_PATTERN,
  listBackups,
  performBackup,
  pruneBackups,
  type BackupListing,
  type BackupOptions,
  type BackupResult,
  type PruneOptions,
  type PrunedBackup,
} from './backup.js';
export * as accountRepo from './repos/accounts.js';
export * as automodRuleRepo from './repos/automod-rules.js';
export * as automodAdminRepo from './repos/automod-admin.js';
export * as archiveRepo from './repos/archive.js';
export * as archiveSearchRepo from './repos/archive-search.js';
export * as automodFixtureRepo from './repos/automod-fixtures.js';
export * as automodRuleListsRepo from './repos/automod-rule-lists.js';
export * as enforcementGateRepo from './repos/enforcement-gate.js';
// The shape the automod subscriber's wiring narrows to `core`'s `AutomodRule`.
// Public so that narrowing can be written as an explicit mapping rather than
// relying on structural assignability (see `automod/wiring.ts`'s `toAutomodRule`).
export type { StoredAutomodRule } from './repos/automod-rules.js';
export * as modCaseRepo from './repos/mod-cases.js';
export * as modMatchReviewRepo from './repos/mod-match-reviews.js';
export * as modPendingRepo from './repos/mod-pending.js';
export * as sessionRepo from './repos/sessions.js';
export * as guildRepo from './repos/guilds.js';
export * as authzRepo from './repos/authz.js';
export { authzStoreFor, isTargetProtected } from './repos/authz.js';
export * as effectRepo from './repos/effects.js';
export * as jobRepo from './repos/jobs.js';
export { jobStoreFor } from './repos/job-store.js';
export * as loggingRepo from './repos/logging.js';
export * as panelRepo from './repos/panels.js';
export * as pipelineRepo from './repos/pipeline.js';
export * as roleRepo from './repos/roles.js';
export * as schema from './schema.js';
