import { describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  type McpPrincipal,
} from '../scope.js';
import { MCP_READ_GET_JOB, MCP_READ_LIST_JOBS } from '../read-audit.js';
import {
  getJobText,
  JOB_ERROR_PREVIEW_MAX,
  listJobsText,
  type McpJob,
  type McpJobsPort,
} from './jobs.js';

/**
 * `list_jobs` / `get_job` — the owner's "14 failed jobs" answer: every job's
 * redacted last error, reachable-guild gated like every other guild tool.
 */

const GUILD = parseGuildId('100000000000000001');

const principal: McpPrincipal = {
  accountId: 'a',
  reachableGuilds: [GUILD],
  scopes: ['bananasaurs:read'],
};

const job = (over: Partial<McpJob> = {}): McpJob => ({
  jobId: 7,
  kind: 'reconcile_guild',
  state: 'failed',
  attempts: 5,
  maxAttempts: 5,
  runAfter: 1_700_000_000_000,
  lastError: null,
  ...over,
});

const portWith = (jobs: readonly McpJob[]): McpJobsPort => ({
  listJobs: () => jobs,
  findJob: (guildId, jobId) => jobs.find((j) => j.jobId === jobId),
});

const jsonOf = (text: string): Record<string, unknown> =>
  JSON.parse(text.split('\n')[2] ?? '') as Record<string, unknown>;

const headOf = (text: string): string => text.split('\n')[0] ?? '';

describe('list_jobs / get_job gate', () => {
  it('an unreachable guild is the shared refusal and the port is not called', () => {
    const listJobs = vi.fn((): readonly McpJob[] => []);
    const findJob = vi.fn((): McpJob | undefined => undefined);
    const port: McpJobsPort = { listJobs, findJob };
    expect(listJobsText(principal, port, { guildId: '100000000000000002' })).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(listJobs).not.toHaveBeenCalled();
    expect(getJobText(principal, port, { guildId: '100000000000000002', jobId: 7 })).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(findJob).not.toHaveBeenCalled();
  });

  it('a bogus status and an out-of-range limit are the argument fault', () => {
    const port = portWith([]);
    expect(listJobsText(principal, port, { guildId: GUILD, status: 'bogus' })).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
    expect(listJobsText(principal, port, { guildId: GUILD, limit: 0 })).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
    expect(listJobsText(principal, port, { guildId: GUILD, limit: 101 })).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
  });
});

describe('list_jobs query defaults', () => {
  it('no status means failed-only with limit 25', () => {
    const seen: unknown[] = [];
    const port: McpJobsPort = {
      listJobs: (_guildId, input) => {
        seen.push(input);
        return [];
      },
      findJob: () => undefined,
    };
    const outcome = listJobsText(principal, port, { guildId: GUILD });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ failedOnly: true, limit: 25 }]);
  });

  it('status all with limit 5 passes through', () => {
    const seen: unknown[] = [];
    const port: McpJobsPort = {
      listJobs: (_guildId, input) => {
        seen.push(input);
        return [];
      },
      findJob: () => undefined,
    };
    const outcome = listJobsText(principal, port, {
      guildId: GUILD,
      status: 'all',
      limit: 5,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ failedOnly: false, limit: 5 }]);
  });
});

describe('list_jobs lastError', () => {
  it('redacts secrets in lastError', () => {
    const port = portWith([
      job({ lastError: 'HTTP 401 authorization: Bearer abc.def.ghi' }),
    ]);
    const outcome = listJobsText(principal, port, { guildId: GUILD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toContain('abc.def.ghi');
  });

  it('truncates a 900-char lastError to a 501-char preview ending in …', () => {
    const long = 'e'.repeat(900);
    const port = portWith([job({ lastError: long })]);
    const outcome = listJobsText(principal, port, { guildId: GUILD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = jsonOf(outcome.text);
    const jobs = data['jobs'] as ReadonlyArray<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    const lastError = jobs[0]?.['lastError'];
    expect(typeof lastError).toBe('string');
    expect((lastError as string).length).toBe(JOB_ERROR_PREVIEW_MAX + 1);
    expect(lastError as string).toMatch(/…$/);
  });
});

describe('get_job', () => {
  it('an unknown id is ok with a null job and a not-found head', () => {
    const outcome = getJobText(principal, portWith([]), { guildId: GUILD, jobId: 7 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(headOf(outcome.text)).toBe(`Job 7 not found in guild 100000000000000001.`);
    expect(jsonOf(outcome.text)).toEqual({ job: null });
    expect(outcome.read).toMatchObject({ resultCount: 0 });
  });

  it('a found job renders the full redacted error with an ISO runAfter', () => {
    const long = 'e'.repeat(900);
    const port = portWith([job({ lastError: long })]);
    const outcome = getJobText(principal, port, { guildId: GUILD, jobId: 7 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(headOf(outcome.text)).toBe(`Job 7 in guild 100000000000000001.`);
    const data = jsonOf(outcome.text);
    const found = data['job'] as Record<string, unknown>;
    expect(found).toMatchObject({
      id: 7,
      kind: 'reconcile_guild',
      state: 'failed',
      attempts: 5,
      maxAttempts: 5,
    });
    expect(found['runAfter']).toBe(new Date(1_700_000_000_000).toISOString());
    // Full text, not the list preview: 900 chars, no truncation marker.
    expect(typeof found['lastError']).toBe('string');
    expect((found['lastError'] as string).length).toBe(900);
    expect(found['lastError'] as string).not.toMatch(/…$/);
    expect(outcome.read).toMatchObject({ resultCount: 1 });
  });

  it('redacts secrets in the full error too', () => {
    const port = portWith([job({ lastError: 'HTTP 401 authorization: Bearer abc.def.ghi' })]);
    const outcome = getJobText(principal, port, { guildId: GUILD, jobId: 7 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toContain('abc.def.ghi');
  });
});

describe('jobs read records', () => {
  it('list_jobs records a structural read with the row count', () => {
    const outcome = listJobsText(principal, portWith([job(), job()]), { guildId: GUILD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_LIST_JOBS,
      guildIds: [GUILD],
      resultCount: 2,
    });
  });

  it('get_job records the get-job action', () => {
    const outcome = getJobText(principal, portWith([job()]), { guildId: GUILD, jobId: 7 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.read).toMatchObject({ kind: 'structural', action: MCP_READ_GET_JOB });
  });
});
