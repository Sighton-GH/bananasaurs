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
  listRoutes: unstubbed('listRoutes'),
  listExcludedChannels: unstubbed('listExcludedChannels'),
  ...over,
});

export const fakeOpsInstance = (over: Partial<OpsInstance> = {}): OpsInstance => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'development',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  doctor: () => ({ ok: true, text: 'doctor: ok', data: null }),
  redactedConfig: () => ({ BANANASAURS_DRY_RUN: false, DISCORD_BOT_TOKEN: '<redacted>' }),
  ...over,
});

export const FIXTURE_GUILD_ID = parseGuildId('1000000000000000001');

export const fakeOpsGuildContext = (over: Partial<OpsGuildContext> = {}): OpsGuildContext => ({
  guildId: FIXTURE_GUILD_ID,
  now: () => 1_700_000_060_000,
  ports: fakeOpsPorts(),
  ...over,
});
