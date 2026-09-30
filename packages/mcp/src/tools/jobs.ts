import { z } from 'zod';
import { redactEvidenceText, type GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { safeName, structuredText } from '../structured.js';
import { MCP_READ_GET_JOB, MCP_READ_LIST_JOBS } from '../read-audit.js';
import { registerReadTool, type ReadOutcome, type RegisterContext } from '../register.js';

/**
 * `list_jobs` / `get_job` — the owner's "14 failed jobs" answer. Each job's
 * last error arrives with secrets redacted (`redactEvidenceText`) and framed
 * (`safeName`, so a quoted provider or Discord body cannot forge an envelope
 * marker); the list carries a 500-char preview, the single-job read the full
 * safe text.
 *
 * The port takes the already-resolved `GuildId`, never raw input (hard rule
 * 2). The daemon projects `OpsJobRow` field by field in
 * `apps/daemon/src/mcp/wiring.ts` — this package never sees `OpsPorts`.
 */

export const LIST_JOBS_TOOL_NAME = 'list_jobs';
export const LIST_JOBS_TOOL_DESCRIPTION =
  "Background jobs in one guild, newest first, with each job's last error (secrets redacted). " +
  'status "failed" (default) or "all"; limit 1..100, default 25. ' +
  'Refuses when the guild is unreachable.';

export const GET_JOB_TOOL_NAME = 'get_job';
export const GET_JOB_TOOL_DESCRIPTION =
  'One background job by id with its full last error (secrets redacted). ' +
  'Refuses when the guild is unreachable.';

/** The list preview budget; `get_job` keeps the full redacted text. */
export const JOB_ERROR_PREVIEW_MAX = 500;

/** One job as the daemon projects it — `dedupeKey` stops at that boundary. */
export interface McpJob {
  readonly jobId: number;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: number;
  readonly lastError: string | null;
}

/**
 * The narrow port the jobs tools need. Every method takes the
 * already-resolved `GuildId`. A guild the daemon cannot serve surfaces as a
 * throw, which the tools below turn into the shared refusal, never an
 * exception out of the handler.
 */
export interface McpJobsPort {
  readonly listJobs: (
    guildId: GuildId,
    input: { readonly failedOnly: boolean; readonly limit: number },
  ) => readonly McpJob[];
  readonly findJob: (guildId: GuildId, jobId: number) => McpJob | undefined;
}

const listJobsArgsSchema = z.object({
  guildId: z.string(),
  status: z.enum(['failed', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const getJobArgsSchema = z.object({
  guildId: z.string(),
  jobId: z.number().int().min(1),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements: this documents the wire types for clients while the strict
 * schemas above stay the single boundary.
 */
export const listJobsParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  status: z
    .enum(['failed', 'all'])
    .describe('Which jobs to list: failed only (default) or all.')
    .optional(),
  limit: z.number().describe('Max jobs, default 25, 1..100.').optional(),
};

export const getJobParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  jobId: z.number().describe('The job id from list_jobs.'),
};

const refuse = (): ReadOutcome => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ReadOutcome => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

const previewError = (err: string): string => {
  // Redacted, then framed like every other structured string (ADR 0110 §2):
  // a handler's error can quote a provider or Discord body, so the preview
  // must not carry an envelope marker or an injection phrase unfiltered.
  // Truncation runs after escaping, on the final string.
  const safe = safeName(redactEvidenceText(err).text);
  if (safe.length <= JOB_ERROR_PREVIEW_MAX) return safe;
  return `${safe.slice(0, JOB_ERROR_PREVIEW_MAX)}…`;
};

const fullError = (err: string): string => safeName(redactEvidenceText(err).text);

const listJobsInner = (
  principal: McpPrincipal,
  port: McpJobsPort,
  rawArgs: unknown,
): ReadOutcome => {
  const parsed = listJobsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  // The guild gate: parses the id and refuses malformed and unreachable
  // identically — removing this call answers any guild's jobs.
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const status = parsed.data.status ?? 'failed';
  const limit = parsed.data.limit ?? 25;
  const jobs = port.listJobs(gate.guildId, { failedOnly: status === 'failed', limit });
  const head = `Jobs in guild ${gate.guildId} (${status}): showing ${String(jobs.length)}.`;
  const data = {
    jobs: jobs.map((job) => ({
      id: job.jobId,
      kind: job.kind,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAfter: new Date(job.runAfter).toISOString(),
      lastError: job.lastError === null ? null : previewError(job.lastError),
    })),
  };
  return {
    ok: true,
    text: structuredText(head, data),
    read: {
      kind: 'structural',
      action: MCP_READ_LIST_JOBS,
      guildIds: [gate.guildId],
      resultCount: jobs.length,
    },
  };
};

const getJobInner = (principal: McpPrincipal, port: McpJobsPort, rawArgs: unknown): ReadOutcome => {
  const parsed = getJobArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const found = port.findJob(gate.guildId, parsed.data.jobId);
  if (found === undefined) {
    return {
      ok: true,
      text: structuredText(`Job ${String(parsed.data.jobId)} not found in guild ${gate.guildId}.`, {
        job: null,
      }),
      read: {
        kind: 'structural',
        action: MCP_READ_GET_JOB,
        guildIds: [gate.guildId],
        resultCount: 0,
      },
    };
  }
  const head = `Job ${String(found.jobId)} in guild ${gate.guildId}.`;
  const data = {
    job: {
      id: found.jobId,
      kind: found.kind,
      state: found.state,
      attempts: found.attempts,
      maxAttempts: found.maxAttempts,
      runAfter: new Date(found.runAfter).toISOString(),
      lastError: found.lastError === null ? null : fullError(found.lastError),
    },
  };
  return {
    ok: true,
    text: structuredText(head, data),
    read: {
      kind: 'structural',
      action: MCP_READ_GET_JOB,
      guildIds: [gate.guildId],
      resultCount: 1,
    },
  };
};

/**
 * Never throws: a malformed argument is the argument-fault message, and
 * anything unexpected (a port fault) is the shared refusal rather than an
 * exception out of the handler.
 */
export const listJobsText = (
  principal: McpPrincipal,
  port: McpJobsPort,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return listJobsInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

/** Never throws; see `listJobsText`. */
export const getJobText = (
  principal: McpPrincipal,
  port: McpJobsPort,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return getJobInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

/** Registers both jobs tools through the shared read-tool shape. */
export const registerJobTools = (ctx: RegisterContext, port: McpJobsPort): void => {
  registerReadTool(ctx, LIST_JOBS_TOOL_NAME, LIST_JOBS_TOOL_DESCRIPTION, listJobsParams, (args) =>
    listJobsText(ctx.principal, port, args),
  );
  registerReadTool(ctx, GET_JOB_TOOL_NAME, GET_JOB_TOOL_DESCRIPTION, getJobParams, (args) =>
    getJobText(ctx.principal, port, args),
  );
};
