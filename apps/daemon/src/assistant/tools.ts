import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  clipHeading,
  humaniseDuration,
  redactEvidenceText,
  reminderRecurrence,
  scanOutboundRequest,
  TOOL_CATALOGUE,
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
  readonly now: () => number;
  readonly timeZone: string;
  readonly isOwner: boolean;
  /** True when the behaviour allows the skill and the asker passes its scope (B2b computes it). */
  readonly skillAllowed: (skillId: string) => boolean;
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
  readonly searchArchive: (query: string) => Promise<readonly ArchiveHit[]>;
  readonly resources: () => readonly ClubResource[];
  readonly fetchResource: (url: string) => Promise<ResourceFetchResult>;
  /** Absent while web search is off (ADR 0066). */
  readonly webSearch?: ((query: string) => Promise<readonly WebResult[]>) | undefined;
  readonly serverCard: () => string;
  readonly visibleChannels: () => Promise<readonly { id: string; name: string }[]>;
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
  search_archive: query,
  open_resource: z.object({ resourceId: z.string().min(1).max(64) }).strict(),
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
 * Acting entries drop out while their skill is not allowed (B2a).
 */
export const toolDeclarations = (ports: AssistantToolPorts): ToolDeclaration[] =>
  TOOL_CATALOGUE.filter(
    (entry) =>
      (entry.name !== 'web_search' || ports.webSearch !== undefined) &&
      (entry.actsForSkill === undefined || ports.skillAllowed(entry.actsForSkill)),
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
  `${prefix}:${invocationKey}:${contentHash(content)}`;
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
      wallMsSinceMidnight(parsed, timeZone) === 0
        ? parsed + 86_400_000 - wallMsSinceMidnight(parsed + 86_400_000, timeZone) - 1
        : parsed;
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
  return refused(name, "You're not allowed to use that here.");
};

const failed = (ports: AssistantToolPorts, name: string, skill: string, err: unknown) => {
  const message = err instanceof Error ? err.message : 'unknown error';
  ports.recordSkillActivity(skill, 'failed', message);
  return refused(name, `The tool failed: ${message}`);
};

const clock = (ports: AssistantToolPorts, at: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ports.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(at);

/**
 * "3 hours ago" / "not fetched yet" for catalogue and list_sources lines.
 * One shared helper (Task 16 fix round 1): service.ts's catalogue uses this
 * too instead of its own copy.
 */
export const relativeUpdated = (fetchedAt: number | undefined, now: number): string =>
  fetchedAt === undefined
    ? 'not fetched yet'
    : `${humaniseDuration(Math.max(0, now - fetchedAt))} ago`;

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
          return evidence(
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
          );
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
          if (!ISO_WITH_OFFSET.test(args.when)) return refused(name, OFFSET_REFUSAL);
          const dueAt = Date.parse(args.when);
          if (!Number.isFinite(dueAt)) return refused(name, OFFSET_REFUSAL);
          let recurrence: ReminderRecurrence | undefined;
          if (args.repeat !== undefined) {
            const built = parseRecurrence(args.repeat, ports.timeZone);
            if (!built.ok) return refused(name, 'The repeat pattern was not valid.');
            recurrence = built.recurrence;
          }
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
          const stored = ports.reminderStore.get(args.reminderId);
          if (stored === undefined) return refused(name, "I couldn't find that reminder.");
          if (stored.creatorId !== ports.userId && !ports.isOwner)
            return refused(name, 'You can only change reminders you set.');
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
            if (!built.ok) return refused(name, 'The repeat pattern was not valid.');
            recurrence = built.recurrence;
          }
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
          if (updated === 'not-found') return refused(name, "I couldn't find that reminder.");
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
          if (stored === undefined) return refused(name, "I couldn't find that reminder.");
          if (stored.creatorId !== ports.userId && !ports.isOwner)
            return refused(name, 'You can only change reminders you set.');
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
              `${r.id} · ${r.title} (${r.kind}) · updated ${relativeUpdated(freshness.get(r.id), ports.now())}`,
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
            if (!known.has(id)) return refused(name, 'unknown id');
          }
        }
        const hits = ports.cacheSearch({
          query: q,
          resourceIds: sourceIds ?? enabledIds,
          limit: 6,
        });
        if (hits.length === 0)
          return evidence(name, 'No matching passages. Try different words, or list_sources.');
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
        if (enabledById(ports, center.resourceId) === undefined) return refused(name, 'unknown id');
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
      case 'outline': {
        const { docId } = parsed.data as { docId: string };
        const rows = ports.cacheOutline(docId);
        // The outline rows carry no resource id, so the doc (or the first
        // row's chunk) names the resource whose enabled flag decides: a
        // disabled resource's outline is unknown, like its chunks.
        const outlineResourceId =
          ports.cacheDocument(docId)?.resourceId ??
          (rows[0] === undefined ? undefined : ports.cacheChunk(rows[0].chunkId)?.resourceId);
        if (outlineResourceId === undefined || enabledById(ports, outlineResourceId) === undefined)
          return refused(name, 'unknown id');
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
