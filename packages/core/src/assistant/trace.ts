import { z } from 'zod';

/**
 * Which context blocks a reply saw (ADR 0088 decision 2). A separate schema
 * so the job cursor reuses the trace's own shape for it.
 */
export const assistantTraceIncludedSchema = z.object({
  toolsOffered: z.array(z.string()),
  snippetChunkIds: z.array(z.string()),
  quote: z.boolean(),
  historyTurns: z.number().int().nonnegative(),
  /** ADR 0089: how many channel-context lines the reply saw. Absent means none. */
  channelMessages: z.number().int().nonnegative().optional(),
  /** ADR 0091: the stored summary version the history led with. Absent means none. */
  summaryVersion: z.number().int().nonnegative().optional(),
  /** ADR 0149: what rode along; metadata only, never bytes. */
  attachments: z
    .array(
      z.object({
        name: z.string().max(120),
        kind: z.enum(['text', 'image', 'pdf']),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .max(10)
    .optional(),
});
export type AssistantTraceIncluded = z.infer<typeof assistantTraceIncludedSchema>;

/**
 * One stored assistant run (ADR 0076): what the member asked, what the model
 * saw, what it called, what it cost, and where it failed. Written by the
 * invoke job in Task 14; read by the History list and detail pages.
 *
 * Large free-text fields (`sections[].text`, `toolCalls[].preview`) are
 * capped by `capTrace` before storage, so no single run can grow the table
 * without bound. No keys, tokens or sealed values ever belong in here
 * (hard rule 4) — the schema cannot enforce that, so the writer must.
 */
export const assistantTraceSchema = z.object({
  traceId: z.string().min(1),
  /** ADR 0129 §5: the invocation id; ties the trace to its journal lines and run ledger. */
  runId: z.string().min(1).max(64).optional(),
  at: z.number().int(),
  userId: z.string(),
  channelId: z.string().optional(),
  behaviourId: z.string(),
  command: z.string(),
  source: z.enum(['slash-command', 'mention', 'dashboard-test']),
  conversationId: z.string().optional(),
  turnId: z.string().optional(),
  question: z.string(),
  answer: z.string().optional(),
  outcome: z.enum(['answered', 'refused', 'failed']),
  durationMs: z.number().int().nonnegative(),
  attempts: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      /** The label of the API key the attempt ran on; never the key itself (hard rule 4). */
      keyLabel: z.string().max(60).optional(),
      outcome: z.enum(['ok', 'busy', 'rate-limit', 'timeout', 'skipped', 'error']),
      reason: z.string().optional(),
      ms: z.number().int().nonnegative(),
      code: z.string().optional(),
      /** ADR 0129 §3: the error's message after `sanitizeProviderMessage`. */
      providerMessage: z.string().max(200).optional(),
      httpStatus: z.number().int().optional(),
      netCode: z.string().optional(),
      host: z.string().optional(),
      /** Provider finish/stop reason, verbatim (ADR 0129 §4). */
      finishReason: z.string().max(40).optional(),
      /** The upstream provider OpenRouter routed to (ADR 0129 §4). */
      upstream: z.string().max(60).optional(),
      /** Completion tokens reported on an empty answer (ADR 0129 §4). */
      completionTokens: z.number().int().nonnegative().optional(),
      /** Reasoning tokens reported on an empty answer (ADR 0129 §4). */
      reasoningTokens: z.number().int().nonnegative().optional(),
      /** Filled by a later task (per-call cost); declared now so the schema is settled. */
      costUsd: z.number().nonnegative().optional(),
      availableAt: z.number().int().optional(),
    }),
  ),
  finishReason: z.string().optional(),
  usage: z.object({
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    thinkingTokens: z.number().optional(),
    /** ADR 0129 §8: summed per-call cost, present only when a call reported one. */
    costUsd: z.number().nonnegative().optional(),
  }),
  sections: z.array(
    z.object({
      name: z.string(),
      chars: z.number().int(),
      estTokens: z.number().int(),
      text: z.string(),
    }),
  ),
  toolCalls: z.array(
    z.object({
      round: z.number().int().min(1),
      name: z.string(),
      args: z.unknown(),
      ok: z.boolean(),
      refused: z.string().optional(),
      ms: z.number().int().nonnegative(),
      /**
       * The full result text as the model saw it (neutralised, no wrapper
       * or citation text), at most 6,000 characters. The field name stays
       * `preview` for stored-row compatibility.
       */
      preview: z.string(),
    }),
  ),
  /**
   * Saved thinking per round (Slice 3, ADR 0148): OpenRouter reasoning and
   * Gemini thought summaries. Capped by `capTrace`; shown collapsed on the
   * "What the AI saw" page to trace-capable viewers only.
   */
  reasoning: z
    .array(z.object({ round: z.number().int().min(0), text: z.string().max(8000) }))
    .max(12)
    .optional(),
  guard: z.object({ removed: z.array(z.string()), blocked: z.string().optional() }),
  /**
   * Which context blocks the reply saw (ADR 0088 decision 2). Optional so
   * rows written before it still parse; there is no migration.
   */
  included: assistantTraceIncludedSchema.optional(),
  timeline: z.array(z.object({ label: z.string(), atMs: z.number().int().nonnegative() })),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  discordMessageIds: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  flags: z.array(z.string()),
});
export type AssistantTrace = z.infer<typeof assistantTraceSchema>;

/** Rough token estimate for display: one token per four characters, rounded up. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Prompt plus answer plus thinking tokens when any usage was recorded, else null. */
export const totalTokensOf = (usage: AssistantTrace['usage']): number | null => {
  const { promptTokens, completionTokens, thinkingTokens } = usage;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    thinkingTokens === undefined
  ) {
    return null;
  }
  return (promptTokens ?? 0) + (completionTokens ?? 0) + (thinkingTokens ?? 0);
};

/** The History list row: the stored trace reduced to one line. */
export interface TraceSummary {
  readonly traceId: string;
  readonly at: number;
  readonly userId: string;
  readonly channelId?: string;
  readonly behaviourId: string;
  readonly outcome: AssistantTrace['outcome'];
  readonly durationMs: number;
  /** The last non-ok, non-skipped attempt's code, else absent. */
  readonly errorCode?: string;
  /** The model that answered: the last successful attempt, else the last attempt. */
  readonly model?: string;
  readonly totalTokens: number | null;
}

/**
 * ADR 0129: the one "why did this fail" code shared by History, the
 * transcript, the job's log line and the log channel — the last failed
 * attempt's code, else the last skipped attempt's code (a local or daily
 * limit), else the trace's error kind.
 */
export const traceFailureCode = (
  trace: Pick<AssistantTrace, 'attempts' | 'error'>,
): string | undefined => {
  const failed = [...trace.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.outcome !== 'ok' && attempt.outcome !== 'skipped' && attempt.code !== undefined,
    );
  if (failed?.code !== undefined) return failed.code;
  const skipped = [...trace.attempts]
    .reverse()
    .find((attempt) => attempt.outcome === 'skipped' && attempt.code !== undefined);
  return skipped?.code ?? trace.error?.kind;
};

export const summaryOfTrace = (t: AssistantTrace): TraceSummary => {
  const attempts = t.attempts;
  const model =
    [...attempts].reverse().find((a) => a.outcome === 'ok')?.model ?? attempts.at(-1)?.model;
  const errorCode = traceFailureCode(t);
  return {
    traceId: t.traceId,
    at: t.at,
    userId: t.userId,
    ...(t.channelId === undefined ? {} : { channelId: t.channelId }),
    behaviourId: t.behaviourId,
    outcome: t.outcome,
    durationMs: t.durationMs,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(model === undefined ? {} : { model }),
    totalTokens: totalTokensOf(t.usage),
  };
};

/** One day of the 14-day usage strip: UTC `YYYY-MM-DD`. */
export interface DayUsage {
  readonly day: string;
  readonly answers: number;
  readonly failures: number;
  /** Traces that tried more than one model and finished on a working one. */
  readonly fallbacks: number;
  readonly tokens: number;
  /** ADR 0129 §8: ledger failures on this day, by code. Absent on rows that predate it. */
  readonly failuresByCode?: Readonly<Record<string, number>>;
  /** ADR 0129 §8: ledger tokens on this day, by model. Absent on rows that predate it. */
  readonly tokensByModel?: Readonly<Record<string, number>>;
}

/** A trace used more than one model and its last attempt worked. */
export const isFallbackTrace = (t: AssistantTrace): boolean =>
  t.attempts.length > 1 && t.attempts.at(-1)?.outcome === 'ok';

/** Marks a field `capTrace` shortened. Exactly `… [truncated]`, per ruling. */
export const TRUNCATION_SUFFIX = '… [truncated]';

const truncateTo = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_SUFFIX.length) return TRUNCATION_SUFFIX;
  let end = maxChars - TRUNCATION_SUFFIX.length;
  // Never cut between the halves of a surrogate pair: drop the orphaned high half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATION_SUFFIX;
};

const byteSize = (t: AssistantTrace): number => new TextEncoder().encode(JSON.stringify(t)).length;

/**
 * Shrinks a trace until its JSON fits `maxBytes` (default 200 KB): first the
 * prompt section texts, then the tool result previews, halving the remaining
 * over-long fields each pass. Truncated fields end with `… [truncated]` and
 * their `chars`/`estTokens` are re-measured so the stored row stays honest.
 * Fixed fields (question, answer, args) are never touched — a trace whose
 * fixed fields alone exceed the budget comes back unchanged.
 */
export const capTrace = (t: AssistantTrace, maxBytes = 200_000): AssistantTrace => {
  // Reasoning entries are truncated up front: the schema rejects text over
  // 8,000 chars, so an untruncated entry could never be stored.
  const sections = t.sections.map((s) => ({ ...s }));
  const toolCalls = t.toolCalls.map((c) => ({ ...c }));
  const reasoning = (t.reasoning ?? []).slice(0, 12).map((r) => ({
    ...r,
    text: truncateTo(r.text, 8000),
  }));
  const out: AssistantTrace = {
    ...t,
    sections,
    toolCalls,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
  };
  const shrink = (fields: { get(): string; set(v: string): void }[]): boolean => {
    let changed = false;
    for (const field of fields) {
      const current = field.get();
      if (current.length > TRUNCATION_SUFFIX.length) {
        field.set(truncateTo(current, Math.ceil(current.length / 2)));
        changed = true;
      }
    }
    return changed;
  };
  while (
    byteSize(out) > maxBytes &&
    shrink(
      sections.map((s, i) => ({
        get: () => sections[i]?.text ?? '',
        set: (v: string) => {
          sections[i] = { ...s, text: v, chars: v.length, estTokens: estimateTokens(v) };
        },
      })),
    )
  ) {
    // Sections first, per the interface contract.
  }
  while (
    byteSize(out) > maxBytes &&
    shrink(
      toolCalls.map((c, i) => ({
        get: () => toolCalls[i]?.preview ?? '',
        set: (v: string) => {
          toolCalls[i] = { ...c, preview: v };
        },
      })),
    )
  ) {
    // Then previews.
  }
  while (
    byteSize(out) > maxBytes &&
    shrink(
      reasoning.map((r, i) => ({
        get: () => reasoning[i]?.text ?? '',
        set: (v: string) => {
          reasoning[i] = { ...r, text: v };
        },
      })),
    )
  ) {
    // Then reasoning, before giving up.
  }
  return out;
};
