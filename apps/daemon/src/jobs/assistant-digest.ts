import {
  assistantDailyDigestPayload,
  buildDigestInput,
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
import { assistantRepo, digestRepo, runRepo, type GuildScope } from '@bananasaurs/storage';
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

const speakerOf = (authorName: string, role: string): string => {
  const cleaned = safeDisplayName(authorName);
  const name = cleaned === undefined || /^\d{17,20}$/.test(cleaned) ? 'a member' : cleaned;
  return role === 'assistant' ? 'bot' : name;
};

/**
 * One daily digest (ADR 0150).
 *
 * Idempotent two ways: the timer's `oncePerBucket` bucket key refuses a
 * second enqueue even after this job finished, and this handler returns
 * early when the digest row already exists — so a replayed or retried run
 * can never file proposals twice. The tier never comes from `routeRun`:
 * the `routed` event below carries reason `background-tier`.
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
    runRepo.ensureRun(scope, {
      runId,
      userId: deps.botUserId,
      behaviourId: 'default',
      source: 'daily-digest',
      queuedAt: now,
    });
    const startedAt = deps.now();
    runRepo.appendRunEvent(scope, runId, startedAt, { kind: 'queued', via: 'schedule' });
    runRepo.appendRunEvent(scope, runId, startedAt, {
      kind: 'started',
      attempt: 1,
      queueWaitMs: 0,
    });
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
        updatedAt: deps.now(),
      });
      runRepo.appendRunEvent(scope, runId, deps.now(), {
        kind: 'finished',
        outcome,
        durationMs: Math.max(0, deps.now() - startedAt),
      });
    };
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
    const clean = (text: string): string => neutraliseMarkers(redactEvidenceText(text).text);
    const input = buildDigestInput(
      groups.map((g) => ({
        conversationId: g.conversationId,
        title: g.title,
        summaryText: g.summaryText,
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
        parsed = JSON.parse(result.text);
      } catch {
        parsed = undefined;
      }
      const valid =
        parsed === undefined ? undefined : digestOutputSchema.safeParse(cleanDigestJson(parsed));
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
    // Dedupe (plan decision: duplicates by normalised-text match). Memories
    // are keyed on content only — a section prefix would stop every match —
    // and drafts on their summary; either-way containment catches
    // `propose_memory` drafts (`content`, `section: content`) and our own
    // (`text` plus a `Why:` line) alike.
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
        if (s.includes(key) || key.includes(s)) return true;
      }
      return false;
    };
    const kept = merged.memoryProposals
      .filter((p) => {
        if (isDuplicate(p.text)) return false;
        seen.add(normalizeProposalText(p.text));
        return true;
      })
      .slice(0, deps.digestMaxProposals());
    digestRepo.putDigestOnce(scope, {
      day: payload.day,
      summary: { daySummary: merged.daySummary, memoryProposals: kept },
      conversations: groups.map((g) => ({
        conversationId: g.conversationId,
        channelId: g.channelId,
        title: g.title,
      })),
      now: deps.now(),
    });
    kept.forEach((p, index) => {
      assistantRepo.insertDecisionDraftOnce(scope, {
        id: `digest:${payload.day}:${index}`,
        kind: 'memory',
        summary: `${p.text}\nWhy: ${p.why}`,
        requesterId: deps.botUserId,
        provenance: 'daily-digest',
        at: deps.now(),
      });
    });
    answer('answered');
  },
});

/** Clean model JSON the way evidence is cleaned everywhere (hard rule 3). */
const cleanDigestJson = (parsed: unknown): unknown => {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const clean = (text: string): string => neutraliseMarkers(redactEvidenceText(text).text);
  const o = parsed as { daySummary?: unknown; memoryProposals?: unknown };
  return {
    ...(typeof o.daySummary === 'string' ? { daySummary: clean(o.daySummary) } : {}),
    ...(Array.isArray(o.memoryProposals)
      ? {
          memoryProposals: o.memoryProposals.map((p) => {
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
