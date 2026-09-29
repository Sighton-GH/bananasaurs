import { randomUUID } from 'node:crypto';
import {
  assertProviderEligible,
  clipHeading,
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  effectiveSkillScope,
  estimateTokens,
  JOB_KINDS,
  neutraliseMarkers,
  providerMayTrain,
  ProviderError,
  redactEvidenceText,
  resourceRefreshDedupeKey,
  SafeProvider,
  safeLogFields,
  skillScopeAllows,
  stripNewTopic,
  type AssistantTrace,
  type CompiledAssistantContext,
  type Config,
  type GenerationMessage,
  type Logger,
  type TextProvider,
} from '@bananasaurs/core';
import {
  archiveRepo,
  archiveSearchRepo,
  assistantRepo,
  conversationRepo,
  eligibilityRepo,
  jobRepo,
  resourceCacheRepo,
  traceRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import type {
  AssistantCommandService,
  AssistantInvocation,
  AssistantInvocationResult,
  AssistantTraceDetail,
  InvocationTrace,
} from './commands.js';
import { braveWebSearch } from './brave-search.js';
import { BUSY_REPLY, dailyQuotaReply } from './fallback-replies.js';
import { type ChainEntry, type ProviderId } from './model-chain.js';
import { LocalLimitError, localLimitReply, reserveEntryCall } from './local-limit.js';
import { ID_TOOL_ARGS, runToolLoop, type LoopResult } from './tool-loop.js';
import { ChainFailedError, summarizeAttempts } from './chain-failed-error.js';
import { QuotaLedger } from './quota-ledger.js';
import {
  runAssistantTool,
  relativeUpdated,
  toolDeclarations,
  type ArchiveResult,
  type AssistantToolPorts,
  type WebResult,
} from './tools.js';
import type { ReviewedResourceFetcher } from './resource-fetcher.js';
import { buildUserMessage } from './user-message.js';
import { sanitizeMentionsForProvider } from './mentions.js';
import { labelUserTurn } from './conversation-context.js';
import { applyCitations, createCitationRegistry } from './citations.js';
import type { ReminderTargetRequest, ReminderTargetResult } from './reminder-targets.js';
const textOf = (input: Readonly<Record<string, string>>): string => Object.values(input).join('\n');

/**
 * Task 14: the trace's `sections` are the compiled context sections as
 * `context.ts` names them, plus `history` when history was sent (ruling).
 * The quoted envelope is user text, not a section — like the evidence
 * envelope it travels in the messages, never the system instruction.
 *
 * The trace's `user-message` section carries the same text minus the quoted
 * message itself: the envelope arrives as its own part, so the trace swaps
 * it for a placeholder while the provider request is unchanged.
 */
const TRACE_QUOTE_PLACEHOLDER = '[quoted message: not kept in the trace]';
const traceSections = (
  context: CompiledAssistantContext,
  history: readonly GenerationMessage[],
  userText: string,
  quoteEnvelope?: string,
): AssistantTrace['sections'] => {
  const sections = context.sections.map((section) => ({
    name: section.name,
    chars: section.text.length,
    estTokens: estimateTokens(section.text),
    text: section.text,
  }));
  const withHistory =
    history.length === 0
      ? sections
      : (() => {
          const text = history.map((message) => `${message.role}: ${message.text}`).join('\n\n');
          return [
            ...sections,
            { name: 'history', chars: text.length, estTokens: estimateTokens(text), text },
          ];
        })();
  const tracedUserText =
    quoteEnvelope === undefined || quoteEnvelope === ''
      ? userText
      : userText.replaceAll(quoteEnvelope, TRACE_QUOTE_PLACEHOLDER);
  return [
    ...withHistory,
    {
      name: 'user-message',
      chars: tracedUserText.length,
      estTokens: estimateTokens(tracedUserText),
      text: tracedUserText,
    },
  ];
};
export interface AssistantServiceTestPorts {
  readonly provider?: TextProvider | undefined;
  readonly fetchResource?:
    ((url: string) => ReturnType<ReviewedResourceFetcher['fetch']>) | undefined;
  /** Replaces Brave's HTTP call in tests. */
  readonly webSearch?: ((query: string) => Promise<readonly WebResult[]>) | undefined;
  /**
   * Task 20: replaces the pre-retrieval cache search in tests — throw from
   * it to simulate an unreadable resource cache (`resources-unavailable`).
   */
  readonly cacheSearch?:
    | ((
        query: string,
        resourceIds: readonly string[],
      ) => readonly {
        readonly resourceId: string;
        readonly chunkId: string;
        readonly docId: string;
        readonly headingPath: string;
        readonly snippet: string;
      }[])
    | undefined;
}

/** One chunk/resource-backed source for the answer's sources line. */
interface AnswerSource {
  readonly title: string;
  readonly url: string;
  readonly heading?: string | undefined;
}

/**
 * Task 20: the short line ending an answer — at most five entries, deduped
 * by URL, each a resource title (plus `› heading` when the evidence names
 * one). Empty when nothing chunk/resource-backed was used, in which case the
 * caller appends nothing.
 */
const sourcesLine = (sources: readonly AnswerSource[]): string => {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const source of sources) {
    if (source.url === '' || seen.has(source.url)) continue;
    seen.add(source.url);
    const label =
      source.heading === undefined || source.heading === ''
        ? source.title
        : `${source.title} › ${clipHeading(source.heading, 120)}`;
    // ADR 0090 D3: a cited `from` hit lists its code-issued message link.
    // Only registry-cited, known sources reach this line, so a model-written
    // URL can never appear here.
    entries.push(
      source.url.startsWith('https://discord.com/channels/') ? `[${label}](${source.url})` : label,
    );
    if (entries.length >= 5) break;
  }
  if (entries.length === 0) return '';
  return `\n\n-# Sources: ${entries.join(' · ')}`;
};

/** Task 20: dashboard Try-it in and out. */
export interface AssistantTryItInput {
  readonly behaviourId: string;
  readonly question: string;
  readonly conversationId?: string | undefined;
  readonly accountUsername: string;
}
export interface AssistantTryItResult {
  readonly answer: string;
  readonly traceId: string;
  readonly conversationId: string;
}

/** One member the `from` lookup can see (ADR 0090 decision 3). */
export interface FoundMember {
  readonly id: string;
  readonly displayName: string;
  readonly globalName?: string | undefined;
  readonly username?: string | undefined;
}

/** What the tools need from live Discord (ADR 0067). */
export interface AssistantDiscordPorts {
  /**
   * Text channels the member can view and read history in, from their live
   * permissions. The archive tool searches only these; empty fails closed.
   */
  readonly memberChannels: (
    userId: string,
  ) => Promise<readonly { readonly id: string; readonly name: string }[]>;
  /**
   * Channels every viewer of the answer channel can read (ADR 0090). The
   * archive tool searches only these intersected with `memberChannels`;
   * empty fails closed. Optional so existing callers keep compiling —
   * production (`runtime/guild.ts`) always provides it. Absent with a
   * channel set, the service fails closed and searches nothing.
   */
  readonly audienceChannels?:
    ((answerChannelId: string) => Promise<ReadonlySet<string>>) | undefined;
  /**
   * ADR 0090 D3: resolves a `search_archive` `from` value (a member mention,
   * id or name) to the members the job can see. Optional so existing callers
   * keep compiling — production (`runtime/guild.ts`) always provides it.
   * Absent, every `from` search refuses.
   */
  readonly findMember?: ((nameOrId: string) => Promise<readonly FoundMember[]>) | undefined;
  /**
   * B2b: resolves a reminder's channel and mentions against live Discord
   * permissions. Optional so existing callers keep compiling — production
   * (`runtime/guild.ts`) always provides it. Absent, the service fails
   * closed with the permissions sentence.
   */
  readonly resolveReminderTargets?:
    ((request: ReminderTargetRequest) => Promise<ReminderTargetResult>) | undefined;
}
/** B2b: the closed default — permissions cannot be checked, so no reminder. */
const defaultResolveReminderTargets = (): Promise<ReminderTargetResult> =>
  Promise.resolve({
    ok: false,
    problem: "I can't check permissions right now, so I didn't set the reminder.",
  });
export const createAssistantService = (
  scope: GuildScope,
  instance: InstanceScope,
  config: Config,
  now: () => number,
  testPorts: AssistantServiceTestPorts = {},
  liveConfig: () => Config = () => config,
  logger: Pick<Logger, 'warn'> = { warn: () => undefined },
  discord: AssistantDiscordPorts = {
    memberChannels: () => Promise.resolve([]),
    resolveReminderTargets: () => defaultResolveReminderTargets(),
  },
  /**
   * ADR 0075: the ordered, resolved model chain — built by
   * `ProviderConfigStore.chain()` at the composition root and handed down
   * through `guild.ts`, one call per invocation so a dashboard change is
   * live on the next request. Empty when no store exists.
   */
  chain: () => readonly ChainEntry[] = () => [],
  /**
   * Task 8: the process-wide QuotaLedger, constructed once in
   * `runtime/daemon.ts` and shared by every guild so a spent `:free`
   * allowance stays spent across guilds until its reset. Defaults to a fresh
   * ledger (one per service) for tests that do not pass one.
   */
  quotaLedger: QuotaLedger = new QuotaLedger(),
  /**
   * Task 7: the live tool-loop limits from the AI tuning settings
   * (`assistant.maxToolRounds`, `assistant.maxToolCalls`,
   * `assistant.maxOutputTokens`). Merged over the loop's defaults by
   * `runToolLoop` itself; absent means today's behaviour.
   */
  loopLimits: () => {
    readonly rounds?: number;
    readonly totalCalls?: number;
    readonly maxOutputTokens?: number;
  } = () => ({}),
): AssistantCommandService & {
  tryIt(input: AssistantTryItInput): Promise<AssistantTryItResult>;
} => {
  // The safety/spend boundary wraps whatever provider is in play, including a
  // test-injected one: no caller may bypass the pre-API scan (finding 2).
  //
  // ADR 0075: a test-injected provider becomes a one-entry chain so the rest
  // of this function has one code path regardless of where the provider came
  // from. It is never itself eligibility-checked here — that still happens
  // below, exactly as it did before the chain existed (ruling: "the
  // eligibility check still applies to it exactly as today").
  const currentChain = (): readonly ChainEntry[] => {
    const raw = testPorts.provider;
    if (raw === undefined) return chain();
    const current = liveConfig();
    const wrapped =
      raw instanceof SafeProvider
        ? raw
        : new SafeProvider(raw, current.AI_PROFILE_COST_CLASS, { monthlyCapUsdMicros: 0 });
    return [
      {
        providerId: raw.id as ProviderId,
        model: current.AI_MODEL ?? 'test-model',
        keyId: 'key_test',
        keyLabel: 'Test provider',
        provider: wrapped,
        skip: undefined,
        mayTrain: false,
        rpmLimit: null,
        rpdLimit: null,
      },
    ];
  };
  // Task 16: no per-request live fetching. The fetcher port stays so tests
  // can assert it is never called; the refresh job owns all network I/O.
  const fetchResource =
    testPorts.fetchResource ??
    (() => Promise.reject(new Error('live resource fetch is disabled; the cache owns reads')));
  /**
   * One ledger per service instance (per daemon, not per request): a spent
   * `:free` daily allowance stays spent for later requests until its reset.
   * Keys are instance-level, so the ledger is keyed by key id, not guild.
   * Task 8: the ledger arrives from the composition root so every guild
   * shares one process-wide instance; the default keeps isolated tests
   * independent.
   */
  const ledger = quotaLedger;
  /**
   * ADR 0090 D3: `from` (a member mention, id or name — model output, so
   * untrusted) resolves to exactly one member id in code. An exact
   * case-insensitive match on display name, global name or username wins;
   * otherwise a single lookup result is the match. Zero results, or several
   * without an exact match, refuse — as does a missing lookup port.
   */
  const resolveFromMember = async (
    from: string,
  ): Promise<
    | { readonly ok: true; readonly authorId: string }
    | { readonly ok: false; readonly problem: string }
  > => {
    const problem = "I couldn't tell which member you meant.";
    if (discord.findMember === undefined) return { ok: false, problem };
    let candidates: readonly FoundMember[];
    try {
      candidates = await discord.findMember(from);
    } catch {
      return { ok: false, problem };
    }
    const needle = from.trim().toLowerCase();
    const exact = candidates.filter((candidate) =>
      [candidate.displayName, candidate.globalName, candidate.username].some(
        (name) => name !== undefined && name.toLowerCase() === needle,
      ),
    );
    if (exact.length === 1) return { ok: true, authorId: exact[0]!.id };
    if (exact.length === 0 && candidates.length === 1)
      return { ok: true, authorId: candidates[0]!.id };
    return { ok: false, problem };
  };
  /** ADR 0067: archive hits from channels the member can view. Threads are left out. */
  const searchArchive = async (
    userId: string,
    answerChannelId: string | undefined,
    query: string,
    from?: string,
  ): Promise<ArchiveResult> => {
    if (query.trim() === '') return { ok: true, hits: [] };
    // ADR 0090 D3: with `from`, the search is scoped to one resolved member.
    let authorId: string | undefined;
    if (from !== undefined) {
      const resolved = await resolveFromMember(from);
      if (!resolved.ok) return resolved;
      authorId = resolved.authorId;
    }
    const visible = new Set((await discord.memberChannels(userId)).map((channel) => channel.id));
    // ADR 0090: an answer posted in a channel draws only on channels every
    // viewer of that channel can read. Try it has no channel, so it keeps
    // the asker-only filter; anything unknown fails closed to no channels.
    if (answerChannelId !== undefined) {
      if (discord.audienceChannels === undefined) return { ok: true, hits: [] };
      const audience = await discord.audienceChannels(answerChannelId);
      for (const id of visible) if (!audience.has(id)) visible.delete(id);
    }
    const channelIds = archiveRepo
      .listChannels(scope)
      .map((channel) => channel.channelId)
      .filter((id) => visible.has(id));
    if (channelIds.length === 0) return { ok: true, hits: [] };
    // A private thread inside a visible channel is not visible to every member
    // who can see the channel, and the archive does not record which threads
    // are private, so member-facing search leaves every thread out.
    const limit = from === undefined ? 16 : 3;
    const cap = from === undefined ? 8 : 3;
    return {
      ok: true,
      hits: archiveSearchRepo
        .searchMessages(scope, {
          query,
          visibility: { channelIds },
          ...(authorId === undefined ? {} : { authorId }),
          limit,
        })
        .hits.filter((hit) => hit.threadId === undefined)
        .slice(0, cap)
        .map((hit) => ({
          channelId: hit.channelId,
          messageId: hit.messageId,
          createdAt: hit.createdAt,
          excerpt: hit.excerpt,
        })),
    };
  };
  const invokeOnce = async (
    input: AssistantInvocation,
    sink: {
      trace?: Omit<InvocationTrace, 'latencyMs'>;
      detail?: AssistantTraceDetail;
      resourcesUnavailable?: boolean;
    },
    opts: {
      /** Task 20: Try-it is authorised by `config.write`, not caller roles. */
      skipCallerGate?: boolean;
      /** Task 20: Try-it never reads member memories. */
      skipMemberMemories?: boolean;
      /** Task 20: Try-it answers an escalation as text, never opening a ticket. */
      skipTicketWrite?: boolean;
      /**
       * Fix 1: Try-it (and any path without a durable invocation id) must
       * never act — acting skills gate off, so their tools stay undeclared
       * and refused.
       */
      skipActions?: boolean;
    } = {},
  ): Promise<AssistantInvocationResult> => {
    {
      const currentConfig = liveConfig();
      const chainEntries = currentChain();
      const citations = createCitationRegistry();
      const commandSkill: Record<AssistantInvocation['command'], string> = {
        ask: 'search-club',
        find: 'search-club',
        remind: 'reminders',
        remember: 'propose-memory',
        decision: 'record-decision',
        'review-plan': 'review-plan',
        onboard: 'onboarding-guide',
        agenda: 'draft-agenda',
        summarise: 'summarise-meeting',
        announce: 'draft-announcement',
        checklist: 'event-checklist',
        handoff: 'draft-handoff',
      };
      const skill = commandSkill[input.command];
      const owner = input.userId === config.BANANASAURS_OWNER_USER_ID;
      // Owners can complete first-run setup before any caller role is selected.
      // Everyone else still fails closed against the behaviour allowlist.
      // Try-it skips this gate: `config.write` already authorised the caller.
      if (
        !owner &&
        !opts.skipCallerGate &&
        !input.behaviour.callerRoleIds.some((roleId) => input.callerRoleIds.includes(roleId))
      )
        return {
          ok: false,
          content: 'This behaviour is not available to your server roles. No action was taken.',
        };
      // ADR 0087: the skill's scope is the only gate, checked in code
      // against the asker's live roles. The behaviour's preferred list never
      // grants or denies. Try-it counts as the owner for scopes
      // (`config.write` authorised the caller).
      const scopeOwner = owner || opts.skipCallerGate === true;
      const grants = new Map(
        assistantRepo.listSkillGrants(scope).map((grant) => [grant.skillId, grant]),
      );
      const skillAllowed = (id: string): boolean => {
        const catalogueSkill = CLUB_ASSISTANT_SKILLS.find((candidate) => candidate.id === id);
        if (catalogueSkill === undefined) return false;
        // Fix 1 (hard rule 6): acting tools need a durable idempotency key.
        // Try-it must never act, and neither can a path without an
        // invocation id — acting skills gate off, hiding their tools from
        // the declarations and refusing them if the model calls them anyway.
        if (catalogueSkill.acts && (opts.skipActions === true || input.invocationId === undefined))
          return false;
        return skillScopeAllows(effectiveSkillScope(catalogueSkill, grants.get(id)), {
          owner: scopeOwner,
          roleIds: input.callerRoleIds,
        });
      };
      const permittedSkills = CLUB_ASSISTANT_SKILLS.filter((candidate) =>
        skillAllowed(candidate.id),
      );
      // ADR 0087: catalogue skills the asker's scope denies, named plainly.
      // Not computed for skills hidden only by skipActions/missing invocation
      // id — the scope check alone decides. No directory port is in scope
      // here, so role reasons fall back to "only for certain roles".
      const cleanRoleToken = (name: string): string =>
        neutraliseMarkers(name)
          .replace(/[[\]\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const unavailableSkills: readonly {
        readonly skill: (typeof CLUB_ASSISTANT_SKILLS)[number];
        readonly reason: string;
      }[] = CLUB_ASSISTANT_SKILLS.filter((candidate) => {
        const scope = effectiveSkillScope(candidate, grants.get(candidate.id));
        return !skillScopeAllows(scope, { owner: scopeOwner, roleIds: input.callerRoleIds });
      }).map((candidate) => {
        const scope = effectiveSkillScope(candidate, grants.get(candidate.id));
        if (scope.mode === 'owner') return { skill: candidate, reason: 'owner only' };
        if (scope.mode === 'roles') {
          // No directory port in scope: names unavailable, reason stays plain.
          const names: readonly string[] = [];
          const cleaned = names.map(cleanRoleToken).filter((name) => name !== '');
          if (cleaned.length === 0) return { skill: candidate, reason: 'only for certain roles' };
          return { skill: candidate, reason: `only for ${cleaned.join(', ')}` };
        }
        return { skill: candidate, reason: 'only for certain roles' };
      });
      // B2b: every acting tool's port, closed over this request's guild scope
      // and asker. The invocation key is the Discord message or interaction
      // that asked — the durable idempotency anchor, so a retried job reuses
      // its keys. Empty on the no-actions path, where no acting tool can
      // run, so the empty key is never used.
      const invocationKey: string = input.invocationId ?? '';
      const resolveTargets = discord.resolveReminderTargets ?? defaultResolveReminderTargets;
      if (!skillAllowed(skill)) {
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'denied',
        });
        return {
          ok: false,
          content: "You don't have access to that assistant skill. No action was taken.",
        };
      }
      if (input.command === 'find') {
        // ADR 0067: the archive, limited to channels this member can view.
        // ADR 0090: and to the answer channel's audience.
        const searched = await searchArchive(
          input.userId,
          input.channelId,
          input.input.query ?? '',
        );
        const hits = searched.ok ? searched.hits : [];
        return {
          ok: true,
          content:
            hits.length === 0
              ? 'No matching messages in the channels you can see.'
              : hits
                  .map(
                    (hit) =>
                      `https://discord.com/channels/${scope.guildId}/${hit.channelId}/${hit.messageId}\n> ${hit.excerpt}`,
                  )
                  .join('\n')
                  .slice(0, 1_900),
        };
      }
      if (chainEntries.length === 0) {
        return {
          ok: false,
          content:
            'The free AI provider is not configured, so no content was sent outside the server.',
        };
      }
      // Hard rule 5 (ADR 0062): the provider_eligibility table is consulted
      // on the request path. A chain entry from `resolveModelChain` already
      // ran this exact check while building the chain — re-running it here
      // just re-reads the same row. Only a raw `testPorts.provider` never
      // went through the resolver, so it is the one path that still needs
      // its own check, run here for the first and only time.
      //
      // Task 6b (carried from Task 6's review): chain entries use
      // `ChainEntry.mayTrain` for the training warning instead; the warning
      // fires below, once the loop shows which entries were actually tried.
      const usingTestProvider = testPorts.provider !== undefined;
      if (usingTestProvider) {
        const provider = chainEntries[0]?.provider;
        if (provider !== undefined) {
          const eligibilityRow = eligibilityRepo.findEligibility(instance, provider.id);
          try {
            if (eligibilityRow === undefined)
              throw new Error(`no provider_eligibility row for ${provider.id}`);
            assertProviderEligible(
              {
                trainsOnInput: eligibilityRow.trainsOnInput,
                productionUseAllowed: eligibilityRow.productionUseAllowed,
                evidenceUrl: eligibilityRow.evidenceUrl,
                reviewedAt: new Date(eligibilityRow.reviewedAt).toISOString(),
              },
              'club',
            );
          } catch {
            assistantRepo.recordSkillActivity(scope, {
              id: randomUUID(),
              at: now(),
              behaviourId: input.behaviour.id,
              skillId: skill,
              actorId: input.userId,
              outcome: 'denied',
              detail: 'Provider terms are not recorded or do not allow this use.',
            });
            return {
              ok: false,
              content:
                "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
            };
          }
          if (providerMayTrain(eligibilityRow))
            logger.warn(
              safeLogFields({
                component: 'assistant',
                guildId: input.guildId,
                reason: 'provider-may-train',
              }),
              'assistant provider may train on server content',
            );
        }
      }
      // Task 16: no per-request live fetching. The prompt carries a short
      // catalogue (preferred first, at most 60 lines) plus up to four
      // pre-retrieved cache snippets; the model opens more via tools.
      // Task 20: an unreadable resource store must not fail the answer —
      // the model answers without evidence and the run is flagged
      // `resources-unavailable` instead.
      let resources: ReturnType<typeof assistantRepo.listResources> = [];
      let ordered: typeof resources = [];
      let catalogueLines: string[] = [];
      let preRetrieved: readonly {
        readonly resourceId: string;
        readonly chunkId: string;
        readonly docId: string;
        readonly headingPath: string;
        readonly snippet: string;
      }[] = [];
      try {
        resources = assistantRepo.listResources(scope).filter((r) => r.enabled);
        const emphasised = resources.filter((r) => input.behaviour.resourceIds.includes(r.id));
        ordered = [...emphasised, ...resources.filter((r) => !emphasised.includes(r))];
        const freshnessById = new Map(
          resourceCacheRepo.resourceFreshness(scope).map((f) => [f.resourceId, f.fetchedAt]),
        );
        catalogueLines = ordered.slice(0, 60).map((r) => {
          const fetchedAt = freshnessById.get(r.id);
          return `${r.id} · ${r.title} (${r.kind}) · updated ${relativeUpdated(fetchedAt, now())}`;
        });
        const memberQuestion = textOf(input.input).slice(0, 200);
        const searchCache =
          testPorts.cacheSearch ??
          ((query: string, resourceIds: readonly string[]) =>
            resourceCacheRepo.searchChunks(scope, { query, resourceIds, limit: 4 }));
        preRetrieved =
          memberQuestion.trim() === ''
            ? []
            : searchCache(
                memberQuestion,
                ordered.map((r) => r.id),
              );
      } catch {
        sink.resourcesUnavailable = true;
        resources = [];
        ordered = [];
        catalogueLines = [];
        preRetrieved = [];
      }
      const toolsAvailable = chainEntries.some(
        (entry) => entry.provider?.capabilities.has('tools') === true,
      );
      const byResourceId = new Map(resources.map((r) => [r.id, r]));
      const evidence = preRetrieved.map((hit) => {
        const resource = byResourceId.get(hit.resourceId);
        const text = redactEvidenceText(hit.snippet).text;
        return {
          sourceId: hit.resourceId,
          title: resource?.title ?? hit.resourceId,
          text,
          accessible: true,
          chunkId: hit.chunkId,
          citeTag: citations.tag({
            title: resource?.title ?? hit.resourceId,
            url: resource?.url ?? '',
            heading: hit.headingPath,
          }),
        };
      });
      const context = compileAssistantContext({
        behaviour: input.behaviour,
        serverCard:
          assistantRepo.getServerCard(scope) +
          // Try-it never reads member memories: the short-circuit keeps even
          // the preference read from happening.
          (opts.skipMemberMemories || assistantRepo.memoryPreference(scope, input.userId).optedOut
            ? ''
            : '\nCurated memory:\n' +
              assistantRepo
                .listMemories(scope)
                .filter(
                  (memory) => memory.subjectId === undefined || memory.subjectId === input.userId,
                )
                .map((memory) => '- ' + memory.content)
                .join('\n')),
        resources,
        evidence,
        skills: permittedSkills,
        preferredSkillIds: input.behaviour.preferredSkillIds,
        unavailableSkills,
        toolsAvailable,
        catalogueLines,
      });
      const isIt = input.behaviour.surface === 'it-services';
      const enqueueAssistantRefresh = (resourceId: string): boolean => {
        const tenMinuteBucket = Math.floor(now() / 600_000);
        const result = jobRepo.enqueue(scope, {
          kind: JOB_KINDS.resourceRefresh,
          payload: JSON.stringify({ resourceId, reason: 'assistant' }),
          dedupeKey: resourceRefreshDedupeKey({
            reason: 'assistant',
            resourceId,
            tenMinuteBucket,
          }),
          now: now(),
        });
        return result.enqueued;
      };
      const toolPorts: AssistantToolPorts = {
        userId: input.userId,
        guildId: scope.guildId,
        now,
        timeZone: currentConfig.BANANASAURS_TIME_ZONE,
        // Try-it counts as the owner for scope checks (`config.write`
        // authorised the caller), but `skipActions` hides every acting tool
        // there — this grants the owner view of scopes, never writes.
        isOwner: scopeOwner,
        skillAllowed,
        quotePresent:
          (input.quoteEnvelope !== undefined && input.quoteEnvelope !== '') ||
          input.quoteInHistory === true,
        invocationKey,
        currentChannelId: input.channelId,
        resolveReminderTargets: (req) =>
          resolveTargets({
            ...req,
            askerId: input.userId,
            currentChannelId: input.channelId ?? '',
          }),
        reminderStore: {
          insert: (reminder) =>
            assistantRepo.insertReminder(scope, { ...reminder, guildId: scope.guildId }),
          get: (id) => assistantRepo.getReminder(scope, id),
          update: (id, patch) => assistantRepo.updateReminder(scope, id, patch, now()),
          cancel: (id) => assistantRepo.cancelReminder(scope, id),
          listForCreator: (creatorId) =>
            assistantRepo.listRemindersForCreator(scope, creatorId, { includeFinished: true }),
          listAll: () => assistantRepo.listReminders(scope),
        },
        proposeDraft: (d) =>
          assistantRepo.insertDecisionDraftOnce(scope, {
            ...d,
            requesterId: input.userId,
            provenance: `Assistant ${d.kind} via chat; behaviour=${input.behaviour.id}`,
            at: now(),
          }),
        recordSkillActivity: (skillId, outcome, detail) =>
          assistantRepo.recordSkillActivity(scope, {
            id: randomUUID(),
            at: now(),
            behaviourId: input.behaviour.id,
            skillId,
            actorId: input.userId,
            outcome,
            ...(detail === undefined ? {} : { detail }),
          }),
        searchArchive: (query, from) => searchArchive(input.userId, input.channelId, query, from),
        resources: () => resources,
        fetchResource,
        webSearch:
          testPorts.webSearch ??
          (currentConfig.BRAVE_SEARCH_API_KEY === undefined
            ? undefined
            : (query: string) =>
                braveWebSearch({ apiKey: currentConfig.BRAVE_SEARCH_API_KEY! }, query)),
        serverCard: () => assistantRepo.getServerCard(scope),
        visibleChannels: () => discord.memberChannels(input.userId),
        cacheSearch: (q) =>
          resourceCacheRepo.searchChunks(scope, {
            query: q.query,
            ...(q.resourceIds === undefined ? {} : { resourceIds: q.resourceIds }),
            limit: q.limit,
          }),
        cacheChunk: (chunkId) => {
          const c = resourceCacheRepo.getChunk(scope, chunkId);
          return c === undefined
            ? undefined
            : {
                chunkId: c.chunkId,
                docId: c.docId,
                resourceId: c.resourceId,
                headingPath: c.headingPath,
                text: c.text,
              };
        },
        cacheNeighbours: (chunkId, n) =>
          resourceCacheRepo.neighbours(scope, chunkId, n).map((c) => ({
            chunkId: c.chunkId,
            docId: c.docId,
            resourceId: c.resourceId,
            headingPath: c.headingPath,
            text: c.text,
          })),
        cacheOutline: (docId) => resourceCacheRepo.outline(scope, docId),
        cacheDocument: (docId) => {
          const found = resourceCacheRepo.listDocuments(scope).find((d) => d.docId === docId);
          return found === undefined
            ? undefined
            : {
                docId: found.docId,
                resourceId: found.resourceId,
                title: found.title,
                url: found.url,
              };
        },
        cacheResourceDocs: (resourceId) =>
          resourceCacheRepo.listDocuments(scope, resourceId).map((d) => ({
            docId: d.docId,
            resourceId: d.resourceId,
            title: d.title,
            url: d.url,
          })),
        cacheResourceChunks: (docId, limit) =>
          resourceCacheRepo
            .outline(scope, docId)
            .slice(0, limit)
            .flatMap((row) => {
              const c = resourceCacheRepo.getChunk(scope, row.chunkId);
              return c === undefined
                ? []
                : [
                    {
                      chunkId: c.chunkId,
                      docId: c.docId,
                      resourceId: c.resourceId,
                      headingPath: c.headingPath,
                      text: c.text,
                    },
                  ];
            }),
        cacheFreshness: () => {
          const latest = new Map<string, number>();
          for (const row of resourceCacheRepo.resourceFreshness(scope)) {
            const { resourceId, fetchedAt } = row;
            // A never-fetched document carries no timestamp; it must not
            // break the freshness map — the catalogue then shows
            // "not fetched yet".
            if (fetchedAt === undefined) continue;
            const prev = latest.get(resourceId);
            if (prev === undefined || fetchedAt > prev) latest.set(resourceId, fetchedAt);
          }
          return [...latest].map(([resourceId, fetchedAt]) => ({ resourceId, fetchedAt }));
        },
        enqueueRefresh: enqueueAssistantRefresh,
      };
      const declarations = toolDeclarations(toolPorts);
      /**
       * A failed loop maps back to today's member-facing texts (ruling): a
       * daily cap throws so the job answers its reset reply; a busy last
       * attempt throws retryable so the job's spaced retries still apply;
       * eligibility-only skips are the terms refusal; other skips are "not
       * configured"; a guard failure answers the fixed text.
       *
       * When the loop acted before it failed, the confirmation is kept: the
       * reply carries the action summaries plus one short line that the rest
       * of the answer failed, instead of the bare failure reply.
       *
       * Every answered-or-refused mapping also carries the trace detail, so
       * the job persists what the model saw even when it refused.
       */
      const mapLoopFailure = (failed: LoopResult): AssistantInvocationResult => {
        const loopDetail = (): AssistantTraceDetail => ({
          sections: traceSections(context, historyForLoop, userText, input.quoteEnvelope),
          history: historyForLoop,
          attempts: failed.attempts,
          toolCalls: failed.toolCalls,
          usage: failed.usage,
          guard: failed.guard,
          included: {
            toolsOffered: [...failed.toolsOffered],
            snippetChunkIds: preRetrieved.map((hit) => hit.chunkId),
            quote:
              (input.quoteEnvelope !== undefined && input.quoteEnvelope !== '') ||
              input.quoteInHistory === true,
            historyTurns: historyForLoop.filter((message) => message.role === 'user').length,
            ...(input.channelMessages === undefined
              ? {}
              : { channelMessages: input.channelMessages }),
            ...(input.summaryVersion === undefined
              ? {}
              : { summaryVersion: input.summaryVersion }),
          },
        });
        if (failed.actionSummaries.length > 0) {
          const detail = loopDetail();
          return {
            ok: true,
            content: `${failed.actionSummaries.join('\n\n')}\n\nI couldn't finish the rest of that answer — please try again.`,
            detail: { ...detail, actions: [...failed.actionSummaries] },
          };
        }
        if (failed.localLimit !== undefined)
          throw new LocalLimitError(failed.localLimit.availableAt, failed.localLimit.code);
        if (failed.dailyQuota !== undefined) {
          throw new ProviderError('quota', 'free-model daily allowance exhausted', false, {
            quotaScope: 'daily-free',
            ...(failed.dailyQuota.resetAt === undefined
              ? {}
              : { resetAt: failed.dailyQuota.resetAt }),
          });
        }
        const tried = failed.attempts.filter((attempt) => attempt.outcome !== 'skipped');
        const lastTried = tried.at(-1);
        if (
          lastTried?.outcome === 'busy' ||
          lastTried?.outcome === 'rate-limit' ||
          lastTried?.outcome === 'timeout'
        ) {
          const kind =
            lastTried.outcome === 'rate-limit'
              ? ('rate-limit' as const)
              : lastTried.outcome === 'timeout'
                ? ('timeout' as const)
                : ('outage' as const);
          throw new ChainFailedError(
            kind,
            `Every assistant model failed — ${summarizeAttempts(failed.attempts)}`,
            true,
            failed.attempts,
          );
        }
        const allSkipped =
          failed.attempts.length > 0 &&
          failed.attempts.every((attempt) => attempt.outcome === 'skipped');
        if (
          allSkipped &&
          failed.attempts.every(
            (attempt) => attempt.reason === 'ineligible' || attempt.reason === 'unverified',
          )
        ) {
          assistantRepo.recordSkillActivity(scope, {
            id: randomUUID(),
            at: now(),
            behaviourId: input.behaviour.id,
            skillId: skill,
            actorId: input.userId,
            outcome: 'denied',
            detail: 'Provider terms are not recorded or do not allow this use.',
          });
          return {
            ok: false,
            content:
              "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
            detail: loopDetail(),
          };
        }
        if (failed.attempts.length === 0 || allSkipped) {
          return {
            ok: false,
            content:
              'The free AI provider is not configured, so no content was sent outside the server.',
            detail: loopDetail(),
          };
        }
        if (lastTried?.outcome === 'error' && lastTried.reason === 'empty-answer') {
          return {
            ok: false,
            content: "I couldn't finish that answer — please try again.",
            detail: loopDetail(),
          };
        }
        if (lastTried?.outcome === 'error') {
          // A non-guard failure keeps the last attempt's original error —
          // same kind, same retryable flag — so e.g. a non-daily `quota`
          // error is not normalised into `invalid-request`.
          if (failed.lastError instanceof ProviderError) throw failed.lastError;
          throw new ProviderError(
            'invalid-request',
            lastTried.reason ?? 'The assistant request failed.',
            false,
          );
        }
        // The old "I could not complete that request" fallback was
        // unreachable: every failed loop either threw or returned above. The
        // annotation makes that exhaustiveness a compile error if a new
        // attempt outcome ever appears.
        const unreachableOutcome: 'ok' | 'skipped' | undefined = lastTried?.outcome;
        throw new Error(`unreachable assistant loop failure: ${String(unreachableOutcome)}`);
      };
      // Task 14: the job-built conversation history travels ahead of the
      // current user text. Absent (or empty) means a history-free request.
      const historyForLoop: readonly GenerationMessage[] = input.history ?? [];
      const userText = buildUserMessage({
        question: sanitizeMentionsForProvider(stripNewTopic(textOf(input.input))),
        askerName: input.askerName,
        channelContext: input.channelContext,
        evidenceEnvelope: context.evidenceEnvelope,
        quoteEnvelope: input.quoteEnvelope,
      });
      // ADR 0081: every provider call is reserved against its chain entry's
      // owner-set RPM/RPD limits first; a refused entry is skipped without
      // being called. The `.env` seed has no stored key, so it is never
      // limited and never recorded.
      const reserveCall = (entry: ChainEntry) =>
        reserveEntryCall(instance, entry, scope.guildId, now());
      // Task 20: the sources line contains only known resources whose tags the
      // answer actually used. A web-only answer keeps just the Brave attribution.
      const knownResource = new Set(resources.map((r) => `${r.title}${r.url}`));
      // The same check gates the loop's "Cite as" tags: only enabled,
      // known resources are citable, so an untrusted title never prints raw.
      const isKnownResource = (source: { title: string; url: string }): boolean =>
        knownResource.has(`${source.title}${source.url}`);
      const loop = await runToolLoop({
        chain: chainEntries,
        systemInstruction:
          context.systemInstruction +
          (isIt
            ? '\nIf this request needs a human action, permission, or review, start the response with exactly ESCALATE: followed by a safe summary. Never include credentials.'
            : '') +
          (input.command === 'decision' || input.command === 'review-plan'
            ? '\nReturn analysis as a DRAFT. State that it is not club policy and has not been saved. Do not claim persistence.'
            : ''),
        protectedText: context.protectedText,
        history: historyForLoop,
        userText,
        // Task 16: every catalogue id plus the pre-retrieved chunk and doc
        // ids may be opened in a follow-up round.
        initialHandles: [
          ...ordered.slice(0, 60).map((resource) => resource.id),
          ...preRetrieved.flatMap((hit) => [hit.chunkId, hit.docId]),
        ],
        tools: {
          firstRound: declarations,
          idRound: declarations.filter((d) => d.name in ID_TOOL_ARGS),
          // ADR 0090 D3: the tool result's own sources seed the known set,
          // so `isKnownResource` accepts exactly the message links code
          // issued in this request — nothing the model writes can add one.
          run: async (call) => {
            const result = await runAssistantTool(call, toolPorts, citations);
            if (result.ok && call.name === 'search_archive') {
              for (const source of result.sources)
                knownResource.add(`${source.title}${source.url}`);
            }
            return result;
          },
        },
        limits: loopLimits(),
        quotaLedger: ledger,
        reserveCall,
        logger,
        guildId: scope.guildId,
        now,
        citations,
        isCitable: isKnownResource,
      });
      // The loop records exactly one attempt per entry, in chain order, so
      // each attempt lines up with the entry that produced it.
      let warnedMayTrain = false;
      loop.attempts.forEach((attempt, index) => {
        if (
          attempt.outcome !== 'skipped' &&
          chainEntries[index]?.mayTrain === true &&
          !warnedMayTrain
        ) {
          warnedMayTrain = true;
          logger.warn(
            safeLogFields({
              component: 'assistant',
              guildId: input.guildId,
              reason: 'provider-may-train',
            }),
            'assistant provider may train on server content',
          );
        }
      });
      if (loop.outcome === 'failed') return mapLoopFailure(loop);
      const BRAVE_ATTRIBUTION = '\n\n-# Powered by Brave Search';
      const { text: citedText, cited } = applyCitations(loop.text, citations);
      // B2b: code-written action summaries travel verbatim — after the answer
      // text, before the Brave attribution and the Sources line — never
      // through the model.
      const summaryBlock =
        loop.actionSummaries.length === 0 ? '' : `\n\n${loop.actionSummaries.join('\n\n')}`;
      // The escalation summary is built from the loop text below — before
      // the sources line is appended — so a ticket never carries it. Only a
      // normal answer grows the line.
      const baseAnswer = loop.web
        ? `${citedText}${summaryBlock}${BRAVE_ATTRIBUTION}`
        : `${citedText}${summaryBlock}`;
      const answerText =
        baseAnswer +
        sourcesLine(
          cited.filter(isKnownResource).map((source) => ({
            title: source.title,
            url: source.url,
            ...(source.heading === undefined ? {} : { heading: source.heading }),
          })),
        );
      sink.detail = {
        sections: traceSections(context, historyForLoop, userText, input.quoteEnvelope),
        history: historyForLoop,
        attempts: loop.attempts,
        toolCalls: loop.toolCalls,
        usage: loop.usage,
        guard: loop.guard,
        included: {
          toolsOffered: [...loop.toolsOffered],
          snippetChunkIds: preRetrieved.map((hit) => hit.chunkId),
          quote:
            (input.quoteEnvelope !== undefined && input.quoteEnvelope !== '') ||
            input.quoteInHistory === true,
          historyTurns: historyForLoop.filter((message) => message.role === 'user').length,
          ...(input.channelMessages === undefined
            ? {}
            : { channelMessages: input.channelMessages }),
          ...(input.summaryVersion === undefined
            ? {}
            : { summaryVersion: input.summaryVersion }),
        },
        ...(loop.model === undefined ? {} : { model: loop.model }),
        ...(loop.finishReason === undefined ? {} : { finishReason: loop.finishReason }),
        ...(loop.web ? { web: true } : {}),
        ...(loop.answeredBy === undefined ? {} : { answeredBy: { ...loop.answeredBy } }),
        // B2b: the summaries appended to the posted answer, in call order.
        ...(loop.actionSummaries.length === 0 ? {} : { actions: [...loop.actionSummaries] }),
      };
      sink.trace = {
        ...(loop.model === undefined ? {} : { model: loop.model }),
        tools: loop.toolCalls.map(({ name, ok }) => ({ name, ok })),
        sources: [
          ...preRetrieved.map((hit) => ({
            title: byResourceId.get(hit.resourceId)?.title ?? hit.resourceId,
            url: byResourceId.get(hit.resourceId)?.url ?? '',
          })),
          ...loop.sources,
        ],
        web: loop.web,
        usedFallback: loop.attempts.length > 1,
      };
      assistantRepo.recordSkillActivity(scope, {
        id: randomUUID(),
        at: now(),
        behaviourId: input.behaviour.id,
        skillId: skill,
        actorId: input.userId,
        outcome: 'completed',
        // Task 20: the one observable trace of an unreadable cache on the
        // Discord path, where the stored trace's flags are the job's to write.
        ...(sink.resourcesUnavailable === true ? { detail: 'resources-unavailable' } : {}),
      });
      if (input.command === 'remember') {
        const id = `memory-${randomUUID()}`;
        assistantRepo.insertDecisionDraft(scope, {
          id,
          kind: 'memory',
          summary: answerText.slice(0, 4_000),
          requesterId: input.userId,
          provenance: `Assistant memory proposal; behaviour=${input.behaviour.id}; resources=${context.disclosurePlan.join(',') || 'none'}`,
          at: now(),
        });
        return {
          ok: true,
          content: `${answerText}

Memory proposal ID: ${id}. Nothing was added to memory. An owner must review and save it in the dashboard.`,
        };
      }
      if (input.command === 'decision' || input.command === 'review-plan') {
        const id = `${input.command}-${randomUUID()}`;
        assistantRepo.insertDecisionDraft(scope, {
          id,
          kind: input.command,
          summary: answerText.slice(0, 4_000),
          requesterId: input.userId,
          provenance: `Discord ${input.source}; behaviour=${input.behaviour.id}; resources=${context.disclosurePlan.join(',') || 'none'}`,
          at: now(),
        });
        return {
          ok: true,
          content: `${answerText}

Draft ID: ${id}. This is analysis, not club policy. An owner must review and save it from the dashboard.`,
        };
      }
      if (isIt && baseAnswer.startsWith('ESCALATE:')) {
        if (
          input.behaviour.ticketChannelId === undefined ||
          input.behaviour.reviewerRoleIds.length === 0
        )
          return {
            ok: false,
            content:
              'This needs human action, but IT ticket routing is not fully configured. No ticket was created.',
          };
        const summary = baseAnswer.slice('ESCALATE:'.length).trim().slice(0, 1_500);
        // Task 20: Try-it answers the escalation as text — opening a real
        // ticket from a dashboard test would page reviewers for nothing.
        if (opts.skipTicketWrite === true) return { ok: true, content: summary };
        const ticketId = `it-${randomUUID()}`;
        const created = assistantRepo.insertTicket(scope, {
          id: ticketId,
          behaviourId: input.behaviour.id,
          channelId: input.behaviour.ticketChannelId,
          requesterId: input.userId,
          summary,
          // Hard rule 6, same posture as reminders: the dedupe anchor is
          // the Discord interaction or message that produced the
          // escalation, so a retried invocation cannot open the ticket
          // twice and two genuinely different requests never collide on
          // byte-identical model text (review cosmetic).
          dedupeKey: `it:${scope.guildId}:${input.invocationId ?? ticketId}`,
          at: now(),
        });
        if (!created)
          return {
            ok: true,
            content: 'That IT request is already open. I did not create a duplicate.',
          };
        return {
          ok: true,
          content: summary,
          escalation: {
            channelId: input.behaviour.ticketChannelId,
            reviewerRoleIds: input.behaviour.reviewerRoleIds,
            ticketId,
          },
        };
      }
      return { ok: true, content: answerText };
    }
  };
  return {
    behavioursForGuild: () => Promise.resolve(assistantRepo.listBehaviours(scope)),
    async invoke(input: AssistantInvocation) {
      const started = now();
      const sink: {
        trace?: Omit<InvocationTrace, 'latencyMs'>;
        detail?: AssistantTraceDetail;
        resourcesUnavailable?: boolean;
      } = {};
      const result = await invokeOnce(input, sink);
      // Task 20: the Discord path's stored trace is the job's to write, so
      // the flag travels on the result (see `AssistantInvocationResult.flags`).
      const flags = sink.resourcesUnavailable === true ? ['resources-unavailable'] : [];
      return {
        ...result,
        ...(flags.length === 0 ? {} : { flags: [...(result.flags ?? []), ...flags] }),
        trace: { ...sink.trace, latencyMs: now() - started },
        ...(sink.detail === undefined ? {} : { detail: sink.detail }),
      };
    },
    /**
     * Task 20: dashboard Try-it — the same pipeline as `invoke`, but the
     * caller is a dashboard operator (authorised by `config.write`, not
     * caller roles), nothing is posted to Discord, no typing is sent, and
     * member memories are never read. The conversation and trace are stored
     * with `source: 'dashboard-test'` under the bot's own user id (the
     * columns require a Discord snowflake); the trace flag
     * `dashboard-account:<username>` says who really asked. The per-request
     * rate limit lives in the HTTP route, not here.
     */
    async tryIt(input: AssistantTryItInput): Promise<AssistantTryItResult> {
      const started = now();
      const behaviour = assistantRepo.listBehaviours(scope).find((b) => b.id === input.behaviourId);
      if (behaviour === undefined) throw new Error('unknown-behaviour');
      if (!behaviour.enabled) throw new Error('behaviour-disabled');
      const botUserId = config.DISCORD_APPLICATION_ID;
      const question = input.question;
      let conversationId = input.conversationId;
      if (
        conversationId === undefined ||
        conversationRepo.getConversation(scope, conversationId) === undefined
      ) {
        conversationId = `try_${randomUUID()}`;
        const title = question.slice(0, 120);
        conversationRepo.createConversation(scope, {
          conversationId,
          // No Discord channel is involved; the bot id is a valid snowflake
          // that satisfies the column CHECK.
          channelId: botUserId,
          behaviourId: behaviour.id,
          startedBy: botUserId,
          title: title === '' ? 'Dashboard try-it' : title,
          source: 'dashboard-test',
          at: now(),
        });
      }
      const stampAfter = (turns: readonly { readonly at: number }[]): number =>
        Math.max(now(), ...turns.map((turn) => turn.at + 1));
      const userTurnId = `try_${randomUUID()}_u`;
      conversationRepo.appendTurn(scope, {
        conversationId,
        turnId: userTurnId,
        at: stampAfter(conversationRepo.listTurns(scope, conversationId)),
        role: 'user',
        authorId: botUserId,
        authorName: input.accountUsername,
        text: question,
      });
      // The conversation so far (never the turn just written) travels ahead
      // of the current question — the same 12-turn / 6,000-character window
      // the Discord path gets.
      const history: GenerationMessage[] = conversationRepo
        .recentTurns(scope, conversationId, { maxTurns: 12, maxChars: 6_000 })
        .flatMap<GenerationMessage>((turn) =>
          turn.turnId === userTurnId || (turn.role !== 'user' && turn.role !== 'assistant')
            ? []
            : turn.role === 'user'
              ? [{ role: 'user', text: labelUserTurn(turn, now()) }]
              : [{ role: turn.role, text: turn.text }],
        );
      const sink: {
        trace?: Omit<InvocationTrace, 'latencyMs'>;
        detail?: AssistantTraceDetail;
        resourcesUnavailable?: boolean;
      } = {};
      const traceId = `try_${randomUUID()}`;
      let result: AssistantInvocationResult;
      let outcome: AssistantTrace['outcome'] = 'answered';
      try {
        result = await invokeOnce(
          {
            guildId: scope.guildId,
            channelId: undefined,
            userId: botUserId,
            callerRoleIds: [],
            behaviour,
            command: 'ask',
            input: { question },
            // Neither fits exactly — no Discord message or interaction is
            // involved — but the field requires one; the stored trace says
            // `dashboard-test` regardless.
            source: 'slash-command',
            invocationId: userTurnId,
            history,
            askerName: input.accountUsername,
          },
          sink,
          {
            skipCallerGate: true,
            skipMemberMemories: true,
            skipTicketWrite: true,
            // Fix 1: the dashboard sandbox never posts to Discord, so it
            // never acts either — no reminders, drafts, or tickets.
            skipActions: true,
          },
        );
        if (!result.ok) outcome = 'refused';
      } catch (err) {
        outcome = 'failed';
        if (err instanceof LocalLimitError) {
          result = {
            ok: false,
            content: localLimitReply(err.availableAt, now(), config.BANANASAURS_TIME_ZONE),
          };
        } else if (err instanceof ProviderError && err.quotaScope === 'daily-free') {
          result = { ok: false, content: dailyQuotaReply(err.resetAt, now()) };
        } else if (err instanceof ProviderError && err.retryable) {
          result = { ok: false, content: BUSY_REPLY };
        } else {
          logger.warn(
            safeLogFields({ component: 'assistant', guildId: scope.guildId, err }),
            'dashboard try-it failed before a response was produced',
          );
          result = {
            ok: false,
            content: 'I could not complete that request. No action was taken.',
          };
        }
      }
      const assistantTurnId = `try_${randomUUID()}_a`;
      conversationRepo.appendTurn(scope, {
        conversationId,
        turnId: assistantTurnId,
        at: stampAfter(conversationRepo.listTurns(scope, conversationId)),
        role: 'assistant',
        authorName: 'Bananasaurs',
        text: result.content,
        traceId,
      });
      const detail = result.detail;
      traceRepo.insertTrace(scope, {
        traceId,
        at: now(),
        userId: botUserId,
        behaviourId: behaviour.id,
        command: 'ask',
        source: 'dashboard-test',
        conversationId,
        turnId: assistantTurnId,
        question,
        answer: result.content,
        outcome,
        durationMs: Math.max(0, now() - started),
        attempts: detail?.attempts ?? [],
        ...(detail?.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
        usage: detail?.usage ?? {},
        sections: detail?.sections ?? [],
        toolCalls: detail?.toolCalls ?? [],
        guard: detail?.guard ?? { removed: [] },
        ...(detail?.included === undefined
          ? {}
          : {
              included: {
                toolsOffered: [...detail.included.toolsOffered],
                snippetChunkIds: [...detail.included.snippetChunkIds],
                quote: detail.included.quote,
                historyTurns: detail.included.historyTurns,
                ...(detail.included.channelMessages === undefined
                  ? {}
                  : { channelMessages: detail.included.channelMessages }),
                ...(detail.included.summaryVersion === undefined
                  ? {}
                  : { summaryVersion: detail.included.summaryVersion }),
              },
            }),
        timeline: [
          { label: 'received', atMs: 0 },
          { label: 'answered', atMs: Math.max(0, now() - started) },
        ],
        discordMessageIds: [],
        sources: [...(result.trace?.sources ?? [])],
        flags: [
          `dashboard-account:${input.accountUsername}`,
          ...(sink.resourcesUnavailable === true ? ['resources-unavailable'] : []),
        ],
      });
      return { answer: result.content, traceId, conversationId };
    },
  };
};
