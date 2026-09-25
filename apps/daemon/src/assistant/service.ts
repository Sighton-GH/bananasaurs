import { randomUUID } from 'node:crypto';
import {
  assertProviderEligible,
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  estimateTokens,
  JOB_KINDS,
  providerMayTrain,
  ProviderError,
  redactEvidenceText,
  resourceRefreshDedupeKey,
  SafeProvider,
  safeLogFields,
  stripNewTopic,
  type AssistantTrace,
  type CompiledAssistantContext,
  type Config,
  type GenerationMessage,
  type Logger,
  type TextProvider,
  validateReminderDraft,
} from '@bananasaurs/core';
import {
  archiveRepo,
  archiveSearchRepo,
  assistantRepo,
  eligibilityRepo,
  jobRepo,
  resourceCacheRepo,
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
import { type ChainEntry, type ProviderId } from './model-chain.js';
import { ID_TOOL_ARGS, runToolLoop, type LoopResult } from './tool-loop.js';
import { QuotaLedger } from './quota-ledger.js';
import {
  runAssistantTool,
  relativeUpdated,
  toolDeclarations,
  type ArchiveHit,
  type AssistantToolPorts,
  type WebResult,
} from './tools.js';
import type { ReviewedResourceFetcher } from './resource-fetcher.js';
const textOf = (input: Readonly<Record<string, string>>): string => Object.values(input).join('\n');
/**
 * Raw Discord mention snowflakes carry no meaning to a provider and trip the
 * conservative outbound scan's long-digit detectors, so they are flattened to
 * readable tokens before anything leaves the process. Only the mention shape
 * is rewritten; bare numbers stay untouched.
 */
export const sanitizeMentionsForProvider = (text: string): string =>
  text
    .replace(/<@&\d{17,20}>/g, '@role')
    .replace(/<@!?\d{17,20}>/g, '@user')
    .replace(/<#\d{17,20}>/g, '#channel');

/**
 * Task 14: the trace's `sections` are the compiled context sections as
 * `context.ts` names them, plus `history` when history was sent (ruling).
 * The quoted envelope is user text, not a section — like the evidence
 * envelope it travels in the messages, never the system instruction.
 */
const traceSections = (
  context: CompiledAssistantContext,
  history: readonly GenerationMessage[],
): AssistantTrace['sections'] => {
  const sections = context.sections.map((section) => ({
    name: section.name,
    chars: section.text.length,
    estTokens: estimateTokens(section.text),
    text: section.text,
  }));
  if (history.length === 0) return sections;
  const text = history.map((message) => `${message.role}: ${message.text}`).join('\n\n');
  return [
    ...sections,
    { name: 'history', chars: text.length, estTokens: estimateTokens(text), text },
  ];
};
export interface AssistantServiceTestPorts {
  readonly provider?: TextProvider | undefined;
  readonly fetchResource?:
    ((url: string) => ReturnType<ReviewedResourceFetcher['fetch']>) | undefined;
  /** Replaces Brave's HTTP call in tests. */
  readonly webSearch?: ((query: string) => Promise<readonly WebResult[]>) | undefined;
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
}
export const createAssistantService = (
  scope: GuildScope,
  instance: InstanceScope,
  config: Config,
  now: () => number,
  testPorts: AssistantServiceTestPorts = {},
  liveConfig: () => Config = () => config,
  logger: Pick<Logger, 'warn'> = { warn: () => undefined },
  discord: AssistantDiscordPorts = { memberChannels: () => Promise.resolve([]) },
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
): AssistantCommandService => {
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
  /** ADR 0067: archive hits from channels the member can view. Threads are left out. */
  const searchArchive = async (userId: string, query: string): Promise<readonly ArchiveHit[]> => {
    if (query.trim() === '') return [];
    const visible = new Set((await discord.memberChannels(userId)).map((channel) => channel.id));
    const channelIds = archiveRepo
      .listChannels(scope)
      .map((channel) => channel.channelId)
      .filter((id) => visible.has(id));
    if (channelIds.length === 0) return [];
    // A private thread inside a visible channel is not visible to every member
    // who can see the channel, and the archive does not record which threads
    // are private, so member-facing search leaves every thread out.
    return archiveSearchRepo
      .searchMessages(scope, { query, visibility: { channelIds }, limit: 16 })
      .hits.filter((hit) => hit.threadId === undefined)
      .slice(0, 8)
      .map((hit) => ({
        channelId: hit.channelId,
        messageId: hit.messageId,
        createdAt: hit.createdAt,
        excerpt: hit.excerpt,
      }));
  };
  const invokeOnce = async (
    input: AssistantInvocation,
    sink: { trace?: Omit<InvocationTrace, 'latencyMs'>; detail?: AssistantTraceDetail },
  ): Promise<AssistantInvocationResult> => {
    {
      const currentConfig = liveConfig();
      const chainEntries = currentChain();
      const commandSkill: Record<AssistantInvocation['command'], string> = {
        ask: 'search-club',
        find: 'search-club',
        remind: 'create-reminder',
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
      if (
        !owner &&
        !input.behaviour.callerRoleIds.some((roleId) => input.callerRoleIds.includes(roleId))
      )
        return {
          ok: false,
          content: 'This behaviour is not available to your server roles. No action was taken.',
        };
      if (!input.behaviour.allowedSkillIds.includes(skill))
        return {
          ok: false,
          content: `This behaviour is not allowed to use ${skill}. No action was taken.`,
        };
      // ADR 0064: passing the behaviour's "Who can ask" allows every skill in
      // its allowlist. Owner-only skills stay owner-only; per-skill grants are
      // no longer a gate.
      const permittedSkills = CLUB_ASSISTANT_SKILLS.filter(
        (candidate) =>
          input.behaviour.allowedSkillIds.includes(candidate.id) &&
          (owner || candidate.ownerOnly !== true),
      );
      if (!permittedSkills.some((candidate) => candidate.id === skill)) {
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'denied',
          detail: 'The skill is owner-only.',
        });
        return {
          ok: false,
          content: 'Only the server owner can use this assistant skill. No action was taken.',
        };
      }
      if (input.command === 'remind') {
        // A reminder needs a real destination channel. Falling back to the
        // user id produced a row that could never be delivered while the
        // reply said "Reminder scheduled" (finding 7).
        if (input.channelId === undefined)
          return {
            ok: false,
            content: 'Reminders must run in a server channel. No reminder was scheduled.',
          };
        // The same validation every reminder write goes through (finding 8)
        // - the slash path shares `createReminder`'s checks instead of
        // carrying its own copy.
        const draft = validateReminderDraft(
          { dueAt: Date.parse(input.input.when ?? ''), text: input.input.text ?? '' },
          now(),
        );
        if (!draft.ok)
          return {
            ok: false,
            content: `${draft.error.charAt(0).toUpperCase()}${draft.error.slice(1)}. No reminder was scheduled.`,
          };
        const text = draft.text;
        const dueAt = Date.parse(input.input.when ?? '');
        const id = randomUUID();
        // Hard rule 6: the dedupe key is the Discord interaction or message
        // that asked for the reminder, not a fresh UUID, so a retried
        // interaction cannot book the same reminder twice (finding 7).
        const dedupeKey = `reminder:${scope.guildId}:${input.invocationId ?? id}`;
        // The dedupe-key conflict comes back as a typed repo result: only
        // that exact replay is the benign "already scheduled" answer, and a
        // real write failure still throws instead of reading as success
        // (should-fix; typed per the independent audit, round 2).
        const insert = assistantRepo.insertReminder(scope, {
          id,
          guildId: scope.guildId,
          creatorId: input.userId,
          destinationId: input.channelId,
          text,
          dueAt,
          createdAt: now(),
          status: 'scheduled',
          dedupeKey,
        });
        if (insert === 'duplicate') {
          return {
            ok: true,
            content: 'That reminder is already scheduled. I did not create a duplicate.',
          };
        }
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'completed',
        });
        return {
          ok: true,
          content: `Reminder scheduled for ${new Date(dueAt).toLocaleString('en-CA')}.`,
        };
      }
      if (input.command === 'find') {
        // ADR 0067: the archive, limited to channels this member can view.
        const hits = await searchArchive(input.userId, input.input.query ?? '');
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
      const resources = assistantRepo.listResources(scope).filter((r) => r.enabled);
      const emphasised = resources.filter((r) => input.behaviour.resourceIds.includes(r.id));
      const ordered = [...emphasised, ...resources.filter((r) => !emphasised.includes(r))];
      const toolsAvailable = chainEntries.some(
        (entry) => entry.provider?.capabilities.has('tools') === true,
      );
      const freshnessById = new Map(
        resourceCacheRepo.resourceFreshness(scope).map((f) => [f.resourceId, f.fetchedAt]),
      );
      const catalogueLines = ordered.slice(0, 60).map((r) => {
        const fetchedAt = freshnessById.get(r.id);
        return `${r.id} · ${r.title} (${r.kind}) · updated ${relativeUpdated(fetchedAt, now())}`;
      });
      const memberQuestion = textOf(input.input).slice(0, 200);
      const preRetrieved =
        memberQuestion.trim() === ''
          ? []
          : resourceCacheRepo.searchChunks(scope, {
              query: memberQuestion,
              resourceIds: ordered.map((r) => r.id),
              limit: 4,
            });
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
        };
      });
      const context = compileAssistantContext({
        behaviour: input.behaviour,
        serverCard:
          assistantRepo.getServerCard(scope) +
          (assistantRepo.memoryPreference(scope, input.userId).optedOut
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
        now,
        timeZone: currentConfig.BANANASAURS_TIME_ZONE,
        searchArchive: (query) => searchArchive(input.userId, query),
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
        reminders: () => assistantRepo.listReminders(scope),
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
       * Every answered-or-refused mapping also carries the trace detail, so
       * the job persists what the model saw even when it refused.
       */
      const mapLoopFailure = (failed: LoopResult): AssistantInvocationResult => {
        const loopDetail = (): AssistantTraceDetail => ({
          sections: traceSections(context, historyForLoop),
          history: historyForLoop,
          attempts: failed.attempts,
          toolCalls: failed.toolCalls,
          usage: failed.usage,
          guard: failed.guard,
        });
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
          throw new ProviderError(
            kind,
            `Every assistant model is busy (${lastTried.outcome})`,
            true,
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
        userText: [
          sanitizeMentionsForProvider(stripNewTopic(textOf(input.input))),
          context.evidenceEnvelope,
          ...(input.quoteEnvelope === undefined ? [] : [input.quoteEnvelope]),
        ]
          .filter(Boolean)
          .join('\n\n'),
        // Task 16: every catalogue id plus the pre-retrieved chunk and doc
        // ids may be opened in a follow-up round.
        initialHandles: [
          ...ordered.slice(0, 60).map((resource) => resource.id),
          ...preRetrieved.flatMap((hit) => [hit.chunkId, hit.docId]),
        ],
        tools: {
          firstRound: declarations,
          idRound: declarations.filter((d) => d.name in ID_TOOL_ARGS),
          run: (call) => runAssistantTool(call, toolPorts),
        },
        quotaLedger: ledger,
        now,
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
      const answerText = loop.web ? `${loop.text}${BRAVE_ATTRIBUTION}` : loop.text;
      sink.detail = {
        sections: traceSections(context, historyForLoop),
        history: historyForLoop,
        attempts: loop.attempts,
        toolCalls: loop.toolCalls,
        usage: loop.usage,
        guard: loop.guard,
        ...(loop.model === undefined ? {} : { model: loop.model }),
        ...(loop.finishReason === undefined ? {} : { finishReason: loop.finishReason }),
        ...(loop.web ? { web: true } : {}),
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
      if (isIt && answerText.startsWith('ESCALATE:')) {
        if (
          input.behaviour.ticketChannelId === undefined ||
          input.behaviour.reviewerRoleIds.length === 0
        )
          return {
            ok: false,
            content:
              'This needs human action, but IT ticket routing is not fully configured. No ticket was created.',
          };
        const summary = answerText.slice('ESCALATE:'.length).trim().slice(0, 1_500);
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
      const sink: { trace?: Omit<InvocationTrace, 'latencyMs'>; detail?: AssistantTraceDetail } =
        {};
      const result = await invokeOnce(input, sink);
      return {
        ...result,
        trace: { ...sink.trace, latencyMs: now() - started },
        ...(sink.detail === undefined ? {} : { detail: sink.detail }),
      };
    },
  };
};
