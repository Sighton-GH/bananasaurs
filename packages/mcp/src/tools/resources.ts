import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { safeName, structuredText } from '../structured.js';
import { envelope } from '../envelope.js';
import { MCP_READ_OPEN_RESOURCE, MCP_READ_SEARCH_RESOURCES } from '../read-audit.js';
import { registerReadTool, type ReadOutcome, type RegisterContext } from '../register.js';

/**
 * `search_resources` / `open_resource` — cache-only reads over the club's
 * curated resource cache (slice 2, Task 2).
 *
 * Both tools see enabled resources only, read the cache only, and never
 * trigger a fetch: the port has no refresh member (`enqueueRefresh` or a
 * fetcher would fail construction here — the object below only names the
 * three reads), so an unfetched resource answers with the dashboard pointer
 * and stops there. Resource text is member- or owner-typed prose, so hits
 * and chunks travel inside `envelope()` (which withholds detector hits —
 * ADR 0110) while the catalogue entries render as compact JSON with
 * `safeName` framing, like every other structured string (ADR 0110 §2).
 *
 * The port takes the already-resolved `GuildId`, never raw input (hard rule
 * 2). The daemon projects the assistant repositories field by field in
 * `apps/daemon/src/mcp/wiring.ts` — this package never sees storage
 * handles.
 */

export const SEARCH_RESOURCES_TOOL_NAME = 'search_resources';
export const SEARCH_RESOURCES_TOOL_DESCRIPTION =
  'Search the cached text of the guild\u2019s enabled club resources by keyword, ' +
  'with the enabled resource list. Cache only: never fetches. ' +
  'Refuses when the guild is unreachable.';

export const OPEN_RESOURCE_TOOL_NAME = 'open_resource';
export const OPEN_RESOURCE_TOOL_DESCRIPTION =
  'Read the first cached chunks of one enabled club resource in outline order. ' +
  'Cache only: never fetches; an unfetched resource says to refresh it in the dashboard. ' +
  'Refuses when the guild is unreachable.';

/** Chunks returned per `open_resource` call; the text budget below binds first. */
export const OPEN_RESOURCE_CHUNK_LIMIT = 10;
/** Total chunk text per `open_resource` answer; the last chunk is cut to fit. */
export const OPEN_RESOURCE_TEXT_MAX = 8000;

/** One enabled club resource as the daemon projects it — plain data, no storage row. */
export interface McpResourceSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly url: string;
}

/** One cached chunk as the daemon projects it — plain data, no storage row. */
export interface McpResourceChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly headingPath: string;
  readonly text: string;
}

/**
 * The narrow port the resource tools need. Every method takes the
 * already-resolved `GuildId`. `listResources` returns enabled resources
 * only; `resourceChunks` returns the first document's chunks in outline
 * order, up to `limit` ([] when not cached). There is deliberately no
 * refresh member: MCP must never enqueue a fetch. A guild the daemon
 * cannot serve surfaces as a throw, which the tools below turn into the
 * shared refusal, never an exception out of the handler.
 */
export interface McpResourcesPort {
  /** Enabled resources only. */
  readonly listResources: (guildId: GuildId) => readonly McpResourceSummary[];
  readonly searchChunks: (
    guildId: GuildId,
    input: { readonly query: string; readonly limit: number },
  ) => readonly McpResourceChunk[];
  /** First document's chunks in outline order, up to `limit`; [] when not cached. */
  readonly resourceChunks: (
    guildId: GuildId,
    resourceId: string,
    limit: number,
  ) => readonly McpResourceChunk[];
}

const searchResourcesArgsSchema = z.object({
  guildId: z.string(),
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});

const openResourceArgsSchema = z.object({
  guildId: z.string(),
  resourceId: z.string().min(1).max(200),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements: these document the wire types for clients while the strict
 * schemas above stay the single boundary.
 */
export const searchResourcesParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  query: z.string().describe('Keyword search over cached resource text, 1..200 chars.'),
  limit: z.number().describe('Max matches, default 8, 1..20.').optional(),
};

export const openResourceParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  resourceId: z.string().describe('The resource id from search_resources.'),
};

const refuse = (): ReadOutcome => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ReadOutcome => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

const summarize = (resource: McpResourceSummary): McpResourceSummary => ({
  id: safeName(resource.id),
  title: safeName(resource.title),
  kind: safeName(resource.kind),
  url: safeName(resource.url),
});

const toEvidenceItem = (chunk: McpResourceChunk): Parameters<typeof envelope>[0][number] => ({
  authorId: chunk.resourceId,
  channelId: chunk.docId,
  messageId: chunk.chunkId,
  timestamp: chunk.headingPath,
  content: chunk.text,
});

const searchResourcesInner = (
  principal: McpPrincipal,
  port: McpResourcesPort,
  rawArgs: unknown,
): ReadOutcome => {
  const parsed = searchResourcesArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  // The guild gate: parses the id and refuses malformed and unreachable
  // identically — removing this call answers any guild's resource cache.
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const limit = parsed.data.limit ?? 8;
  const enabled = port.listResources(gate.guildId);
  const enabledIds = new Set(enabled.map((resource) => resource.id));
  // Belt over braces: the daemon already scopes the search to the enabled
  // ids, but a hit naming a disabled resource must never reach the model
  // even if the port ever returns one.
  const hits = port
    .searchChunks(gate.guildId, { query: parsed.data.query, limit })
    .filter((hit) => enabledIds.has(hit.resourceId));
  const head =
    enabled.length === 0
      ? `No enabled resources in guild ${safeName(gate.guildId)}.`
      : `Resource search in guild ${safeName(gate.guildId)}: ${String(hits.length)} matches across ${String(enabled.length)} enabled resources.`;
  return {
    ok: true,
    text: `${structuredText(head, { resources: enabled.map(summarize) })}\n\n${envelope(hits.map(toEvidenceItem))}`,
    read: {
      kind: 'content',
      action: MCP_READ_SEARCH_RESOURCES,
      guildId: gate.guildId,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: hits.length,
    },
  };
};

/**
 * Cut `chunks` to the text budget in outline order: whole chunks while they
 * fit, then one cut chunk with an ellipsis, then stop. At least the head of
 * the first chunk is always returned, so the answer is never an empty frame
 * for a resource the cache holds.
 */
const fitChunks = (chunks: readonly McpResourceChunk[]): readonly McpResourceChunk[] => {
  const fitted: McpResourceChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const room = OPEN_RESOURCE_TEXT_MAX - used;
    if (room <= 0) break;
    if (chunk.text.length <= room) {
      fitted.push(chunk);
      used += chunk.text.length;
      continue;
    }
    fitted.push({ ...chunk, text: `${chunk.text.slice(0, room - 1)}…` });
    break;
  }
  return fitted;
};

const openResourceInner = (
  principal: McpPrincipal,
  port: McpResourcesPort,
  rawArgs: unknown,
): ReadOutcome => {
  const parsed = openResourceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  // The guild gate, as above: no call answers another guild's cache.
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const found = port
    .listResources(gate.guildId)
    .find((resource) => resource.id === parsed.data.resourceId);
  if (found === undefined) {
    return {
      ok: true,
      text: structuredText(`No enabled resource with id "${safeName(parsed.data.resourceId)}".`, {
        resource: null,
      }),
      read: {
        kind: 'content',
        action: MCP_READ_OPEN_RESOURCE,
        guildId: gate.guildId,
        subjectType: 'resource',
        subjectId: parsed.data.resourceId,
        resultCount: 0,
      },
    };
  }
  // Cache only: when nothing is cached the answer points at the dashboard.
  // There is no port member to enqueue a refresh with, so no code path here
  // can fetch — by construction, not by discipline.
  const cached = port.resourceChunks(gate.guildId, found.id, OPEN_RESOURCE_CHUNK_LIMIT);
  if (cached.length === 0) {
    return {
      ok: true,
      text: structuredText(
        'This resource has not been fetched yet; the owner can refresh it in the dashboard.',
        { resource: summarize(found) },
      ),
      read: {
        kind: 'content',
        action: MCP_READ_OPEN_RESOURCE,
        guildId: gate.guildId,
        subjectType: 'resource',
        subjectId: found.id,
        resultCount: 0,
      },
    };
  }
  // Belt over braces like `search_resources`: the port is asked for at most
  // the limit, but a port that over-returns must not widen the answer.
  const shown = fitChunks(cached.slice(0, OPEN_RESOURCE_CHUNK_LIMIT));
  const head =
    `Resource ${safeName(found.title)} (${safeName(found.id)}) in guild ${safeName(gate.guildId)}: ` +
    `${safeName(found.url)} — showing ${String(shown.length)} chunks.`;
  return {
    ok: true,
    text: `${structuredText(head, { resource: summarize(found) })}\n\n${envelope(shown.map(toEvidenceItem))}`,
    read: {
      kind: 'content',
      action: MCP_READ_OPEN_RESOURCE,
      guildId: gate.guildId,
      subjectType: 'resource',
      subjectId: found.id,
      resultCount: shown.length,
    },
  };
};

/**
 * Never throws: a malformed argument is the argument-fault message, and
 * anything unexpected (a port fault) is the shared refusal rather than an
 * exception out of the handler.
 */
export const searchResourcesText = (
  principal: McpPrincipal,
  port: McpResourcesPort,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return searchResourcesInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

/** Never throws; see `searchResourcesText`. */
export const openResourceText = (
  principal: McpPrincipal,
  port: McpResourcesPort,
  rawArgs: unknown,
): ReadOutcome => {
  try {
    return openResourceInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

/** Registers both resource tools through the shared read-tool shape. */
export const registerResourceTools = (ctx: RegisterContext, port: McpResourcesPort): void => {
  registerReadTool(
    ctx,
    SEARCH_RESOURCES_TOOL_NAME,
    SEARCH_RESOURCES_TOOL_DESCRIPTION,
    searchResourcesParams,
    (args) => searchResourcesText(ctx.principal, port, args),
  );
  registerReadTool(
    ctx,
    OPEN_RESOURCE_TOOL_NAME,
    OPEN_RESOURCE_TOOL_DESCRIPTION,
    openResourceParams,
    (args) => openResourceText(ctx.principal, port, args),
  );
};
