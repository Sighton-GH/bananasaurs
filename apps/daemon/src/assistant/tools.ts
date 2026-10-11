import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  clipHeading,
  humaniseDuration,
  neutraliseMarkers,
  redactEvidenceText,
  relativeAgo,
  reminderRecurrence,
  scanOutboundRequest,
  TOOL_CATALOGUE,
  utcForLocal,
  validateReminderDraft,
  type ClubResource,
  type Reminder,
  type ReminderMentions,
  type ReminderRecurrence,
  type ToolCall,
  type ToolDeclaration,
} from '@bananasaurs/core';
import type { assistantRepo } from '@bananasaurs/storage';
import type {
  ReminderTargetRequest,
  ReminderTargetResult,
  ResolvedReminderTargets,
} from './reminder-targets.js';
import { describeRecurrence, reminderSummary } from './reminder-summary.js';
import type { ResourceFetchResult } from './resource-fetcher.js';
import type { CitationRegistry } from './citations.js';
import {
  WebSearchLimitError,
  SearchHttpError,
  type WebSearchOutcome,
  type WebSearchRun,
} from './web-search.js';

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

/**
 * What a `search_archive` read returns (ADR 0090 decision 3): either the
 * hits, or a member-facing refusal when `from` could not be resolved to one
 * member. The tool answers the problem text verbatim.
 */
export type ArchiveResult =
  | { readonly ok: true; readonly hits: readonly ArchiveHit[] }
  | { readonly ok: false; readonly problem: string };

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

/**
 * One recalled conversation summary (ADR 0093): the display fields the tool
 * formats, plus the conversation id the invoke job links with kind
 * `recalled`. The service cleans every string before returning (hard rule 3).
 */
export interface ConversationRecallHit {
  readonly conversationId: string;
  readonly channelId: string;
  readonly lastActivityAt: number;
  readonly topic: string;
  readonly facts: readonly string[];
}

type StoredReminder = assistantRepo.StoredReminder;
/**
 * The patch `updateReminder` takes. Re-declared structurally here:
 * `packages/storage` does not export a named patch type, only the inline
 * parameter of `updateReminder`.
 */
export interface ReminderPatch {
  readonly text?: string;
  readonly context?: string;
  readonly dueAt?: number;
  readonly destinationId?: string;
  readonly mentions?: ReminderMentions;
  readonly recurrence?: ReminderRecurrence | null;
}

/** Everything a tool can reach, already scoped to one guild and one asking member. */
export interface AssistantToolPorts {
  readonly userId: string;
  /** The guild the archive links point at (`search_archive` builds them). */
  readonly guildId: string;
  readonly now: () => number;
  readonly timeZone: string;
  readonly isOwner: boolean;
  /** True when the behaviour allows the skill and the asker passes its scope (B2b computes it). */
  readonly skillAllowed: (skillId: string) => boolean;
  /** The request quotes another message (ADR 0086 decision 3). */
  readonly quotePresent: boolean;
  /** Stable per invocation (the Discord message id); idempotency keys derive from it. */
  readonly invocationKey: string;
  readonly currentChannelId: string | undefined;
  readonly resolveReminderTargets: (
    request: Omit<ReminderTargetRequest, 'askerId' | 'currentChannelId'>,
  ) => Promise<ReminderTargetResult>;
  readonly reminderStore: {
    /** Guild scope stays out of the tool: B2b's closure adds `scope.guildId`. */
    insert(reminder: Omit<Reminder, 'guildId'>): 'created' | 'duplicate';
    get(id: string): StoredReminder | undefined;
    update(id: string, patch: ReminderPatch): 'updated' | 'not-found' | 'not-editable';
    cancel(id: string): boolean;
    listForCreator(creatorId: string): readonly StoredReminder[];
    listAll(): readonly StoredReminder[];
  };
  readonly proposeDraft: (input: {
    id: string;
    kind: 'memory' | 'decision' | 'review-plan';
    summary: string;
  }) => 'created' | 'duplicate';
  readonly recordSkillActivity: (
    skillId: string,
    outcome: 'completed' | 'denied' | 'failed',
    detail?: string,
  ) => void;
  /** Archive-enabled channels the member can view; the port enforces that. */
  readonly searchArchive: (query: string, from?: string) => Promise<ArchiveResult>;
  readonly resources: () => readonly ClubResource[];
  readonly fetchResource: (url: string) => Promise<ResourceFetchResult>;
  /** Absent while web search is off (ADR 0066). */
  readonly webSearch?: WebSearchRun | undefined;
  readonly serverCard: () => string;
  readonly visibleChannels: () => Promise<readonly { id: string; name: string }[]>;
  /**
   * ADR 0092 decision 1: the next schedule rows, already audience-filtered
   * and cleaned by the service. Absent when the schedule cannot be read —
   * then `upcoming_events` stays undeclared, like `web_search` while off.
   */
  readonly upcomingEvents?: (() => Promise<readonly UpcomingEventItem[]>) | undefined;
  /**
   * ADR 0092 decision 2: one page further back in the current channel.
   * Absent outside a channel or when the context window is off — then
   * `channel_history` stays undeclared.
   */
  readonly channelHistory?:
    | ((opts: { before?: string; limit: number }) => Promise<ChannelHistoryPage | undefined>)
    | undefined;
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
  /**
   * Summaries of earlier conversations the asker may be shown (ADR 0093).
   * The service scopes it to the answer channel's audience intersected with
   * the asker's channels and excludes the current conversation. Absent, the
   * tool is not declared.
   */
  readonly searchConversations?:
    ((query: string) => Promise<readonly ConversationRecallHit[]>) | undefined;
}

export interface ToolSource {
  readonly title: string;
  readonly url: string;
}

/**
 * One `upcoming_events` row (ADR 0092 decision 1): a Discord scheduled event
 * or a channel reminder. `description` is set for events only.
 */
export interface UpcomingEventItem {
  readonly kind: 'event' | 'reminder';
  readonly title: string;
  readonly startsAt: number;
  readonly where: string;
  readonly description?: string | undefined;
}

/** One `channel_history` page (ADR 0092 decision 2). */
export interface ChannelHistoryPage {
  readonly lines: readonly string[];
  readonly oldestId?: string | undefined;
}

export interface AssistantToolResult {
  readonly name: string;
  readonly ok: boolean;
  /** What goes back to the model: redacted, untrusted evidence. */
  readonly text: string;
  readonly sources: readonly ToolSource[];
  /** ADR 0120: which search source produced this result; 'brave' means the answer must say "Powered by Brave Search". */
  readonly webSource?: 'brave' | 'tavily';
  /**
   * IDs follow-up rounds may open (ADR 0071): cache tools return the ids
   * they actually showed; every other tool returns none.
   */
  readonly handles?: readonly string[];
  /**
   * ADR 0093: the conversations whose summaries this result looked back at.
   * The service collects these into the trace detail so the invoke job can
   * link them with kind `recalled`.
   */
  readonly recalledConversationIds?: readonly string[];
  /** Code-written confirmation the reply ends with (B2b appends it verbatim). */
  readonly actionSummary?: string;
}

const query = z.object({ query: z.string().trim().min(1).max(200) }).strict();
const none = z.object({}).strict();
const reminderText = z.string().trim().min(1).max(1500);
const reminderContext = z.string().max(300).optional();
const reminderChannel = z.string().min(1).max(128).optional();
const reminderMembers = z.array(z.string().min(1).max(128)).max(25).optional();
const reminderRoles = z.array(z.string().min(1).max(128)).max(10).optional();
const repeatPattern = z
  .object({
    kind: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    everyWeeks: z.number().int().min(1).max(12).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    until: z.string().min(1).max(64).optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .optional();
const schemas = {
  search_archive: z
    .object({
      query: z.string().trim().min(1).max(200),
      from: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  open_resource: z
    .object({
      resourceId: z.string().min(1).max(64).optional(),
      docId: z.string().min(1).max(128).optional(),
    })
    .strict()
    .refine((v) => (v.resourceId === undefined) !== (v.docId === undefined), {
      message: 'Give either resourceId or docId.',
    }),
  web_search: query,
  server_info: none,
  current_time: none,
  my_reminders: z.object({ all: z.boolean().optional() }).strict(),
  set_reminder: z
    .object({
      text: reminderText,
      when: z.string().min(1).max(64),
      context: reminderContext,
      channel: reminderChannel,
      members: reminderMembers,
      roles: reminderRoles,
      repeat: repeatPattern,
    })
    .strict(),
  edit_reminder: z
    .object({
      reminderId: z.string().min(1).max(128),
      text: reminderText.optional(),
      when: z.string().min(1).max(64).optional(),
      context: reminderContext,
      channel: reminderChannel,
      members: reminderMembers,
      roles: reminderRoles,
      repeat: repeatPattern,
      stopRepeating: z.boolean().optional(),
    })
    .strict(),
  cancel_reminder: z.object({ reminderId: z.string().min(1).max(128) }).strict(),
  propose_memory: z
    .object({
      content: z.string().trim().min(1).max(1000),
      section: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  propose_decision: z
    .object({
      summary: z.string().trim().min(1).max(4000),
      kind: z.enum(['decision', 'review-plan']),
    })
    .strict(),
  search_sources: z
    .object({
      query: z.string().trim().min(2).max(200).optional(),
      filter: z.string().trim().min(1).max(80).optional(),
      sourceIds: z.array(z.string().min(1).max(64)).max(10).optional(),
    })
    .strict(),
  read_chunk: z
    .object({
      chunkId: z.string().min(1).max(128),
      neighbours: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
  refresh_source: z.object({ resourceId: z.string().min(1).max(64) }).strict(),
  upcoming_events: z.object({}).strict(),
  channel_history: z
    .object({
      before: z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  search_conversations: z.object({ query: z.string().trim().min(2).max(200) }).strict(),
} as const;
type ToolName = keyof typeof schemas;

/**
 * Declarations for the live provider request, derived from `TOOL_CATALOGUE`
 * (`@bananasaurs/core`) so a declaration's name, description and parameters
 * can never drift from what the skill detail page shows (a test asserts
 * every entry here equals its catalogue entry). `web_search` is the one
 * conditional entry: it drops out entirely while search is off (ADR 0066).
 * `upcoming_events` and `channel_history` drop out the same way while their
 * port is absent (ADR 0092). Acting entries drop out while their skill is
 * not allowed (B2a).
 */
export const toolDeclarations = (ports: AssistantToolPorts): ToolDeclaration[] =>
  TOOL_CATALOGUE.filter(
    (entry) =>
      (entry.name !== 'web_search' || ports.webSearch !== undefined) &&
      (entry.name !== 'upcoming_events' || ports.upcomingEvents !== undefined) &&
      (entry.name !== 'channel_history' || ports.channelHistory !== undefined) &&
      (entry.name !== 'search_conversations' || ports.searchConversations !== undefined) &&
      (entry.actsForSkill === undefined || ports.skillAllowed(entry.actsForSkill)) &&
      (entry.requiresSkill === undefined || ports.skillAllowed(entry.requiresSkill)),
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

/** ISO 8601 date-time with a `Z` or `±hh:mm` offset (the `when`/`until` rule). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET_REFUSAL = 'Give the time as ISO 8601 with its UTC offset.';

/**
 * Content-derived idempotency keys: every acting write derives its id and
 * dedupe key from the invocation key plus a sha256 of the canonical JSON of
 * the validated, normalised args, so a provider failover replaying the same
 * call reuses the same key instead of inserting a second row.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
};
const contentHash = (content: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(content)))
    .digest('hex');
const contentKey = (prefix: string, invocationKey: string, content: unknown): string =>
  `${prefix}_${invocationKey}_${contentHash(content)}`;
/** Stored reminder context: trimmed, whitespace collapsed, absent when empty. */
const normaliseContext = (context: string | undefined): string | undefined => {
  if (context === undefined) return undefined;
  const collapsed = context.trim().replace(/\s+/g, ' ');
  return collapsed === '' ? undefined : collapsed;
};

interface RepeatArgs {
  readonly kind: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  readonly days?: readonly number[] | undefined;
  readonly everyWeeks?: number | undefined;
  readonly dayOfMonth?: number | undefined;
  readonly until?: string | undefined;
  readonly count?: number | undefined;
}

/** Milliseconds from local midnight in `timeZone` (0 exactly at midnight). */
const wallMsSinceMidnight = (at: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (
    value('hour') * 3_600_000 +
    value('minute') * 60_000 +
    value('second') * 1_000 +
    (((at % 1_000) + 1_000) % 1_000)
  );
};

/**
 * Next local midnight after `at` by local date, via core's `utcForLocal`: the
 * 24-hour arithmetic fails on a 25-hour fall-back day.
 */
const endOfMidnightDay = (at: number, timeZone: string): number => {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const num = (type: string): number => Number(ymd.find((part) => part.type === type)?.value ?? 0);
  const next = new Date(Date.UTC(num('year'), num('month') - 1, num('day')) + 86_400_000);
  return (
    utcForLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone) -
    1
  );
};

const buildRecurrence = (repeat: RepeatArgs, timeZone: string): unknown => {
  let pattern: unknown;
  if (repeat.kind === 'daily') pattern = { kind: 'daily' };
  else if (repeat.kind === 'weekdays') pattern = { kind: 'weekdays' };
  else if (repeat.kind === 'weekly') {
    if (repeat.days === undefined) return undefined;
    pattern = {
      kind: 'weekly',
      days: [...repeat.days],
      ...(repeat.everyWeeks === undefined ? {} : { everyWeeks: repeat.everyWeeks }),
    };
  } else {
    if (repeat.dayOfMonth === undefined) return undefined;
    pattern = { kind: 'monthly', dayOfMonth: repeat.dayOfMonth };
  }
  let endAt: number | undefined;
  if (repeat.until !== undefined) {
    if (!ISO_WITH_OFFSET.test(repeat.until)) return undefined;
    const parsed = Date.parse(repeat.until);
    if (!Number.isFinite(parsed)) return undefined;
    // "until Dec 31" arrives as local midnight, which as an exact instant
    // would drop the Dec 31 occurrence while the summary reads as inclusive:
    // treat exact local midnight as the end of that day (23:59:59.999 local).
    endAt =
      wallMsSinceMidnight(parsed, timeZone) === 0 ? endOfMidnightDay(parsed, timeZone) : parsed;
  }
  return {
    pattern,
    timeZone,
    ...(endAt === undefined ? {} : { endAt }),
    ...(repeat.count === undefined ? {} : { maxCount: repeat.count }),
  };
};

const parseRecurrence = (
  repeat: RepeatArgs,
  timeZone: string,
): { ok: true; recurrence: ReminderRecurrence } | { ok: false } => {
  const parsed = reminderRecurrence.safeParse(buildRecurrence(repeat, timeZone));
  return parsed.success ? { ok: true, recurrence: parsed.data } : { ok: false };
};

const requireSkill = (
  ports: AssistantToolPorts,
  name: string,
  skill: string,
): AssistantToolResult | undefined => {
  if (ports.skillAllowed(skill)) return undefined;
  ports.recordSkillActivity(skill, 'denied');
  return refused(name, "This member isn't allowed to use that. Tell them plainly; don't retry.");
};

/**
 * A quoted reply must not become a mass ping (ADR 0086 decision 3): when the
 * member's message quotes another message, reminders may still be set and
 * edited, but they may not ping roles, `@everyone` or `@here`. The `roles`
 * request field carries all three, so any non-empty value refuses before
 * target resolution. Member pings still work.
 */
const QUOTE_PING_REFUSAL =
  "I can't ping roles or everyone from a reply to someone else's message. Ask again without replying to it.";
const quotePingRefused = (
  ports: AssistantToolPorts,
  name: string,
  roles: readonly string[] | undefined,
): AssistantToolResult | undefined => {
  if (ports.quotePresent && roles !== undefined && roles.length > 0) {
    ports.recordSkillActivity('reminders', 'denied');
    return refused(name, QUOTE_PING_REFUSAL);
  }
  return undefined;
};

/**
 * An acting write threw: answer a fixed sentence, never the raw exception
 * text (driver and SQLite messages are internal detail). There is no logger
 * on the tool ports, so the error is dropped after the activity record.
 */
const FAILED_TEXT = 'Something went wrong saving that. Nothing was changed.';
const failed = (ports: AssistantToolPorts, name: string, skill: string, _err: unknown) => {
  ports.recordSkillActivity(skill, 'failed', FAILED_TEXT);
  return refused(name, FAILED_TEXT);
};

const clock = (ports: AssistantToolPorts, at: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ports.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(at);

/**
 * "3 hours ago" / "not fetched yet" for catalogue and search_sources lines.
 * One shared helper (Task 16 fix round 1): service.ts's catalogue uses this
 * too instead of its own copy.
 */
export const relativeUpdated = (fetchedAt: number | undefined, now: number): string =>
  fetchedAt === undefined
    ? 'not fetched yet'
    : `${humaniseDuration(Math.max(0, now - fetchedAt))} ago`;

const enabledById = (ports: AssistantToolPorts, resourceId: string): ClubResource | undefined =>
  ports.resources().find((r) => r.id === resourceId && r.enabled);

/**
 * The old `outline` body (ADR 0092 decision 3): the headings of one cached
 * doc. Shared by the `open_resource` docId path. `name` is the calling tool
 * so the result carries the name the model actually called.
 */
const outlineForDoc = (
  name: string,
  ports: AssistantToolPorts,
  docId: string,
): AssistantToolResult => {
  const rows = ports.cacheOutline(docId);
  // The outline rows carry no resource id, so the doc (or the first
  // row's chunk) names the resource whose enabled flag decides: a
  // disabled resource's outline is unknown, like its chunks.
  const outlineResourceId =
    ports.cacheDocument(docId)?.resourceId ??
    (rows[0] === undefined ? undefined : ports.cacheChunk(rows[0].chunkId)?.resourceId);
  if (outlineResourceId === undefined || enabledById(ports, outlineResourceId) === undefined)
    return refused(
      name,
      'Unknown id. Use an id from an earlier result in this request, or search again.',
    );
  if (rows.length === 0) {
    return { ...evidence(name, 'No headings cached.'), handles: [] };
  }
  const lines: string[] = [];
  const handles: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `[${row.chunkId}] ${clipHeading(row.headingPath, 200)}`;
    if (used + line.length + 1 > 1_500) break;
    lines.push(line);
    handles.push(row.chunkId);
    used += line.length + 1;
  }
  return { ...evidence(name, lines.join('\n')), handles };
};

export const runAssistantTool = async (
  call: ToolCall,
  ports: AssistantToolPorts,
  /**
   * ADR 0090 decision 3: the request's citation registry, so a `from` search
   * can tag each hit inline with the same tag the service's Sources line
   * later resolves. Absent, the tagging is left to the service (which passes
   * it on every production call); the hit lines then carry no tag.
   */
  citations?: CitationRegistry,
): Promise<AssistantToolResult> => {
  if (!(call.name in schemas))
    return refused(
      call.name,
      'No such tool. Use only the tools listed under WHAT YOU CAN DO RIGHT NOW.',
    );
  const name = call.name as ToolName;
  const parsed = schemas[name].safeParse(call.args ?? {});
  if (!parsed.success) {
    // The open_resource exactly-one-of rule carries its own refusal so the
    // model learns the shape; every other bad argument stays generic.
    if (parsed.error.issues.some((issue) => issue.message === 'Give either resourceId or docId.'))
      return refused(name, 'Give either resourceId or docId.');
    const first = parsed.error.issues[0];
    const raw =
      first === undefined ? 'invalid arguments' : `${first.path.join('.')}: ${first.message}`;
    const firstIssue = raw.slice(0, 200);
    return refused(name, `The arguments were not valid: ${firstIssue}. Fix it and call again.`);
  }

  try {
    switch (name) {
      case 'search_archive': {
        const { query: q, from } = parsed.data as { query: string; from?: string };
        // "Did X say Y?" needs something checkable: a bare name with no
        // query word has no tool path, like a bulk summary (ADR 0090 D3).
        if (from !== undefined && !/[A-Za-z]{3,}/.test(q))
          return refused(name, 'Say what you want to check they said.');
        const result = await ports.searchArchive(q, from);
        if (!result.ok) return refused(name, result.problem);
        // Without `from` the lines stay as they were: no author names.
        if (from === undefined) {
          if (result.hits.length === 0) return evidence(name, 'No matching messages.');
          return evidence(
            name,
            result.hits
              .map(
                (hit) =>
                  `<#${hit.channelId}> ${new Date(hit.createdAt).toISOString().slice(0, 10)}: ${hit.excerpt}`,
              )
              .join('\n'),
          );
        }
        const hits = result.hits.slice(0, 3);
        if (hits.length === 0) return evidence(name, 'No matching messages.');
        const sources: ToolSource[] = [];
        const lines = hits.map((hit) => {
          const day = new Date(hit.createdAt).toISOString().slice(0, 10);
          const source = {
            title: `#channel message, ${day}`,
            url: `https://discord.com/channels/${ports.guildId}/${hit.channelId}/${hit.messageId}`,
          };
          sources.push(source);
          const tag = citations?.tag(source);
          return `${tag === undefined ? '' : `[${tag}] `}<#${hit.channelId}> ${day}: ${hit.excerpt}`;
        });
        lines.push(
          "Answer only whether they said it. Cite the message tag. Do not summarise or list this member's messages.",
        );
        return evidence(name, lines.join('\n'), sources);
      }
      case 'open_resource': {
        const { resourceId, docId } = parsed.data as {
          resourceId?: string;
          docId?: string;
        };
        if (docId !== undefined) return outlineForDoc(name, ports, docId);
        const found = enabledById(ports, resourceId!);
        if (found === undefined)
          return refused(
            name,
            'Unknown id. Use an id from an earlier result in this request, or search again.',
          );
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
          const line = `[${chunk.chunkId}] ${clipHeading(chunk.headingPath, 200)}: ${chunk.text}`;
          if (used + line.length + 1 > 4_000) break;
          lines.push(line);
          shown.push(chunk.chunkId);
          used += line.length + 1;
        }
        if (lines.length === 0) {
          const first = chunks[0]!;
          const room = Math.max(
            0,
            4_000 -
              head.length -
              `[${first.chunkId}] ${clipHeading(first.headingPath, 200)}: `.length -
              1,
          );
          lines.push(
            `[${first.chunkId}] ${clipHeading(first.headingPath, 200)}: ${first.text.slice(0, room)}`,
          );
          shown.push(first.chunkId);
          // The single clipped chunk fills the budget on its own, so no
          // outline section below can fit.
          used = 4_000;
        }
        // Document-like resources also carry the first doc's outline (up to
        // 40 headings), straight from the same cache ports, while it fits in
        // the 4,000-character budget.
        const outlineRows = ports.cacheOutline(doc.docId);
        if (outlineRows.length > 0 && used + 'Headings:'.length + 1 <= 4_000) {
          const headingLines = ['Headings:'];
          const headingShown: string[] = [];
          used += 'Headings:'.length + 1;
          for (const row of outlineRows.slice(0, 40)) {
            const line = `[${row.chunkId}] ${clipHeading(row.headingPath, 200)}`;
            if (used + line.length + 1 > 4_000) break;
            headingLines.push(line);
            headingShown.push(row.chunkId);
            used += line.length + 1;
          }
          if (headingLines.length > 1) {
            lines.push(...headingLines);
            shown.push(...headingShown);
          }
        }
        return {
          ...evidence(name, `${head}${lines.join('\n')}`.slice(0, 4_000), [source]),
          handles: [...shown, doc.docId],
        };
      }
      case 'web_search': {
        const { query: q } = parsed.data as z.infer<typeof query>;
        const gate = requireSkill(ports, name, 'web-search');
        if (gate !== undefined) return gate;
        if (ports.webSearch === undefined)
          return refused(
            name,
            "Web search is off on this server. Answer from club sources or say you can't look it up.",
          );
        // The query leaves for the search provider: the same local scan as member input.
        if (
          !scanOutboundRequest({ model: 'web-search', messages: [{ role: 'user', text: q }] }).safe
        )
          return refused(name, 'The query looked like it contained personal data or a secret.');
        let outcome: WebSearchOutcome;
        try {
          outcome = await ports.webSearch(q);
        } catch (err) {
          if (err instanceof WebSearchLimitError)
            return refused(name, 'Web search has reached its limit for now. Answer without it.');
          // Fixed text only: a provider body or driver message must never
          // reach the model (ADR 0120 §6).
          if (err instanceof SearchHttpError)
            return refused(
              name,
              `Web search failed (HTTP ${String(err.status)}). Try once more with a simpler query, or answer without it.`,
            );
          return refused(
            name,
            'Web search failed. Try once more with a simpler query, or answer without it.',
          );
        }
        const results = outcome.results;
        if (results.length === 0)
          return { ...evidence(name, 'No web results.'), webSource: outcome.source };
        return {
          ...evidence(
            name,
            results.map((r) => `${r.title} (${r.url})\n${r.description}`).join('\n\n'),
            results.map((r) => ({ title: r.title, url: r.url })),
          ),
          webSource: outcome.source,
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
        const gate = requireSkill(ports, name, 'reminders');
        if (gate !== undefined) return gate;
        try {
          const { all } = parsed.data as { all?: boolean };
          const rows =
            all === true && ports.isOwner
              ? ports.reminderStore.listAll()
              : ports.reminderStore.listForCreator(ports.userId);
          const unfinished = rows.filter(
            (r) => r.status === 'scheduled' || r.status === 'delivering',
          );
          if (unfinished.length === 0) return evidence(name, 'No upcoming reminders.');
          return {
            ...evidence(
              name,
              unfinished
                .map((r) => {
                  const parts = [r.id, clock(ports, r.dueAt), `#${r.destinationId}`, r.text];
                  if (r.recurrence !== undefined)
                    parts.push(`repeats ${describeRecurrence(r.recurrence)}`);
                  const pings =
                    r.mentions.userIds.length +
                    r.mentions.roleIds.length +
                    (r.mentions.everyone ? 1 : 0) +
                    (r.mentions.here ? 1 : 0);
                  parts.push(`pings ${pings}`);
                  return parts.join(' · ');
                })
                .join('\n'),
            ),
            handles: unfinished.map((r) => r.id),
          };
        } catch (err) {
          return failed(ports, name, 'reminders', err);
        }
      }
      case 'set_reminder': {
        const gate = requireSkill(ports, name, 'reminders');
        if (gate !== undefined) return gate;
        try {
          const args = parsed.data as {
            text: string;
            when: string;
            context?: string;
            channel?: string;
            members?: string[];
            roles?: string[];
            repeat?: RepeatArgs;
          };
          const quoteGate = quotePingRefused(ports, name, args.roles);
          if (quoteGate !== undefined) return quoteGate;
          if (!ISO_WITH_OFFSET.test(args.when)) return refused(name, OFFSET_REFUSAL);
          const dueAt = Date.parse(args.when);
          if (!Number.isFinite(dueAt)) return refused(name, OFFSET_REFUSAL);
          let recurrence: ReminderRecurrence | undefined;
          if (args.repeat !== undefined) {
            const built = parseRecurrence(args.repeat, ports.timeZone);
            if (!built.ok)
              return refused(
                name,
                'The repeat pattern was not valid: give kind (daily, weekdays, weekly or monthly), plus days for weekly or dayOfMonth for monthly.',
              );
            recurrence = built.recurrence;
          }
          if (recurrence?.endAt !== undefined && recurrence.endAt < dueAt)
            return refused(name, `The repeat can't end before the reminder starts.`);
          const normalisedContext = normaliseContext(args.context);
          const draft = validateReminderDraft(
            {
              dueAt,
              text: args.text,
              ...(normalisedContext === undefined ? {} : { context: normalisedContext }),
            },
            ports.now(),
          );
          if (!draft.ok) return refused(name, draft.error);
          const resolved = await ports.resolveReminderTargets({
            channel: args.channel,
            members: args.members ?? [],
            roles: args.roles ?? [],
          });
          if (!resolved.ok) return { ...evidence(name, resolved.problem), ok: false };
          const targets: ResolvedReminderTargets = resolved.targets;
          const keyContent = {
            text: draft.text,
            dueAt,
            ...(normalisedContext === undefined ? {} : { context: normalisedContext }),
            channelId: targets.channelId,
            mentions: {
              userIds: [...targets.mentions.userIds].sort(),
              roleIds: [...targets.mentions.roleIds].sort(),
              everyone: targets.mentions.everyone,
              here: targets.mentions.here,
            },
            ...(recurrence === undefined ? {} : { recurrence }),
            creatorId: ports.userId,
          };
          const reminder: Omit<Reminder, 'guildId'> = {
            id: contentKey('rem', ports.invocationKey, keyContent),
            creatorId: ports.userId,
            destinationId: targets.channelId,
            text: draft.text,
            dueAt,
            createdAt: ports.now(),
            status: 'scheduled',
            dedupeKey: contentKey('reminder', ports.invocationKey, keyContent),
            mentions: {
              userIds: [...targets.mentions.userIds],
              roleIds: [...targets.mentions.roleIds],
              everyone: targets.mentions.everyone,
              here: targets.mentions.here,
            },
            ...(recurrence === undefined ? {} : { recurrence }),
            ...(normalisedContext === undefined ? {} : { context: normalisedContext }),
            deliveredCount: 0,
          };
          const inserted = ports.reminderStore.insert(reminder);
          const buildSetSummary = (row: {
            readonly text: string;
            readonly dueAt: number;
            readonly recurrence?: unknown;
            readonly context?: string;
          }): string =>
            reminderSummary('set', {
              text: row.text,
              dueAt: row.dueAt,
              timeZone: ports.timeZone,
              recurrence: (row.recurrence ?? recurrence) as ReminderRecurrence | undefined,
              context: row.context,
              channelName: targets.channelName,
              memberNames: targets.memberNames,
              roleNames: targets.roleNames,
              everyone: targets.mentions.everyone,
              here: targets.mentions.here,
            });
          if (inserted === 'duplicate') {
            const stored = ports.reminderStore.get(reminder.id);
            const summary = buildSetSummary(stored ?? reminder);
            return { ...evidence(name, summary), actionSummary: summary };
          }
          ports.recordSkillActivity('reminders', 'completed');
          const summary = buildSetSummary(reminder);
          return { ...evidence(name, summary), actionSummary: summary };
        } catch (err) {
          return failed(ports, name, 'reminders', err);
        }
      }
      case 'edit_reminder': {
        const gate = requireSkill(ports, name, 'reminders');
        if (gate !== undefined) return gate;
        try {
          const args = parsed.data as {
            reminderId: string;
            text?: string;
            when?: string;
            context?: string;
            channel?: string;
            members?: string[];
            roles?: string[];
            repeat?: RepeatArgs;
            stopRepeating?: boolean;
          };
          const quoteGate = quotePingRefused(ports, name, args.roles);
          if (quoteGate !== undefined) return quoteGate;
          const stored = ports.reminderStore.get(args.reminderId);
          if (stored === undefined)
            return refused(
              name,
              'No reminder has that id. Call my_reminders for current ids, then try again.',
            );
          if (stored.creatorId !== ports.userId && !ports.isOwner)
            return refused(
              name,
              'That reminder belongs to someone else; only they or the owner can change it. Tell the member.',
            );
          let dueAt: number | undefined;
          if (args.when !== undefined) {
            if (!ISO_WITH_OFFSET.test(args.when)) return refused(name, OFFSET_REFUSAL);
            dueAt = Date.parse(args.when);
            if (!Number.isFinite(dueAt)) return refused(name, OFFSET_REFUSAL);
          }
          let recurrence: ReminderRecurrence | null | undefined;
          if (args.stopRepeating === true) recurrence = null;
          else if (args.repeat !== undefined) {
            const built = parseRecurrence(args.repeat, ports.timeZone);
            if (!built.ok)
              return refused(
                name,
                'The repeat pattern was not valid: give kind (daily, weekdays, weekly or monthly), plus days for weekly or dayOfMonth for monthly.',
              );
            recurrence = built.recurrence;
          }
          const effectiveDueAt = dueAt ?? stored.dueAt;
          const effectiveRecurrence =
            recurrence === undefined ? stored.recurrence : (recurrence ?? undefined);
          if (
            effectiveRecurrence?.endAt !== undefined &&
            effectiveRecurrence.endAt < effectiveDueAt
          )
            return refused(name, `The repeat can't end before the reminder starts.`);
          const normalisedEditContext =
            args.context === undefined ? undefined : normaliseContext(args.context);
          if (args.text !== undefined || dueAt !== undefined || args.context !== undefined) {
            const context = args.context === undefined ? stored.context : normalisedEditContext;
            const draft = validateReminderDraft(
              {
                dueAt: dueAt ?? stored.dueAt,
                text: args.text ?? stored.text,
                ...(context === undefined ? {} : { context }),
              },
              ports.now(),
            );
            if (!draft.ok) return refused(name, draft.error);
          }
          let targets: ResolvedReminderTargets | undefined;
          if (
            args.channel !== undefined ||
            args.members !== undefined ||
            args.roles !== undefined
          ) {
            const rolesParam = args.roles ?? [
              ...stored.mentions.roleIds,
              ...(stored.mentions.everyone ? ['everyone'] : []),
              ...(stored.mentions.here ? ['here'] : []),
            ];
            const resolved = await ports.resolveReminderTargets({
              channel: args.channel ?? stored.destinationId,
              members: args.members ?? [...stored.mentions.userIds],
              roles: rolesParam,
            });
            if (!resolved.ok) return { ...evidence(name, resolved.problem), ok: false };
            targets = resolved.targets;
          }
          const patch: ReminderPatch = {
            ...(args.text === undefined ? {} : { text: args.text.trim() }),
            ...(normalisedEditContext === undefined ? {} : { context: normalisedEditContext }),
            ...(dueAt === undefined ? {} : { dueAt }),
            ...(targets === undefined
              ? {}
              : {
                  destinationId: targets.channelId,
                  mentions: {
                    userIds: [...targets.mentions.userIds],
                    roleIds: [...targets.mentions.roleIds],
                    everyone: targets.mentions.everyone,
                    here: targets.mentions.here,
                  },
                }),
            ...(recurrence === undefined ? {} : { recurrence }),
          };
          const updated = ports.reminderStore.update(args.reminderId, patch);
          if (updated === 'not-found')
            return refused(
              name,
              'No reminder has that id. Call my_reminders for current ids, then try again.',
            );
          if (updated === 'not-editable')
            return refused(name, 'That reminder is already being sent or has finished.');
          ports.recordSkillActivity('reminders', 'completed');
          const after = ports.reminderStore.get(args.reminderId) ?? stored;
          const summary = reminderSummary('updated', {
            text: after.text,
            dueAt: after.dueAt,
            timeZone: ports.timeZone,
            recurrence: after.recurrence ?? undefined,
            context: after.context,
            ...(targets === undefined
              ? {}
              : {
                  channelName: targets.channelName,
                  memberNames: targets.memberNames,
                  roleNames: targets.roleNames,
                }),
            everyone: after.mentions.everyone,
            here: after.mentions.here,
          });
          return { ...evidence(name, summary), actionSummary: summary };
        } catch (err) {
          return failed(ports, name, 'reminders', err);
        }
      }
      case 'cancel_reminder': {
        const gate = requireSkill(ports, name, 'reminders');
        if (gate !== undefined) return gate;
        try {
          const args = parsed.data as { reminderId: string };
          const stored = ports.reminderStore.get(args.reminderId);
          if (stored === undefined)
            return refused(
              name,
              'No reminder has that id. Call my_reminders for current ids, then try again.',
            );
          if (stored.creatorId !== ports.userId && !ports.isOwner)
            return refused(
              name,
              'That reminder belongs to someone else; only they or the owner can change it. Tell the member.',
            );
          const cancelled = ports.reminderStore.cancel(args.reminderId);
          if (!cancelled) return refused(name, "That reminder can't be cancelled now.");
          ports.recordSkillActivity('reminders', 'completed');
          const summary = reminderSummary('cancelled', {
            text: stored.text,
            dueAt: stored.dueAt,
            timeZone: ports.timeZone,
            recurrence: stored.recurrence,
            context: stored.context,
          });
          return { ...evidence(name, summary), actionSummary: summary };
        } catch (err) {
          return failed(ports, name, 'reminders', err);
        }
      }
      case 'propose_memory': {
        const gate = requireSkill(ports, name, 'propose-memory');
        if (gate !== undefined) return gate;
        try {
          const args = parsed.data as { content: string; section?: string };
          ports.proposeDraft({
            id: contentKey('memory', ports.invocationKey, {
              content: args.content,
              ...(args.section === undefined ? {} : { section: args.section }),
            }),
            kind: 'memory',
            summary: args.section === undefined ? args.content : `${args.section}: ${args.content}`,
          });
          ports.recordSkillActivity('propose-memory', 'completed');
          const actionSummary =
            '📝 Memory proposal filed for owner review. Nothing is remembered until it is approved.';
          return { ...evidence(name, actionSummary), actionSummary };
        } catch (err) {
          return failed(ports, name, 'propose-memory', err);
        }
      }
      case 'propose_decision': {
        const gate = requireSkill(ports, name, 'record-decision');
        if (gate !== undefined) return gate;
        try {
          const args = parsed.data as { summary: string; kind: 'decision' | 'review-plan' };
          ports.proposeDraft({
            id: contentKey(args.kind, ports.invocationKey, {
              kind: args.kind,
              summary: args.summary,
            }),
            kind: args.kind,
            summary: args.summary,
          });
          ports.recordSkillActivity('record-decision', 'completed');
          const actionSummary =
            '📝 Draft filed for owner review. It is not club policy until an owner saves it.';
          return { ...evidence(name, actionSummary), actionSummary };
        } catch (err) {
          return failed(ports, name, 'record-decision', err);
        }
      }
      case 'search_sources': {
        const {
          query: q,
          filter,
          sourceIds,
        } = parsed.data as {
          query?: string;
          filter?: string;
          sourceIds?: string[];
        };
        // Without a query this is the old `list_sources` (ADR 0092 decision
        // 3): the cached sources, filtered, 30 lines with handles.
        if (q === undefined) {
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
                `${r.id} · ${r.title} (${r.kind}) · updated ${relativeUpdated(freshness.get(r.id), ports.now())}`,
            );
          if (lines.length === 0) return evidence(name, 'No sources match that filter.');
          return {
            ...evidence(name, lines.join('\n')),
            handles: matching.slice(0, 30).map((r) => r.id),
          };
        }
        // A search with no sourceIds stays inside the guild's enabled
        // resources: a disabled resource (e.g. a repo that went private) is
        // never searchable, even though its chunks are still cached.
        const enabledIds = ports
          .resources()
          .filter((r) => r.enabled)
          .map((r) => r.id);
        if (sourceIds !== undefined) {
          const known = new Set(enabledIds);
          for (const id of sourceIds) {
            if (!known.has(id))
              return refused(
                name,
                'Unknown id. Use an id from an earlier result in this request, or search again.',
              );
          }
        }
        const hits = ports.cacheSearch({
          query: q,
          resourceIds: sourceIds ?? enabledIds,
          limit: 6,
        });
        if (hits.length === 0)
          return evidence(
            name,
            'No matching passages. Try different words, or call search_sources without a query.',
          );
        const byId = new Map(ports.resources().map((r) => [r.id, r]));
        const enabled = new Set(enabledIds);
        const lines: string[] = [];
        const handles: string[] = [];
        let used = 0;
        for (const hit of hits.slice(0, 6)) {
          if (!enabled.has(hit.resourceId)) continue;
          const title = byId.get(hit.resourceId)?.title ?? hit.resourceId;
          const snippet = hit.snippet.length > 300 ? `${hit.snippet.slice(0, 299)}…` : hit.snippet;
          const line = `[${hit.chunkId}] ${title} › ${clipHeading(hit.headingPath, 200)}: ${snippet}`;
          if (used + line.length + (lines.length > 0 ? 1 : 0) > 2_000) continue;
          lines.push(line);
          handles.push(hit.chunkId, hit.docId);
          used += line.length + (lines.length > 1 ? 1 : 0);
        }
        if (lines.length === 0)
          return evidence(
            name,
            'No matching passages. Try different words, or call search_sources without a query.',
          );
        return { ...evidence(name, lines.join('\n')), handles };
      }
      case 'read_chunk': {
        const { chunkId, neighbours } = parsed.data as {
          chunkId: string;
          neighbours?: 0 | 1 | 2;
        };
        const center = ports.cacheChunk(chunkId);
        if (center === undefined)
          return refused(
            name,
            'Unknown id. Use an id from an earlier result in this request, or search again.',
          );
        if (enabledById(ports, center.resourceId) === undefined)
          return refused(
            name,
            'Unknown id. Use an id from an earlier result in this request, or search again.',
          );
        const rows = ports.cacheNeighbours(chunkId, neighbours ?? 1);
        const shown = rows.length > 0 ? rows : [center];
        const found = enabledById(ports, center.resourceId);
        const title = found?.title ?? center.resourceId;
        const url = found?.url ?? '';
        const sourceList = found === undefined ? [] : [{ title: found.title, url: found.url }];
        const head =
          url === ''
            ? `${title} › ${clipHeading(center.headingPath, 200)}\n`
            : `${title} › ${clipHeading(center.headingPath, 200)}\n${url}\n`;
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
      case 'refresh_source': {
        const { resourceId } = parsed.data as { resourceId: string };
        const found = enabledById(ports, resourceId);
        if (found === undefined)
          return refused(
            name,
            'Unknown id. Use an id from an earlier result in this request, or search again.',
          );
        const enqueued = ports.enqueueRefresh(found.id);
        return evidence(
          name,
          enqueued
            ? 'Refresh started; updated content will be available in about a minute.'
            : 'A refresh was already requested in the last 10 minutes.',
        );
      }
      case 'upcoming_events': {
        if (ports.upcomingEvents === undefined)
          return refused(
            name,
            "I couldn't check the schedule right now. Answer without it and say the schedule couldn't be checked.",
          );
        // The service already filters, sorts and caps; the slice and sort
        // here only bound a hand-built port in tests.
        const items = [...(await ports.upcomingEvents())]
          .sort((a, b) => a.startsAt - b.startsAt)
          .slice(0, 10);
        if (items.length === 0) return evidence(name, 'Nothing scheduled in the next 30 days.');
        const clean = (text: string): string => neutraliseMarkers(redactEvidenceText(text).text);
        const lines = items.map((item) => {
          const line = `${clean(item.title)} — ${clock(ports, item.startsAt)} — ${clean(item.where)}`;
          if (item.kind !== 'event' || item.description === undefined || item.description === '')
            return line;
          return `${line} — ${clean(item.description).slice(0, 200)}`;
        });
        return evidence(name, lines.join('\n'));
      }
      case 'channel_history': {
        if (ports.channelHistory === undefined)
          return refused(
            name,
            "I couldn't read the channel history. Answer from the recent messages you already have.",
          );
        const { before, limit } = parsed.data as { before?: string; limit?: number };
        const page = await ports.channelHistory({
          ...(before === undefined ? {} : { before }),
          // No limit named means a middle page, not the whole channel.
          limit: limit ?? 20,
        });
        if (page === undefined)
          return refused(
            name,
            "I couldn't read the channel history. Answer from the recent messages you already have.",
          );
        const body = evidence(name, page.lines.join('\n'));
        if (page.oldestId === undefined) return { ...body, handles: [] };
        // The cursor is code-issued (the port's own handle), not untrusted
        // message text, so it joins after the evidence filter: a snowflake
        // that happens to be Luhn-valid would otherwise redact into
        // `[redacted …]` and the model could never page with it.
        const cursor = `Older: before=${page.oldestId}`;
        return {
          ...body,
          text: body.text === '' ? cursor : `${body.text}\n${cursor}`,
          handles: [page.oldestId],
        };
      }
      case 'search_conversations': {
        const { query: q } = parsed.data as { query: string };
        if (ports.searchConversations === undefined)
          return refused(name, 'Looking back at earlier conversations is not available here.');
        // At most 5 lines, each `<#channel>, <relative date>: topic — up to
        // three facts` (ADR 0093 decision 2). The port carries only the
        // aggregated display fields — no participants, no bot claims, no
        // commitment owners — so none can leak through the formatting.
        const shown = (await ports.searchConversations(q)).slice(0, 5);
        if (shown.length === 0)
          return {
            ...evidence(name, 'No earlier conversations matched.'),
            recalledConversationIds: [],
          };
        const lines = shown.map((hit) => {
          const facts = hit.facts.slice(0, 3).join('; ');
          const head = `<#${hit.channelId}>, ${relativeAgo(hit.lastActivityAt, ports.now())}: ${hit.topic}`;
          return facts === '' ? head : `${head} — ${facts}`;
        });
        return {
          ...evidence(name, lines.join('\n')),
          recalledConversationIds: shown.map((hit) => hit.conversationId),
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return refused(name, `The tool failed: ${message}`);
  }
};
