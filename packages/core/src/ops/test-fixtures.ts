import { parseGuildId } from '../ids.js';
import type { OpsGuildContext } from './dispatch.js';
import type { OpsInstance, OpsPorts } from './ports.js';

/**
 * Fakes for the operator surface's two port interfaces.
 *
 * A module rather than a helper copied into each test file, following the
 * precedent `packages/storage/src/test-support.ts` set: `OpsPorts` grows every
 * slice, and a fake duplicated across five test files is five places to update
 * and four places to forget. It is deliberately **not** re-exported from
 * `packages/core/src/index.ts`, so nothing outside this package's own tests can
 * reach it.
 *
 * Every method throws by default. A test that reaches a port it did not
 * stub should fail loudly at that line rather than quietly read a zero —
 * `docs/20`'s "a green test suite is not evidence" applies to fakes first.
 */

const unstubbed = (name: string) => (): never => {
  throw new Error(`OpsPorts.${name} was called but this test did not stub it`);
};

export const fakeOpsPorts = (over: Partial<OpsPorts> = {}): OpsPorts => ({
  guildName: unstubbed('guildName'),
  safetyState: unstubbed('safetyState'),
  jobCounts: unstubbed('jobCounts'),
  oldestDueJobAtMs: unstubbed('oldestDueJobAtMs'),
  recordAudit: unstubbed('recordAudit'),
  setKillswitch: unstubbed('setKillswitch'),
  tailAudit: unstubbed('tailAudit'),
  listJobs: unstubbed('listJobs'),
  listPanels: unstubbed('listPanels'),
  findPanel: unstubbed('findPanel'),
  listUnassignableRoles: unstubbed('listUnassignableRoles'),
  listKeywordFilterRulesMissingManageMessages: unstubbed(
    'listKeywordFilterRulesMissingManageMessages',
  ),
  listUnusableAutomodRules: unstubbed('listUnusableAutomodRules'),
  listAutomodRulesEnforcingWithBadCutoverState: unstubbed(
    'listAutomodRulesEnforcingWithBadCutoverState',
  ),
  listAutomodRulesObservingPastWindowWithBacklog: unstubbed(
    'listAutomodRulesObservingPastWindowWithBacklog',
  ),
  listRoutes: unstubbed('listRoutes'),
  listExcludedChannels: unstubbed('listExcludedChannels'),
  findJob: unstubbed('findJob'),
  findAutomodRule: unstubbed('findAutomodRule'),
  listAutomodFixtures: unstubbed('listAutomodFixtures'),
  listUnreviewedMatches: unstubbed('listUnreviewedMatches'),
  listUnreviewedNativeHits: unstubbed('listUnreviewedNativeHits'),
  nativeBlockedCount: unstubbed('nativeBlockedCount'),
  listAutomodRules: unstubbed('listAutomodRules'),
  findAutomodRuleDetail: unstubbed('findAutomodRuleDetail'),
  createAutomodRule: unstubbed('createAutomodRule'),
  setAutomodRuleConfig: unstubbed('setAutomodRuleConfig'),
  setAutomodRuleMode: unstubbed('setAutomodRuleMode'),
  addAutomodExemption: unstubbed('addAutomodExemption'),
  addAutomodAllowlistPhrase: unstubbed('addAutomodAllowlistPhrase'),
  removeAutomodExemption: unstubbed('removeAutomodExemption'),
  runAutomodDryRun: unstubbed('runAutomodDryRun'),
  listRecentCases: unstubbed('listRecentCases'),
  findCaseDetail: unstubbed('findCaseDetail'),
  listCasesForMember: unstubbed('listCasesForMember'),
  applySetting: unstubbed('applySetting'),
  recordMatchVerdict: unstubbed('recordMatchVerdict'),
  setAutomodRuleReady: unstubbed('setAutomodRuleReady'),
  recordAutomodSignOff: unstubbed('recordAutomodSignOff'),
  addInviteAllowlistEntry: unstubbed('addInviteAllowlistEntry'),
  listInviteAllowlist: unstubbed('listInviteAllowlist'),
  removeInviteAllowlistEntry: unstubbed('removeInviteAllowlistEntry'),
  addLinkDomain: unstubbed('addLinkDomain'),
  listLinkDomains: unstubbed('listLinkDomains'),
  removeLinkDomain: unstubbed('removeLinkDomain'),
  setRoute: unstubbed('setRoute'),
  setRouteEnabled: unstubbed('setRouteEnabled'),
  excludeChannel: unstubbed('excludeChannel'),
  unexcludeChannel: unstubbed('unexcludeChannel'),
  retryJob: unstubbed('retryJob'),
  publishPanel: unstubbed('publishPanel'),
  enqueueReconcile: unstubbed('enqueueReconcile'),
  findBatch: unstubbed('findBatch'),
  countUndoable: unstubbed('countUndoable'),
  enqueueUndo: unstubbed('enqueueUndo'),
  grantAdoptionAllowance: unstubbed('grantAdoptionAllowance'),
  adoptionAllowance: unstubbed('adoptionAllowance'),
  archiveEnableChannel: unstubbed('archiveEnableChannel'),
  archiveDisableChannel: unstubbed('archiveDisableChannel'),
  archiveStatus: unstubbed('archiveStatus'),
  archivePreserve: unstubbed('archivePreserve'),
  archiveLinkCase: unstubbed('archiveLinkCase'),
  enqueueArchiveBackfill: unstubbed('enqueueArchiveBackfill'),
  listUnreadableArchiveChannels: unstubbed('listUnreadableArchiveChannels'),
  archiveSearch: unstubbed('archiveSearch'),
  archiveReindex: unstubbed('archiveReindex'),
  ...over,
});

export const fakeOpsInstance = (over: Partial<OpsInstance> = {}): OpsInstance => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'development',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  doctor: () => ({ ok: true, text: 'doctor: ok', data: null }),
  redactedConfig: () => ({ BANANASAURS_DRY_RUN: false, DISCORD_BOT_TOKEN: '<redacted>' }),
  // Refuses by default, which is the state a provisioned instance is in. A
  // test that wants the token has to say so, so `bootstrap reissue` succeeding
  // is never something a fixture arranged by accident.
  reissueBootstrapToken: () => ({ ok: false, reason: 'accounts-exist', accountCount: 1 }),
  backupNow: unstubbed('backupNow'),
  backupList: unstubbed('backupList'),
  ...over,
});

export const FIXTURE_GUILD_ID = parseGuildId('1000000000000000001');

export const fakeOpsGuildContext = (over: Partial<OpsGuildContext> = {}): OpsGuildContext => ({
  guildId: FIXTURE_GUILD_ID,
  now: () => 1_700_000_060_000,
  ports: fakeOpsPorts(),
  ...over,
});
