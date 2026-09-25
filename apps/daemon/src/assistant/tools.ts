import { z } from 'zod';
import {
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
 * The read-only tools the model may call in its one tool round (ADR 0067).
 * Nothing here writes. Every argument passes a Zod schema before a tool runs,
 * and every result is redacted like other evidence before it goes back to the
 * provider (hard rule 3).
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
   * IDs follow-up rounds may open (ADR 0071): `open_resource` returns its
   * resource id here; every other tool returns none.
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
        const found = ports.resources().find((r) => r.id === resourceId && r.enabled);
        if (found === undefined) return refused(name, 'No enabled resource has that id.');
        const source = { title: found.title, url: found.url };
        if (!['website', 'document', 'repository'].includes(found.kind))
          return {
            ...evidence(name, `${found.title}: ${found.url}`, [source]),
            handles: [found.id],
          };
        const fetched = await ports.fetchResource(found.url);
        if (!fetched.ok)
          return refused(name, `The resource could not be opened (${fetched.code}).`);
        return {
          ...evidence(name, `${found.title}\n${fetched.evidence.text}`, [source]),
          handles: [found.id],
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return refused(
      name,
      name === 'web_search' ? `Web search failed: ${message}` : `The tool failed: ${message}`,
    );
  }
};
