import { z } from 'zod';
import {
  humaniseDuration,
  redactEvidenceText,
  scanOutboundRequest,
  TOOL_CATALOGUE,
  type ClubResource,
  type Reminder,
  type ToolCall,
  type ToolDeclaration,
} from '@bananasaurs/core';
import type { ResourceFetchResult } from './resource-fetcher.js';

/**
 * The read-only tools the model may call (ADR 0067, Task 16).
 * Cache tools read the persistent resource cache through guild-scoped ports;
 * nothing here writes except `refresh_source`/`open_resource`'s refresh
 * request, which enqueues a job. Every argument passes a Zod schema before a
 * tool runs, and every result is redacted like other evidence before it goes
 * back to the provider (hard rule 3).
 */

export interface ArchiveHit {
  readonly channelId: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly excerpt: string;
}

export interface WebResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

export interface CacheSearchHit {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly headingPath: string;
  readonly snippet: string;
}

export interface CacheStoredChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly headingPath: string;
  readonly text: string;
}

export interface CacheOutlineEntry {
  readonly chunkId: string;
  readonly headingPath: string;
}

export interface CacheStoredDoc {
  readonly docId: string;
  readonly resourceId: string;
  readonly title: string;
  readonly url: string;
}

/** Everything a tool can reach, already scoped to one guild and one asking member. */
export interface AssistantToolPorts {
  readonly userId: string;
  readonly now: () => number;
  readonly timeZone: string;
  /** Archive-enabled channels the member can view; the port enforces that. */
  readonly searchArchive: (query: string) => Promise<readonly ArchiveHit[]>;
  readonly resources: () => readonly ClubResource[];
  readonly fetchResource: (url: string) => Promise<ResourceFetchResult>;
  /** Absent while web search is off (ADR 0066). */
  readonly webSearch?: ((query: string) => Promise<readonly WebResult[]>) | undefined;
  readonly serverCard: () => string;
  readonly visibleChannels: () => Promise<readonly { id: string; name: string }[]>;
  readonly reminders: () => readonly Reminder[];
  /** Guild-scoped cache reads (hard rule 2: the closures capture the request scope). */
  readonly cacheSearch: (input: {
    readonly query: string;
    readonly resourceIds?: readonly string[];
    readonly limit: number;
  }) => readonly CacheSearchHit[];
  readonly cacheChunk: (chunkId: string) => CacheStoredChunk | undefined;
  readonly cacheNeighbours: (chunkId: string, n: 0 | 1 | 2) => readonly CacheStoredChunk[];
  readonly cacheOutline: (docId: string) => readonly CacheOutlineEntry[];
  readonly cacheDocument: (docId: string) => CacheStoredDoc | undefined;
  readonly cacheResourceDocs: (resourceId: string) => readonly CacheStoredDoc[];
  readonly cacheResourceChunks: (docId: string, limit: number) => readonly CacheStoredChunk[];
  readonly cacheFreshness: () => readonly {
    readonly resourceId: string;
    readonly fetchedAt?: number;
  }[];
  /** Enqueues a resource_refresh (reason assistant); false when the 10-minute dedupe already holds one. */
  readonly enqueueRefresh: (resourceId: string) => boolean;
}

export interface ToolSource {
  readonly title: string;
  readonly url: string;
}

export interface AssistantToolResult {
  readonly name: string;
  readonly ok: boolean;
  /** What goes back to the model: redacted, untrusted evidence. */
  readonly text: string;
  readonly sources: readonly ToolSource[];
  /** True when the result came from Brave (the answer must say so). */
  readonly web?: boolean;
  /**
   * IDs follow-up rounds may open (ADR 0071): cache tools return the ids
   * they actually showed; every other tool returns none.
   */
  readonly handles?: readonly string[];
}

const query = z.object({ query: z.string().trim().min(1).max(200) }).strict();
const none = z.object({}).strict();
const schemas = {
  search_archive: query,
  open_resource: z.object({ resourceId: z.string().min(1).max(64) }).strict(),
  web_search: query,
  server_info: none,
  current_time: none,
  my_reminders: none,
  list_sources: z.object({ filter: z.string().trim().min(1).max(80).optional() }).strict(),
  search_sources: z
    .object({
      query: z.string().trim().min(2).max(200),
      sourceIds: z.array(z.string().min(1).max(64)).max(10).optional(),
    })
    .strict(),
  read_chunk: z
    .object({
      chunkId: z.string().min(1).max(128),
      neighbours: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
  outline: z.object({ docId: z.string().min(1).max(128) }).strict(),
  refresh_source: z.object({ resourceId: z.string().min(1).max(64) }).strict(),
} as const;
type ToolName = keyof typeof schemas;

/**
 * Declarations for the live provider request, derived from `TOOL_CATALOGUE`
 * (`@bananasaurs/core`) so a declaration's name, description and parameters
 * can never drift from what the skill detail page shows (a test asserts
 * every entry here equals its catalogue entry). `web_search` is the one
 * conditional entry: it drops out entirely while search is off (ADR 0066).
 */
export const toolDeclarations = (ports: AssistantToolPorts): ToolDeclaration[] =>
  TOOL_CATALOGUE.filter(
    (entry) => entry.name !== 'web_search' || ports.webSearch !== undefined,
  ).map((entry) => ({
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
  }));

const MAX_RESULT_CHARS = 6_000;
const evidence = (
  name: string,
  text: string,
  sources: readonly ToolSource[] = [],
): AssistantToolResult => ({
  name,
  ok: true,
  text: redactEvidenceText(text.slice(0, MAX_RESULT_CHARS)).text,
  sources,
});
const refused = (name: string, text: string): AssistantToolResult => ({
  name,
  ok: false,
  text,
  sources: [],
});

const clock = (ports: AssistantToolPorts, at: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ports.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(at);

const relativeUpdated = (ports: AssistantToolPorts, fetchedAt: number | undefined): string =>
  fetchedAt === undefined
    ? 'not fetched yet'
    : `${humaniseDuration(Math.max(0, ports.now() - fetchedAt))} ago`;

const enabledById = (ports: AssistantToolPorts, resourceId: string): ClubResource | undefined =>
  ports.resources().find((r) => r.id === resourceId && r.enabled);

export const runAssistantTool = async (
  call: ToolCall,
  ports: AssistantToolPorts,
): Promise<AssistantToolResult> => {
  if (!(call.name in schemas)) return refused(call.name, 'Unknown tool.');
  const name = call.name as ToolName;
  const parsed = schemas[name].safeParse(call.args ?? {});
  if (!parsed.success) return refused(name, 'The tool arguments were not valid.');

  try {
    switch (name) {
      case 'search_archive': {
        const { query: q } = parsed.data as z.infer<typeof query>;
        const hits = await ports.searchArchive(q);
        if (hits.length === 0) return evidence(name, 'No matching messages.');
        return evidence(
          name,
          hits
            .map(
              (hit) =>
                `<#${hit.channelId}> ${new Date(hit.createdAt).toISOString().slice(0, 10)}: ${hit.excerpt}`,
            )
            .join('\n'),
        );
      }
      case 'open_resource': {
        const { resourceId } = parsed.data as { resourceId: string };
        const found = enabledById(ports, resourceId);
        if (found === undefined) return refused(name, 'unknown id');
        const source = { title: found.title, url: found.url };
        if (!['website', 'document', 'repository', 'note'].includes(found.kind))
          return {
            ...evidence(name, `${found.title}: ${found.url}`, [source]),
            handles: [found.id],
          };
        const docs = ports.cacheResourceDocs(found.id);
        const doc = docs[0];
        if (doc === undefined) {
          ports.enqueueRefresh(found.id);
          return {
            ...evidence(
              name,
              "This source hasn't been fetched yet; an update has been requested.",
              [source],
            ),
            handles: [found.id],
          };
        }
        const chunks = ports.cacheResourceChunks(doc.docId, 10);
        if (chunks.length === 0) {
          ports.enqueueRefresh(found.id);
          return {
            ...evidence(
              name,
              "This source hasn't been fetched yet; an update has been requested.",
              [source],
            ),
            handles: [found.id],
          };
        }
        const head = `${found.title}\n${doc.url}\n`;
        const lines: string[] = [];
        let used = head.length;
        const shown: string[] = [];
        for (const chunk of chunks) {
          const line = `[${chunk.chunkId}] ${chunk.headingPath}: ${chunk.text}`;
          if (used + line.length + 1 > 4_000) break;
          lines.push(line);
          shown.push(chunk.chunkId);
          used += line.length + 1;
        }
        if (lines.length === 0) {
          const first = chunks[0]!;
          const room = Math.max(
            0,
            4_000 - head.length - `[${first.chunkId}] ${first.headingPath}: `.length - 1,
          );
          lines.push(`[${first.chunkId}] ${first.headingPath}: ${first.text.slice(0, room)}`);
          shown.push(first.chunkId);
        }
        return {
          ...evidence(name, `${head}${lines.join('\n')}`.slice(0, 4_000), [source]),
          handles: [...shown, doc.docId],
        };
      }
      case 'web_search': {
        const { query: q } = parsed.data as z.infer<typeof query>;
        if (ports.webSearch === undefined) return refused(name, 'Web search is off.');
        // The query leaves for Brave: the same local scan as member input.
        if (
          !scanOutboundRequest({ model: 'web-search', messages: [{ role: 'user', text: q }] }).safe
        )
          return refused(name, 'The query looked like it contained personal data or a secret.');
        const results = await ports.webSearch(q);
        if (results.length === 0) return { ...evidence(name, 'No web results.'), web: true };
        return {
          ...evidence(
            name,
            results.map((r) => `${r.title} (${r.url})\n${r.description}`).join('\n\n'),
            results.map((r) => ({ title: r.title, url: r.url })),
          ),
          web: true,
        };
      }
      case 'server_info': {
        const channels = await ports.visibleChannels();
        return evidence(
          name,
          `${ports.serverCard()}\n\nChannels:\n${channels.map((c) => `#${c.name} <#${c.id}>`).join('\n')}`,
        );
      }
      case 'current_time':
        return evidence(name, `${clock(ports, ports.now())} (${ports.timeZone})`);
      case 'my_reminders': {
        const mine = ports
          .reminders()
          .filter(
            (r) =>
              r.creatorId === ports.userId && r.status === 'scheduled' && r.dueAt >= ports.now(),
          );
        if (mine.length === 0) return evidence(name, 'No upcoming reminders.');
        return evidence(name, mine.map((r) => `${clock(ports, r.dueAt)}: ${r.text}`).join('\n'));
      }
      case 'list_sources': {
        const { filter } = parsed.data as { filter?: string };
        const freshness = new Map(ports.cacheFreshness().map((f) => [f.resourceId, f.fetchedAt]));
        const needle = filter?.toLowerCase();
        const all = ports.resources().filter((r) => r.enabled);
        const matching =
          needle === undefined
            ? all
            : all.filter(
                (r) =>
                  r.id.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle),
              );
        const lines = matching
          .slice(0, 30)
          .map(
            (r) =>
              `${r.id} · ${r.title} (${r.kind}) · updated ${relativeUpdated(ports, freshness.get(r.id))}`,
          );
        if (lines.length === 0) return evidence(name, 'No sources match that filter.');
        return {
          ...evidence(name, lines.join('\n')),
          handles: matching.slice(0, 30).map((r) => r.id),
        };
      }
      case 'search_sources': {
        const { query: q, sourceIds } = parsed.data as {
          query: string;
          sourceIds?: string[];
        };
        if (sourceIds !== undefined) {
          const known = new Set(
            ports
              .resources()
              .filter((r) => r.enabled)
              .map((r) => r.id),
          );
          for (const id of sourceIds) {
            if (!known.has(id)) return refused(name, 'unknown id');
          }
        }
        const hits = ports.cacheSearch({ query: q, resourceIds: sourceIds, limit: 6 });
        if (hits.length === 0)
          return evidence(name, 'No matching passages. Try different words, or list_sources.');
        const byId = new Map(ports.resources().map((r) => [r.id, r]));
        const lines: string[] = [];
        const handles: string[] = [];
        let used = 0;
        for (const hit of hits.slice(0, 6)) {
          const title = byId.get(hit.resourceId)?.title ?? hit.resourceId;
          const snippet = hit.snippet.length > 300 ? `${hit.snippet.slice(0, 299)}…` : hit.snippet;
          const line = `[${hit.chunkId}] ${title} › ${hit.headingPath}: ${snippet}`;
          if (used + line.length + (lines.length > 0 ? 1 : 0) > 2_000) break;
          lines.push(line);
          handles.push(hit.chunkId, hit.docId);
          used += line.length + (lines.length > 1 ? 1 : 0);
        }
        if (lines.length === 0)
          return evidence(name, 'No matching passages. Try different words, or list_sources.');
        return { ...evidence(name, lines.join('\n')), handles };
      }
      case 'read_chunk': {
        const { chunkId, neighbours } = parsed.data as {
          chunkId: string;
          neighbours?: 0 | 1 | 2;
        };
        const center = ports.cacheChunk(chunkId);
        if (center === undefined) return refused(name, 'unknown id');
        const rows = ports.cacheNeighbours(chunkId, neighbours ?? 1);
        const shown = rows.length > 0 ? rows : [center];
        const found = enabledById(ports, center.resourceId);
        const title = found?.title ?? center.resourceId;
        const url = found?.url ?? '';
        const sourceList = found === undefined ? [] : [{ title: found.title, url: found.url }];
        const head =
          url === ''
            ? `${title} › ${center.headingPath}\n`
            : `${title} › ${center.headingPath}\n${url}\n`;
        let used = head.length;
        const lines: string[] = [];
        const handles: string[] = [];
        for (const row of shown) {
          const line = `[${row.chunkId}] ${row.text}`;
          if (used + line.length + 1 > 4_000) break;
          lines.push(line);
          handles.push(row.chunkId);
          used += line.length + 1;
        }
        if (lines.length === 0) {
          const first = shown[0] ?? center;
          const room = Math.max(0, 4_000 - head.length - `[${first.chunkId}] `.length - 1);
          lines.push(`[${first.chunkId}] ${first.text.slice(0, room)}`);
          handles.push(first.chunkId);
        }
        handles.push(center.docId);
        return {
          ...evidence(name, `${head}${lines.join('\n\n')}`.slice(0, 4_000), sourceList),
          handles,
        };
      }
      case 'outline': {
        const { docId } = parsed.data as { docId: string };
        const rows = ports.cacheOutline(docId);
        if (rows.length === 0) {
          const doc = ports.cacheDocument(docId);
          if (doc === undefined) return refused(name, 'unknown id');
          return { ...evidence(name, 'No headings cached.'), handles: [] };
        }
        const lines: string[] = [];
        const handles: string[] = [];
        let used = 0;
        for (const row of rows) {
          const line = `[${row.chunkId}] ${row.headingPath}`;
          if (used + line.length + 1 > 1_500) break;
          lines.push(line);
          handles.push(row.chunkId);
          used += line.length + 1;
        }
        return { ...evidence(name, lines.join('\n')), handles };
      }
      case 'refresh_source': {
        const { resourceId } = parsed.data as { resourceId: string };
        const found = enabledById(ports, resourceId);
        if (found === undefined) return refused(name, 'unknown id');
        const enqueued = ports.enqueueRefresh(found.id);
        return evidence(
          name,
          enqueued
            ? 'Refresh started; updated content will be available in about a minute.'
            : 'Already refreshed in the last 10 minutes.',
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return refused(
      name,
      name === 'web_search' ? `Web search failed: ${message}` : `The tool failed: ${message}`,
    );
  }
};
