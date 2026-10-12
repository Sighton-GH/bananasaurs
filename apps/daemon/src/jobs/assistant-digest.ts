import {
  assistantDailyDigestPayload,
  buildDigestInput,
  DIGEST_DEFAULT_MAX_PROPOSALS,
  DIGEST_SYSTEM_INSTRUCTION,
  digestOutputSchema,
  JOB_KINDS,
  localDayBounds,
  MAX_DIGEST_SUMMARY_WORDS,
  neutraliseMarkers,
  normalizeProposalText,
  orderChainByTier,
  redactEvidenceText,
  safeDisplayName,
  safeLogFields,
  splitDigestInput,
  truncateWords,
  type AssistantDailyDigestPayload,
  type ChainTier,
  type DigestOutput,
  type JobHandler,
  type Logger,
} from '@bananasaurs/core';
import {
  assistantRepo,
  digestRepo,
  runRepo,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import type { ChainEntry } from '../assistant/model-chain.js';

/**
 * First usable entry in the forced tier's order (ADR 0150 decision 2, via
 * Slice 6's `orderChainByTier`). Shared with the summaries closure in
 * `runtime/guild.ts` (S5-T14): background jobs never run the router, so both
 * read their tier from `backgroundTier` and pick here.
 */
export const pickBackgroundEntry = (
  entries: readonly ChainEntry[],
  tier: ChainTier,
): ChainEntry | undefined =>
  orderChainByTier(entries, tier).find(
    (entry) => entry.provider !== undefined && entry.skip === undefined,
  );

/**
 * The model call the digest runs (ADR 0150 decision 2). `{ ok: false }` is a
 * completed failure, never a retry: the failure is recorded on the run and
 * the next local day enqueues fresh.
 */
export type DigestModelPort = (req: {
  readonly systemInstruction: string;
  readonly text: string;
}) => Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }
>;

export interface DigestDeps {
  readonly now: () => number;
  readonly logger: Logger;
  readonly timeZone: () => string;
  readonly botUserId: string;
  /** Slice 6's forced tier for this job — wired to `backgroundTier('daily-digest')` in guild.ts. */
  readonly forcedTier: () => ChainTier;
  readonly digestModel: DigestModelPort;
  readonly digestEnabled: () => boolean;
  readonly digestInputChars: () => number;
  readonly digestMaxProposals: () => number;
}

const EMPTY_SUMMARY = 'No assistant conversations that day.';

/**
 * This job's own block markers. `neutraliseMarkers` covers the shared request
 * markers only, so a title, summary, name or turn carrying `[CONVERSATION ...]`
 * or `[/CONVERSATION]` could forge a block boundary in the model input
 * (lead repair, review A major 2). Turn them into inert text.
 */
const neutraliseDigestMarkers = (text: string): string =>
  text.replace(/\[(\/?)CONVERSATION/gi, '[$1conversation-block');

const cleanForModel = (text: string): string =>
  neutraliseDigestMarkers(neutraliseMarkers(redactEvidenceText(text).text));

const speakerOf = (authorName: string, role: string): string => {
  if (role === 'assistant') return 'bot';
  const cleaned = safeDisplayName(authorName);
  // A name that trips the redaction filter (email, phone, key) is not sent at
  // all: the provider's outbound scan would refuse the whole day (lead
  // repair, review A major 1).
  if (
    cleaned === undefined ||
    /^\d{17,20}$/.test(cleaned) ||
    redactEvidenceText(cleaned).text !== cleaned
  ) {
    return 'a member';
  }
  return neutraliseDigestMarkers(cleaned);
};

/**
 * Deviation (review round 1, HIGH 2): the digest row and its full draft set
 * land in ONE storage transaction. `digestRepo.putDigestOnce` and
 * `assistantRepo.insertDecisionDraftOnce` each open their own transaction and
 * this task owns no storage file, so the insert shapes are replicated here
 * field for field (envelope, `summaryText` render, conflict targets). A throw
 * on any insert rolls the whole set back, so a replay can never find the
 * digest row without its proposals.
 */
const renderDigestText = (
  summary: DigestOutput,
  conversations: readonly { readonly title: string }[],
): string =>
  [
    summary.daySummary,
    ...summary.memoryProposals.map((p) => `${p.text} ${p.why}`),
    ...conversations.map((c) => c.title),
  ].join('\n');

export const putDigestWithDrafts = (
  scope: GuildScope,
  input: {
    readonly day: string;
    readonly summary: DigestOutput;
    readonly conversations: readonly {
      readonly conversationId: string;
      readonly channelId: string;
      readonly title: string;
    }[];
    readonly botUserId: string;
    readonly now: number;
  },
): 'created' | 'duplicate' =>
  write(scope, ({ db }) => {
    const parsed = digestOutputSchema.parse(input.summary);
    const stored = { summary: parsed, conversations: [...input.conversations] };
    const changed = db
      .insert(schema.assistantDailyDigests)
      .values({
        guildId: scope.guildId,
        day: input.day,
        summaryJson: JSON.stringify(stored),
        summaryText: renderDigestText(parsed, input.conversations),
        proposalsJson: JSON.stringify(parsed.memoryProposals),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [schema.assistantDailyDigests.guildId, schema.assistantDailyDigests.day],
      })
      .run().changes;
    // A replay that raced past the handler's early return lands here with
    // the digest row already written: file no second draft set (hard rule 6
    // — the `digest:<day>:<index>` ids would otherwise collide or, with a
    // different proposal count, leak extra drafts).
    if (changed === 0) return 'duplicate';
    parsed.memoryProposals.forEach((p, index) => {
      db.insert(schema.assistantDecisions)
        .values({
          guildId: scope.guildId,
          decisionId: `digest:${input.day}:${index}`,
          kind: 'memory',
          summary: `${p.text}\nWhy: ${p.why}`,
          status: 'draft',
          requesterId: input.botUserId,
          provenance: 'daily-digest',
          createdAt: input.now,
        })
        .onConflictDoNothing({
          target: [schema.assistantDecisions.guildId, schema.assistantDecisions.decisionId],
        })
        .run();
    });
    return 'created';
  });

/**
 * A fenced reply (```json ... ```) is the same payload in a wrapper; strip
 * one fence pair so a chatty model does not lose the whole day to ADR 0150's
 * single attempt. Zod still validates what is inside.
 */
const stripCodeFence = (text: string): string => {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text.trim());
  return match?.[1] ?? text;
};

/**
 * Over-producing proposals must not fail the day: the schema caps the array
 * at `DIGEST_DEFAULT_MAX_PROPOSALS`, so slice extras away before validation.
 * The owner cap (`digestMaxProposals`, at most the schema max) applies later.
 */
const capProposalsForValidation = (cleaned: unknown): unknown => {
  if (typeof cleaned !== 'object' || cleaned === null) return cleaned;
  const o = cleaned as { readonly memoryProposals?: unknown };
  if (!Array.isArray(o.memoryProposals)) return cleaned;
  if (o.memoryProposals.length <= DIGEST_DEFAULT_MAX_PROPOSALS) return cleaned;
  return { ...o, memoryProposals: o.memoryProposals.slice(0, DIGEST_DEFAULT_MAX_PROPOSALS) };
};

/**
 * Containment below this length lets a very short existing memory or draft
 * ("Tiles") swallow any proposal that mentions it. Equality always matches;
 * containment only when the shorter key carries enough text to mean something.
 */
const MIN_CONTAINMENT_CHARS = 20;

/**
 * One daily digest (ADR 0150).
 *
 * Idempotent two ways: the timer's `oncePerBucket` bucket key refuses a
 * second enqueue even after this job finished, and this handler returns
 * early when the digest row already exists — so a replayed or retried run
 * can never file proposals twice. The tier never comes from `routeRun`:
 * the `routed` event below carries reason `background-tier`. Model and parse
 * failures are completed failures (`failed` run, no retry); unexpected
 * errors are marked `digest-error` on the run and RETHROWN, so the
 * JobWorker schedules its bounded retry (ADR 0150 decision 5). Each retry
 * re-invokes the model, so the job's max attempts are the bound on extra
 * provider requests.
 */
export const assistantDailyDigestHandler = (
  scope: GuildScope,
  deps: DigestDeps,
): JobHandler<AssistantDailyDigestPayload> => ({
  kind: JOB_KINDS.assistantDailyDigest,
  payload: assistantDailyDigestPayload,
  async run(payload) {
    const now = deps.now();
    if (!deps.digestEnabled()) {
      deps.logger.info(
        safeLogFields({ component: 'assistant-digest', guildId: scope.guildId, day: payload.day }),
        'daily digest is off; skipping',
      );
      return;
    }
    const runId = `digest-${payload.day}`;
    const tz = deps.timeZone();
    // One run, one lifecycle start (review round 2, B3): a replay or a job
    // retry lands on the run row the first attempt created (`ensureRun`
    // keeps it), so queued/started are appended only when the row is new.
    // `routed` still logs each attempt's tier, and a later attempt's
    // answer/fail moves the same row to its final state with its own
    // finished event - the schema puts no uniqueness on event kinds, so the
    // event log keeps every attempt's outcome.
    const runExists = runRepo.getRun(scope, runId) !== undefined;
    // These storage calls (and `fail` below) can throw on a storage error.
    // That is ADR 0150 decision 5's contract too: an unexpected error here
    // propagates to the job retry exactly like one inside the try - before
    // the run row exists there is nothing to mark.
    runRepo.ensureRun(scope, {
      runId,
      userId: deps.botUserId,
      behaviourId: 'default',
      source: 'daily-digest',
      queuedAt: now,
    });
    const startedAt = deps.now();
    if (!runExists) {
      runRepo.appendRunEvent(scope, runId, startedAt, { kind: 'queued', via: 'schedule' });
      runRepo.appendRunEvent(scope, runId, startedAt, {
        kind: 'started',
        attempt: 1,
        queueWaitMs: 0,
      });
    }
    runRepo.appendRunEvent(scope, runId, deps.now(), {
      kind: 'routed',
      tier: deps.forcedTier(),
      reason: 'background-tier',
    });
    const fail = (code: string): void => {
      runRepo.updateRun(scope, runId, {
        state: 'failed',
        stage: 'done',
        finishedAt: deps.now(),
        errorCode: code,
        updatedAt: deps.now(),
      });
      runRepo.appendRunEvent(scope, runId, deps.now(), {
        kind: 'finished',
        outcome: 'failed',
        durationMs: Math.max(0, deps.now() - startedAt),
        code,
      });
    };
    const answer = (outcome: 'answered'): void => {
      runRepo.updateRun(scope, runId, {
        state: outcome,
        stage: 'done',
        finishedAt: deps.now(),
        errorCode: null,
        updatedAt: deps.now(),
      });
      runRepo.appendRunEvent(scope, runId, deps.now(), {
        kind: 'finished',
        outcome,
        durationMs: Math.max(0, deps.now() - startedAt),
      });
    };
    try {
      if (digestRepo.getDigest(scope, payload.day) !== undefined) {
        answer('answered');
        return;
      }
      const { start, end } = localDayBounds(payload.day, tz);
      const groups = digestRepo.turnsForDay(scope, start, end);
      if (groups.length === 0) {
        digestRepo.putDigestOnce(scope, {
          day: payload.day,
          summary: { daySummary: EMPTY_SUMMARY, memoryProposals: [] },
          conversations: [],
          now: deps.now(),
        });
        answer('answered');
        return;
      }
      const clean = cleanForModel;
      // Every field the provider sees - title and rolling summary included,
      // not only turn text — goes through the same redaction and marker
      // neutralisation (ADR 0150 decision 2): a key in a title would trip the
      // provider's pre-API scan and lose the whole day (review round 2, A).
      const input = buildDigestInput(
        groups.map((g) => ({
          conversationId: g.conversationId,
          title: clean(g.title),
          summaryText: g.summaryText === null ? null : clean(g.summaryText),
          lines: g.turns.map(
            (turn) =>
              `[${speakerOf(turn.authorName, turn.role)}, ${turn.role === 'assistant' ? 'bot' : 'member'}] ${clean(turn.text)}`,
          ),
        })),
        deps.digestInputChars(),
      );
      const outputs: DigestOutput[] = [];
      for (const chunk of splitDigestInput(input, deps.digestInputChars())) {
        const result = await deps.digestModel({
          systemInstruction: DIGEST_SYSTEM_INSTRUCTION,
          text: chunk,
        });
        if (!result.ok) {
          deps.logger.info(
            safeLogFields({
              component: 'assistant-digest',
              guildId: scope.guildId,
              day: payload.day,
              reason: result.reason,
            }),
            'daily digest model call failed; writing nothing',
          );
          fail('digest-model-unavailable');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFence(result.text));
        } catch {
          parsed = undefined;
        }
        const cleaned = parsed === undefined ? undefined : cleanDigestJson(parsed);
        const valid =
          cleaned === undefined
            ? undefined
            : digestOutputSchema.safeParse(capProposalsForValidation(cleaned));
        if (valid === undefined || !valid.success) {
          deps.logger.info(
            safeLogFields({
              component: 'assistant-digest',
              guildId: scope.guildId,
              day: payload.day,
              reason: 'invalid-json',
            }),
            'daily digest model reply failed to parse; writing nothing',
          );
          fail('digest-invalid-json');
          return;
        }
        outputs.push(valid.data);
      }
      const merged: DigestOutput = {
        daySummary: truncateWords(
          outputs.map((o) => o.daySummary).join('\n\n'),
          MAX_DIGEST_SUMMARY_WORDS,
        ),
        memoryProposals: outputs.flatMap((o) => o.memoryProposals),
      };
      // A proposal's sources must be conversations of this very day: an
      // invented id would point the reviewer at the wrong conversation, so
      // unknown ids are dropped and a proposal with none left is dropped.
      const knownIds = new Set(groups.map((g) => g.conversationId));
      const sourced = merged.memoryProposals.flatMap((p) => {
        const ids = p.sourceConversationIds.filter((id) => knownIds.has(id));
        return ids.length === 0 ? [] : [{ ...p, sourceConversationIds: ids }];
      });
      // Dedupe (plan decision: duplicates by normalised-text match). Memories
      // are keyed on content only — a section prefix would stop every match —
      // and drafts on their summary; either-way containment (above
      // MIN_CONTAINMENT_CHARS) catches `propose_memory` drafts (`content`,
      // `section: content`) and our own (`text` plus a `Why:` line) alike.
      const seen = new Set<string>();
      for (const m of assistantRepo.listMemories(scope)) {
        const key = normalizeProposalText(m.content);
        if (key !== '') seen.add(key);
      }
      for (const d of assistantRepo.listDecisions(scope)) {
        if (d.kind === 'memory' && (d.status === 'draft' || d.status === 'reviewed')) {
          const key = normalizeProposalText(d.summary);
          if (key !== '') seen.add(key);
        }
      }
      const isDuplicate = (text: string): boolean => {
        const key = normalizeProposalText(text);
        if (key === '') return true;
        for (const s of seen) {
          if (s === key) return true;
          const shorter = s.length < key.length ? s : key;
          if (shorter.length >= MIN_CONTAINMENT_CHARS && (s.includes(key) || key.includes(s))) {
            return true;
          }
        }
        return false;
      };
      const kept = sourced
        .filter((p) => {
          if (isDuplicate(p.text)) return false;
          seen.add(normalizeProposalText(p.text));
          return true;
        })
        .slice(0, deps.digestMaxProposals());
      const stored = putDigestWithDrafts(scope, {
        day: payload.day,
        summary: { daySummary: merged.daySummary, memoryProposals: kept },
        conversations: groups.map((g) => ({
          conversationId: g.conversationId,
          channelId: g.channelId,
          title: g.title,
        })),
        botUserId: deps.botUserId,
        now: deps.now(),
      });
      if (stored === 'duplicate') {
        deps.logger.info(
          safeLogFields({
            component: 'assistant-digest',
            guildId: scope.guildId,
            day: payload.day,
          }),
          'daily digest already done; skipping second draft set',
        );
      }
      answer('answered');
    } catch (err) {
      deps.logger.warn(
        safeLogFields({ component: 'assistant-digest', guildId: scope.guildId, day: payload.day }),
        'daily digest failed unexpectedly; run marked failed, error rethrown for the job retry',
      );
      // Mark the ledger terminal-failed for the dashboard, then let the
      // original error reach the JobWorker so its bounded retry is actually
      // scheduled (ADR 0150 decision 5). A failure of the marking itself
      // (storage down) must not mask the original error.
      try {
        fail('digest-error');
      } catch {
        deps.logger.warn(
          safeLogFields({
            component: 'assistant-digest',
            guildId: scope.guildId,
            day: payload.day,
          }),
          'daily digest could not mark the run failed; the original error still propagates',
        );
      }
      throw err;
    }
  },
});

/** Clean model JSON the way evidence is cleaned everywhere (hard rule 3). */
const cleanDigestJson = (parsed: unknown): unknown => {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const clean = cleanForModel;
  const o = parsed as { daySummary?: unknown; memoryProposals?: unknown };
  return {
    ...(typeof o.daySummary === 'string' ? { daySummary: clean(o.daySummary) } : {}),
    ...(Array.isArray(o.memoryProposals)
      ? {
          memoryProposals: (o.memoryProposals as unknown[]).map((p: unknown) => {
            // Not an object (null, a number, a string): keep it exactly so
            // Zod rejects it — never dereference a non-object element.
            if (typeof p !== 'object' || p === null) return p;
            const q = p as {
              text?: unknown;
              why?: unknown;
              sourceConversationIds?: unknown;
            };
            return {
              ...(typeof q.text === 'string' ? { text: clean(q.text) } : { text: q.text }),
              ...(typeof q.why === 'string' ? { why: clean(q.why) } : { why: q.why }),
              sourceConversationIds: q.sourceConversationIds,
            };
          }),
        }
      : {}),
  };
};
