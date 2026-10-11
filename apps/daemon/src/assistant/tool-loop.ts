import {
  classifyProviderFailure,
  guardAnswer,
  nextProviderDayStart,
  ProviderError,
  safeLogFields,
  sanitizeProviderMessage,
  type AssistantTrace,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type GenerationMessage,
  type Logger,
  type TextProvider,
  type ToolCall,
  type ToolDeclaration,
  RETURNED_ID_ARGS,
  TOOL_CATALOGUE,
  TRUNCATION_SUFFIX,
} from '@bananasaurs/core';
import { assistantKeyCooldownsRepo, type InstanceScope } from '@bananasaurs/storage';
import type { CitationRegistry } from './citations.js';
import type { ChainEntry } from './model-chain.js';
import { NOOP_RUN_RECORDER, type RunRecorder } from './run-recorder.js';
import type { QuotaLedger } from './quota-ledger.js';
import type { AssistantToolResult, ToolSource } from './tools.js';
import { attemptReasonFor } from './provider-failure.js';
import { neutraliseMarkers } from './untrusted.js';

export interface LoopTools {
  /** Round 1 may call any allowed read-only tool. */
  readonly firstRound: readonly ToolDeclaration[];
  /** Rounds 2+: catalogue-approved declarations, filtered again before sending. */
  readonly laterRounds: readonly ToolDeclaration[];
  readonly run: (call: ToolCall) => Promise<AssistantToolResult>;
}

export interface LoopResult {
  /** Guarded answer text, not yet split. Empty when nothing answered. */
  readonly text: string;
  readonly outcome: 'answered' | 'failed';
  readonly model?: string;
  readonly provider?: string;
  /**
   * The chain entry whose response was accepted (ADR 0091). Carried so the
   * summary job can re-resolve the same entry. Never written to the trace:
   * the key id is not for display.
   */
  readonly answeredBy?: {
    readonly providerId: string;
    readonly model: string;
    readonly keyId: string;
  };
  readonly attempts: AssistantTrace['attempts'];
  readonly toolCalls: AssistantTrace['toolCalls'];
  readonly usage: AssistantTrace['usage'];
  readonly finishReason?: string;
  readonly guard: AssistantTrace['guard'];
  readonly sources: readonly ToolSource[];
  readonly web: boolean;
  /** ADR 0120: the search sources used, unique, first-seen order. */
  readonly webSources: readonly ('brave' | 'tavily')[];
  /**
   * B2b: the code-written confirmations from ok tool results
   * (`AssistantToolResult.actionSummary`), in call order. The service appends
   * them to the posted answer and records them on the trace.
   */
  readonly actionSummaries: readonly string[];
  /**
   * Present when every entry was skipped or failed and at least one failure
   * or skip was a daily cap: the earliest known reset, if any. The caller
   * answers the daily-cap reply instead of busy (Task Q).
   */
  readonly dailyQuota?: { readonly resetAt: number | undefined };
  /**
   * Present when every attempt was skipped for a local per-entry limit: the
   * earliest free-up time. The caller answers the local-limit reply at once
   * with no retry (ADR 0081).
   */
  readonly localLimit?: {
    readonly availableAt: number;
    readonly code: 'local-rpm-limit' | 'local-rpd-limit';
  };
  /**
   * The last attempt's original provider error, when any entry failed with
   * one. The service re-throws it so a non-guard failure keeps its kind
   * (e.g. a non-daily `quota` error) instead of becoming `invalid-request`.
   */
  readonly lastError?: ProviderError;
  /**
   * Task G3: the round-1 declaration names the loop actually sent to the
   * provider (after `declarationsFor`), in first-sent order. The service
   * records these on the trace detail so the History page can show what the
   * model could have called, even when it called nothing.
   */
  readonly toolsOffered: readonly string[];
}

export interface LoopLimits {
  readonly rounds: number;
  readonly perRound: number;
  readonly totalCalls: number;
  readonly resultChars: number;
  readonly maxOutputTokens: number;
  readonly toolThinking: number;
  readonly answerThinking: number;
}

const DEFAULT_LIMITS: LoopLimits = {
  rounds: 4,
  perRound: 6,
  totalCalls: 12,
  resultChars: 24_000,
  maxOutputTokens: 2_048,
  toolThinking: 512,
  answerThinking: 1_024,
};

const ANSWER_INSTRUCTION = 'Answer now using the results above. Do not call tools.';
export const TOOL_RESULT_TRACE_CHARS = 6_000;
/**
 * ADR 0129 decision 1: the fixed member-facing text for a failed chain. The
 * service maps failures to the same text, so it is exported for the throw
 * sites there.
 */
export const GUARD_FAILURE_TEXT = "I couldn't finish that answer — please try again.";
const PROMPT_LEAK_TEXT = "I can't share that.";

/**
 * The model-visible tool result text as stored on the trace (ADR 0088
 * decision 1): the neutralised text capped at `TOOL_RESULT_TRACE_CHARS`,
 * with a `… [truncated]` suffix when cut. No wrapper or citation text.
 */
const truncateResultForTrace = (text: string): string => {
  if (text.length <= TOOL_RESULT_TRACE_CHARS) return text;
  return text.slice(0, TOOL_RESULT_TRACE_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
};

const nextUtcMidnight = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
};

const cooldownSkipReason = (stored: string): string =>
  stored === 'daily-quota' || stored === 'minute-quota' || stored === 'invalid-key'
    ? stored
    : 'cooldown';

const isDailyCap = (err: unknown): err is ProviderError =>
  err instanceof ProviderError && err.kind === 'quota' && err.quotaScope === 'daily-free';

const isBusy = (err: unknown): boolean =>
  err instanceof ProviderError &&
  err.retryable &&
  (err.kind === 'outage' || err.kind === 'rate-limit' || err.kind === 'timeout');

type Attempt = AssistantTrace['attempts'][number];
type TraceToolCall = AssistantTrace['toolCalls'][number];

type LocalLimitCode = 'local-rpm-limit' | 'local-rpd-limit';

type ReserveCall = (
  entry: ChainEntry,
) =>
  | { readonly ok: true }
  | { readonly ok: false; readonly code: LocalLimitCode; readonly availableAt: number };

const skippedLocalLimitAttempt = (
  entry: ChainEntry,
  code: LocalLimitCode,
  availableAt: number,
  ms: number,
): Attempt => ({
  provider: entry.providerId,
  model: entry.model,
  keyLabel: entry.keyLabel,
  outcome: 'skipped',
  reason: code,
  code,
  availableAt,
  ms,
});

/*
 * Bounded tool loop over the ordered model chain (ADRs 0071, 0075):
 * 1. For each chain entry in order: no provider means attempt `skipped`.
 * 2. Rounds 1..N offer round-1 tools, then ID tools only; a provider error
 *    records the attempt and moves to the next entry, which restarts from
 *    round 1 with a fresh message list.
 * 3. A response with no tool calls is the final text.
 * 4. Round 1 runs the first `perRound` calls while `totalCalls` remains;
 *    round 2+ refuses non-ID tools and unknown ids; every call gets a tool
 *    message; result text stops once `resultChars` is reached. `totalCalls`
 *    and `resultChars` bind the whole request: failover restarts rounds,
 *    messages and handles, never these budgets.
 * 5. Still calling tools at the end: one final call with no declarations.
 * 6. Every final text runs through the output guard, with one retry.
 * 7. Every entry skipped or failed means `outcome: 'failed'`.
 */
export const runToolLoop = async (input: {
  readonly chain: readonly ChainEntry[];
  readonly systemInstruction: string;
  readonly protectedText: string;
  readonly history: readonly GenerationMessage[];
  readonly userText: string;
  readonly initialHandles: readonly string[];
  readonly tools?: LoopTools | undefined;
  readonly limits?: Partial<LoopLimits> | undefined;
  readonly quotaLedger?: QuotaLedger | undefined;
  /**
   * ADR 0143: when present, the persistent cooldown table decides which
   * key and model pairs are skipped and records new cooldowns. When absent,
   * no cooldown is read or written and the legacy in-memory ledger path runs
   * unchanged (service wiring lands in S6-T13).
   */
  readonly instance?: InstanceScope | undefined;
  readonly reserveCall?: ReserveCall | undefined;
  readonly logger?: Pick<Logger, 'warn' | 'info'> | undefined;
  readonly guildId?: string | undefined;
  /** ADR 0129 §5: the invocation id; every assistant log line carries it. */
  readonly runId?: string | undefined;
  /** ADR 0129 §6: the run's step log; absent means nothing is recorded. */
  readonly recorder?: RunRecorder | undefined;
  readonly citations?: CitationRegistry | undefined;
  /**
   * Whether a tool result's source may be tagged for citation. Absent means
   * no source is citable and no "Cite as" line is emitted.
   */
  readonly isCitable?: ((source: { title: string; url: string }) => boolean) | undefined;
  /**
   * ADR 0144 escalation: a pure plan, asked before each entry runs. When it
   * returns entries, then after that entry's round-1 tool calls the SAME loop
   * is handed to them: they continue from round 2 with the same messages,
   * handles, budgets and summaries, so no acting tool runs twice. Returning
   * undefined or an empty list keeps the entry going to its own answer.
   */
  readonly escalateAfterTools?:
    | ((entry: ChainEntry, remaining: readonly ChainEntry[]) => readonly ChainEntry[] | undefined)
    | undefined;
  /** Called once when a hand-over happens, with the entry and its successors. */
  readonly onEscalated?: ((entry: ChainEntry, next: readonly ChainEntry[]) => void) | undefined;
  readonly now: () => number;
}): Promise<LoopResult> => {
  const limits: LoopLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const attempts: Attempt[] = [];
  const toolCalls: TraceToolCall[] = [];
  const sources: ToolSource[] = [];
  const actionSummaries: string[] = [];
  let web = false;
  const webSources: ('brave' | 'tavily')[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let thinkingTokens = 0;
  let costUsd = 0;
  let sawPrompt = false;
  let sawCompletion = false;
  let sawThinking = false;
  let sawCost = false;
  // Keys whose `:free` allowance died inside this loop, with the reset that
  // killed them (undefined when the error named none).
  const cappedKeys = new Map<string, number | undefined>();
  const dailyResets: (number | undefined)[] = [];
  let sawDailyCap = false;
  // 12 calls and 24,000 result characters bind the whole request, not one
  // chain entry: failover restarts rounds, messages and handles, never these.
  const budgets = { callsUsed: 0, resultChars: 0 };
  // The last attempt's original provider error, for the caller to re-throw.
  let lastError: ProviderError | undefined;
  // Task G3: round-1 declaration names actually sent, across chain entries,
  // in first-sent order.
  const toolsOffered: string[] = [];
  const offeredSeen = new Set<string>();
  // ADR 0129 §6: every provider call, skip, tool call and guard step lands in
  // the run ledger; absent means nothing is recorded.
  const recorder = input.recorder ?? NOOP_RUN_RECORDER;

  const recordUsage = (usage: GenerateTextResponse['usage']): void => {
    if (usage?.promptTokens !== undefined) {
      promptTokens += usage.promptTokens;
      sawPrompt = true;
    }
    if (usage?.completionTokens !== undefined) {
      completionTokens += usage.completionTokens;
      sawCompletion = true;
    }
    if (usage?.thinkingTokens !== undefined) {
      thinkingTokens += usage.thinkingTokens;
      sawThinking = true;
    }
    // ADR 0129 §8: OpenRouter's per-call cost sums like the token fields.
    if (usage?.costUsd !== undefined) {
      costUsd += usage.costUsd;
      sawCost = true;
    }
  };
  const usageOf = (): AssistantTrace['usage'] => ({
    ...(sawPrompt ? { promptTokens } : {}),
    ...(sawCompletion ? { completionTokens } : {}),
    ...(sawThinking ? { thinkingTokens } : {}),
    ...(sawCost ? { costUsd } : {}),
  });

  const modelIds = input.chain.map((entry) => entry.model);
  const earliestQuota = (): { readonly resetAt: number | undefined } => {
    const known = dailyResets.filter((r): r is number => r !== undefined);
    return { resetAt: known.length > 0 ? Math.min(...known) : undefined };
  };
  /**
   * ADR 0081: when every attempt was skipped for a local per-entry limit,
   * the earliest free-up time and its code — so the caller answers at once
   * instead of retrying.
   */
  const localLimitOf = (list: readonly Attempt[]): LoopResult['localLimit'] => {
    if (list.length === 0) return undefined;
    if (!list.every((attempt) => attempt.outcome === 'skipped')) return undefined;
    const limited = list.filter(
      (
        attempt,
      ): attempt is Attempt & {
        code: 'local-rpm-limit' | 'local-rpd-limit';
        availableAt: number;
      } =>
        (attempt.code === 'local-rpm-limit' || attempt.code === 'local-rpd-limit') &&
        typeof attempt.availableAt === 'number',
    );
    if (limited.length === 0) return undefined;
    const earliest = limited.reduce((a, b) => (a.availableAt <= b.availableAt ? a : b));
    return { availableAt: earliest.availableAt, code: earliest.code };
  };

  // ADR 0129 §6: every skipped entry is a ledger step, with the same reason
  // the attempt carries.
  const recordSkipped = (entry: ChainEntry, reason: string, availableAt?: number): void => {
    recorder.event({
      kind: 'model-skipped',
      provider: entry.providerId,
      model: entry.model,
      keyId: entry.keyId,
      reason,
      ...(availableAt === undefined ? {} : { availableAt }),
    });
  };

  let chain: readonly ChainEntry[] = input.chain;
  // Set once an entry hands the loop over after its round-1 tools.
  let resume: Resume | undefined;
  for (let position = 0; position < chain.length; position += 1) {
    const entry = chain[position]!;
    const started = input.now();
    const ms = (): number => Math.max(0, input.now() - started);
    // ADR 0129 §5: every skipped entry is a journal line with the run id.
    const logSkipped = (reason: string | undefined): void => {
      if (input.logger?.info === undefined) return;
      input.logger.info(
        safeLogFields({
          component: 'assistant',
          ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          provider: entry.providerId,
          model: entry.model,
          keyLabel: entry.keyLabel,
          ...(reason === undefined ? {} : { reason }),
        }),
        'assistant model skipped',
      );
    };
    const logInfo = (message: 'assistant model called' | 'assistant model answered'): void => {
      if (input.logger?.info === undefined) return;
      input.logger.info(
        safeLogFields({
          component: 'assistant',
          ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          provider: entry.providerId,
          model: entry.model,
          keyLabel: entry.keyLabel,
        }),
        message,
      );
    };
    if (entry.provider === undefined || entry.skip !== undefined) {
      attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'skipped',
        ...(entry.skip === undefined ? {} : { reason: entry.skip }),
        ms: ms(),
      });
      recordSkipped(entry, entry.skip ?? 'skipped');
      logSkipped(entry.skip);
      continue;
    }
    const cooldownKeyId = entry.selectedKeyId ?? entry.keyId;
    const cooldown =
      input.instance === undefined
        ? undefined
        : assistantKeyCooldownsRepo.getCooldown(
            input.instance,
            cooldownKeyId,
            entry.model,
            input.now(),
          );
    if (cooldown !== undefined) {
      const reason = cooldownSkipReason(cooldown.reason);
      if (reason === 'daily-quota') {
        sawDailyCap = true;
        dailyResets.push(cooldown.until);
      }
      attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'skipped',
        reason,
        ms: ms(),
      });
      recorder.event({
        kind: 'model-skipped',
        provider: entry.providerId,
        model: entry.model,
        keyId: cooldownKeyId,
        reason,
        availableAt: cooldown.until,
      });
      logSkipped(reason);
      continue;
    }
    // Legacy in-memory path: only without a cooldown table (ADR 0143 moves
    // the authority to the table once the service passes `instance`).
    const isFree = input.instance === undefined && entry.model.endsWith(':free');
    const ledgerUntil = isFree
      ? (input.quotaLedger?.exhaustedUntil(entry.keyId, input.now()) ?? undefined)
      : undefined;
    if (ledgerUntil !== undefined) {
      sawDailyCap = true;
      dailyResets.push(ledgerUntil);
      attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'skipped',
        reason: 'daily-allowance-used',
        ms: ms(),
      });
      recordSkipped(entry, 'daily-allowance-used');
      logSkipped('daily-allowance-used');
      continue;
    }
    if (isFree && cappedKeys.has(entry.keyId)) {
      sawDailyCap = true;
      dailyResets.push(cappedKeys.get(entry.keyId));
      attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'skipped',
        reason: 'daily-allowance-used',
        ms: ms(),
      });
      recordSkipped(entry, 'daily-allowance-used');
      logSkipped('daily-allowance-used');
      continue;
    }

    logInfo('assistant model called');
    const escalation =
      resume === undefined
        ? input.escalateAfterTools?.(entry, chain.slice(position + 1))
        : undefined;
    const answered = await runEntry({
      entry,
      systemInstruction: input.systemInstruction,
      protectedText: input.protectedText,
      history: input.history,
      userText: input.userText,
      initialHandles: input.initialHandles,
      tools: input.tools,
      limits,
      modelIds,
      attempts,
      toolCalls,
      sources,
      actionSummaries,
      budgets,
      recordUsage,
      noteError: (err) => {
        lastError = err;
      },
      recordWeb: (source: 'brave' | 'tavily') => {
        web = true;
        if (!webSources.includes(source)) webSources.push(source);
      },
      recordOffered: (names) => {
        for (const name of names) {
          if (!offeredSeen.has(name)) {
            offeredSeen.add(name);
            toolsOffered.push(name);
          }
        }
      },
      onDailyCap: (resetAt) => {
        sawDailyCap = true;
        dailyResets.push(resetAt);
        if (input.instance !== undefined) return;
        cappedKeys.set(entry.keyId, resetAt);
        input.quotaLedger?.markExhausted(entry.keyId, resetAt ?? nextUtcMidnight(input.now()));
      },
      instance: input.instance,
      reserveCall: input.reserveCall,
      logger: input.logger,
      guildId: input.guildId,
      runId: input.runId,
      position,
      of: chain.length,
      resume,
      canHandOff: escalation !== undefined && escalation.length > 0,
      recorder,
      now: input.now,
      citations: input.citations,
      isCitable: input.isCitable,
      entryMs: ms,
    });
    if (answered !== undefined && 'handoff' in answered) {
      const next = escalation ?? [];
      resume = answered.handoff;
      chain = [...chain.slice(0, position + 1), ...next];
      input.onEscalated?.(entry, next);
      continue;
    }
    if (answered !== undefined) {
      if (answered.outcome === 'answered') logInfo('assistant model answered');
      return {
        ...answered,
        attempts,
        toolCalls,
        usage: usageOf(),
        sources,
        actionSummaries,
        web,
        webSources: [...webSources],
        toolsOffered: [...toolsOffered],
        ...(lastError === undefined ? {} : { lastError }),
        // A guard failure after an earlier daily cap still carries the cap.
        ...(answered.outcome === 'failed' && sawDailyCap ? { dailyQuota: earliestQuota() } : {}),
      };
    }
  }

  const localLimit = localLimitOf(attempts);
  return {
    text: '',
    outcome: 'failed',
    attempts,
    toolCalls,
    usage: usageOf(),
    guard: { removed: [] },
    sources,
    actionSummaries,
    web,
    webSources: [...webSources],
    toolsOffered: [...toolsOffered],
    ...(lastError === undefined ? {} : { lastError }),
    ...(sawDailyCap ? { dailyQuota: earliestQuota() } : {}),
    ...(localLimit === undefined ? {} : { localLimit }),
  };
};

/** ADR 0137: rounds 2+ offer every 'all' tool and every 'returned-id' tool; 'first' tools never. */
export const laterRoundDeclarations = (
  declarations: readonly ToolDeclaration[],
): readonly ToolDeclaration[] => {
  const policy = new Map(TOOL_CATALOGUE.map((entry) => [entry.name, entry.rounds]));
  return declarations.filter((declaration) => {
    const rounds = policy.get(declaration.name);
    return rounds === 'all' || rounds === 'returned-id';
  });
};

const declarationsFor = (
  tools: LoopTools | undefined,
  provider: TextProvider,
  round: number,
): readonly ToolDeclaration[] => {
  if (tools === undefined) return [];
  if (!provider.capabilities.has('tools')) return [];
  return round === 1 ? [...tools.firstRound] : [...tools.laterRounds];
};

/** Round-1 state an escalated entry carries on from (provider parts removed). */
interface Resume {
  readonly messages: readonly GenerationMessage[];
  readonly handles: readonly string[];
  readonly round: number;
}

interface EntryHandoff {
  readonly handoff: Resume;
}

interface EntrySuccess {
  readonly outcome: 'answered' | 'failed';
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly answeredBy: {
    readonly providerId: string;
    readonly model: string;
    readonly keyId: string;
  };
  readonly finishReason?: string;
  readonly guard: AssistantTrace['guard'];
}

export const NEXT_STEP: Readonly<Record<string, string>> = {
  'tools not offered': 'Answer from what you already have.',
  'tool call budget used': 'Answer now from the results you have.',
  'too many calls in this round':
    'Call at most six tools in one turn; answer or call the rest next turn.',
  'acting tools run only in the first round':
    'Ask the member to confirm in one short sentence; it will run when they reply.',
  'unknown id': 'Use an id an earlier result in this request returned, or search again.',
  'result budget used': 'Answer now from the results you have.',
};
const refusedMessage = (call: ToolCall, reason: string): GenerationMessage => ({
  role: 'tool',
  toolName: call.name,
  ...(call.id === undefined ? {} : { toolCallId: call.id }),
  text: `Refused: ${reason}. ${NEXT_STEP[reason] ?? 'Answer from what you already have.'}`,
});

/** A tool-result title made safe to print in a "Cite as" line. */
const cleanCitationTitle = (title: string): string =>
  neutraliseMarkers(title)
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();

const runEntry = async (deps: {
  readonly entry: ChainEntry;
  readonly systemInstruction: string;
  readonly protectedText: string;
  readonly history: readonly GenerationMessage[];
  readonly userText: string;
  readonly initialHandles: readonly string[];
  readonly tools: LoopTools | undefined;
  readonly limits: LoopLimits;
  readonly modelIds: readonly string[];
  readonly attempts: Attempt[];
  readonly toolCalls: TraceToolCall[];
  readonly sources: ToolSource[];
  /** B2b: per-request summaries, shared across entries so failover never resets them. */
  readonly actionSummaries: string[];
  /** Per-request budgets, shared across entries so failover never resets them. */
  readonly budgets: { callsUsed: number; resultChars: number };
  readonly recordUsage: (usage: GenerateTextResponse['usage']) => void;
  readonly noteError: (err: ProviderError) => void;
  readonly recordWeb: (source: 'brave' | 'tavily') => void;
  /** Task G3: round-1 declaration names actually sent, in first-sent order. */
  readonly recordOffered: (names: readonly string[]) => void;
  readonly onDailyCap: (resetAt: number | undefined) => void;
  readonly instance?: InstanceScope | undefined;
  readonly reserveCall?: ReserveCall | undefined;
  readonly logger?: Pick<Logger, 'warn' | 'info'> | undefined;
  readonly guildId?: string | undefined;
  /** ADR 0129 §5: the invocation id; every assistant log line carries it. */
  readonly runId?: string | undefined;
  /** ADR 0129 §6: this entry's place in the chain, for the ledger's model steps. */
  readonly position: number;
  readonly of: number;
  readonly resume?: Resume | undefined;
  readonly canHandOff?: boolean | undefined;
  /** ADR 0129 §6: the run's step log. */
  readonly recorder: RunRecorder;
  readonly citations?: CitationRegistry | undefined;
  readonly isCitable?: ((source: { title: string; url: string }) => boolean) | undefined;
  readonly now: () => number;
  readonly entryMs: () => number;
}): Promise<EntrySuccess | EntryHandoff | undefined> => {
  const { entry, limits } = deps;
  const provider = entry.provider as TextProvider;
  const handles = new Set<string>(deps.resume?.handles ?? deps.initialHandles);
  const messages: GenerationMessage[] = deps.resume
    ? [...deps.resume.messages]
    : [...deps.history, { role: 'user', text: deps.userText }];
  // Tools run only when they were offered: a provider without the `tools`
  // capability answers text-only, and any tool calls it returns anyway are
  // refused rather than executed.
  const toolsRunnable = deps.tools !== undefined && provider.capabilities.has('tools');

  /**
   * ADR 0129 §6: a failed attempt is a ledger step too, copying the attempt
   * just pushed — only codes, ms and tokens, never message text. The event's
   * `ms` is the failed call's own duration when the caller passes it;
   * `attempt.ms` keeps its entry-based meaning.
   */
  const pushFailedAttempt = (attempt: Attempt, eventMs?: number): void => {
    deps.attempts.push(attempt);
    deps.recorder.event({
      kind: 'model-result',
      provider: entry.providerId,
      model: entry.model,
      keyId: entry.keyId,
      ok: false,
      ms: eventMs ?? attempt.ms,
      ...(attempt.code === undefined ? {} : { code: attempt.code }),
      ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
      ...(attempt.netCode === undefined ? {} : { netCode: attempt.netCode }),
      ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
      ...(attempt.upstream === undefined ? {} : { upstream: attempt.upstream }),
      ...(attempt.completionTokens === undefined
        ? {}
        : { completionTokens: attempt.completionTokens }),
      ...(attempt.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: attempt.reasoningTokens }),
      ...(attempt.providerMessage === undefined
        ? {}
        : { providerMessage: attempt.providerMessage }),
    });
  };

  const failAttempt = (err: unknown, callMs?: number): void => {
    if (err instanceof ProviderError) deps.noteError(err);
    const f = classifyProviderFailure(err, {
      provider: entry.providerId,
      model: entry.model,
    }); // ADR 0129 §3: the trace keeps the adapter's message after
    // `sanitizeProviderMessage` — scrubbed of key-shaped strings, at most 160
    // characters. The raw text never reaches the trace.
    const providerMessage = err instanceof Error ? sanitizeProviderMessage(err.message) : undefined;
    const failureDetail =
      err instanceof ProviderError
        ? {
            ...(err.finishReason === undefined ? {} : { finishReason: err.finishReason }),
            ...(err.upstream === undefined ? {} : { upstream: err.upstream }),
            ...(err.emptyAnswer?.completionTokens === undefined
              ? {}
              : { completionTokens: err.emptyAnswer.completionTokens }),
            ...(err.emptyAnswer?.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: err.emptyAnswer.reasoningTokens }),
          }
        : {};
    /** ADR 0143: one cooldown row per failed key and model; fixed reasons only. */
    const persistCooldown = (error: unknown): void => {
      if (deps.instance === undefined || !(error instanceof ProviderError)) return;
      const now = deps.now();
      const base = {
        keyId: entry.selectedKeyId ?? entry.keyId,
        model: entry.model,
        setAt: now,
        ...(error.learnedLimit?.perDay === undefined
          ? {}
          : { learnedPerDay: error.learnedLimit.perDay }),
        ...(error.learnedLimit?.perMinute === undefined
          ? {}
          : { learnedPerMinute: error.learnedLimit.perMinute }),
      };
      if (error.kind === 'quota' && error.quotaScope === 'day') {
        assistantKeyCooldownsRepo.setCooldown(deps.instance, {
          ...base,
          until: nextProviderDayStart(entry.providerId, now),
          reason: 'daily-quota',
        });
      } else if (error.kind === 'quota' && error.quotaScope === 'daily-free') {
        assistantKeyCooldownsRepo.setCooldown(deps.instance, {
          ...base,
          until: error.resetAt ?? nextProviderDayStart(entry.providerId, now),
          reason: 'daily-quota',
        });
      } else if (
        (error.kind === 'quota' || error.kind === 'rate-limit') &&
        (error.quotaScope === 'minute' ||
          (error.kind === 'rate-limit' && error.retryAfterMs !== undefined))
      ) {
        assistantKeyCooldownsRepo.setCooldown(deps.instance, {
          ...base,
          until: now + (error.retryAfterMs ?? 60_000),
          reason: 'minute-quota',
        });
      } else if (error.kind === 'authentication') {
        assistantKeyCooldownsRepo.setCooldown(deps.instance, {
          ...base,
          until: Number.MAX_SAFE_INTEGER,
          reason: 'invalid-key',
        });
      }
    };
    const logFailure = (): void => {
      if (deps.logger === undefined) return;
      deps.logger.warn(
        safeLogFields({
          component: 'assistant',
          ...(deps.guildId === undefined ? {} : { guildId: deps.guildId }),
          ...(deps.runId === undefined ? {} : { runId: deps.runId }),
          provider: entry.providerId,
          model: entry.model,
          keyLabel: entry.keyLabel,
          code: f.code,
          ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
          ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
          ...(f.host === undefined ? {} : { host: f.host }),
          ms: deps.entryMs(),
          ...(f.finishReason === undefined ? {} : { finishReason: f.finishReason }),
          ...(f.upstream === undefined ? {} : { upstream: f.upstream }),
          // ADR 0129 §4 (partly reverses ADR 0079 §3): the journal's evidence
          // line keeps the sanitized short reason.
          ...(providerMessage === undefined ? {} : { providerMessage }),
        }),
        'provider attempt failed',
      );
    };
    persistCooldown(err);
    if (isDailyCap(err)) {
      deps.onDailyCap(err.resetAt);
      pushFailedAttempt(
        {
          provider: entry.providerId,
          model: entry.model,
          keyLabel: entry.keyLabel,
          outcome: 'error',
          reason: 'daily-free',
          code: f.code,
          ...(providerMessage === undefined ? {} : { providerMessage }),
          ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
          ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
          ...(f.host === undefined ? {} : { host: f.host }),
          ...failureDetail,
          ms: deps.entryMs(),
        },
        callMs,
      );
      logFailure();
      return;
    }
    const outcome: Attempt['outcome'] =
      err instanceof ProviderError && err.kind === 'rate-limit'
        ? 'rate-limit'
        : err instanceof ProviderError && err.kind === 'timeout'
          ? 'timeout'
          : isBusy(err)
            ? 'busy'
            : 'error';
    pushFailedAttempt(
      {
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome,
        // Hard rule 4 / ADR 0129 §3: `reason` stays a fixed string from the error's kind/status; the provider's own text is stored only sanitized, as `providerMessage`, which routes show only to config.read.
        ...(err instanceof Error ? { reason: attemptReasonFor(err) } : {}),
        code: f.code,
        ...(providerMessage === undefined ? {} : { providerMessage }),
        ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
        ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
        ...(f.host === undefined ? {} : { host: f.host }),
        ...failureDetail,
        ms: deps.entryMs(),
      },
      callMs,
    );
    logFailure();
  };

  const callProvider = async (
    round: number,
    extra: readonly GenerationMessage[] = [],
    offerTools = true,
  ): Promise<GenerateTextResponse | undefined> => {
    const reserved = deps.reserveCall?.(entry);
    if (reserved !== undefined && !reserved.ok) {
      deps.attempts.push(
        skippedLocalLimitAttempt(entry, reserved.code, reserved.availableAt, deps.entryMs()),
      );
      deps.recorder.event({
        kind: 'model-skipped',
        provider: entry.providerId,
        model: entry.model,
        keyId: entry.keyId,
        reason: reserved.code,
        availableAt: reserved.availableAt,
      });
      return undefined;
    }
    const declarations = offerTools ? declarationsFor(deps.tools, provider, round) : [];
    // Task G3: record what round 1 actually offered, after `declarationsFor`
    // filtering (capability, ID-tool narrowing). Later entries may re-offer
    // on failover; first-sent order is kept, duplicates dropped.
    if (round === 1) {
      deps.recordOffered(declarations.map((declaration) => declaration.name));
    }
    const request: GenerateTextRequest = {
      model: entry.model,
      systemInstruction: deps.systemInstruction,
      messages: [...messages, ...extra],
      maxOutputTokens: limits.maxOutputTokens,
      thinkingBudget: declarations.length > 0 ? limits.toolThinking : limits.answerThinking,
      ...(declarations.length === 0 ? {} : { tools: declarations }),
    };
    const callStarted = deps.now();
    try {
      // ADR 0129 §6: every provider call opens a ledger step before the request.
      deps.recorder.event({
        kind: 'model-call',
        position: deps.position,
        of: deps.of,
        provider: entry.providerId,
        model: entry.model,
        keyId: entry.keyId,
        ...(entry.keyLabel === undefined ? {} : { keyLabel: entry.keyLabel }),
        round,
      });
      const response = await provider.generateText(request);
      // An adapter or injected provider may violate its TypeScript contract at runtime.
      // Never let an invalid model response reach the output guard or tool runner.
      if (!response || typeof response.text !== 'string' || typeof response.model !== 'string') {
        throw new ProviderError('invalid-response', 'Provider returned an invalid response', false);
      }
      deps.recordUsage(response.usage);
      deps.recorder.event({
        kind: 'model-result',
        provider: entry.providerId,
        model: entry.model,
        keyId: entry.keyId,
        ok: true,
        ms: Math.max(0, deps.now() - callStarted),
        ...(response.usage?.promptTokens === undefined
          ? {}
          : { promptTokens: response.usage.promptTokens }),
        ...(response.usage?.completionTokens === undefined
          ? {}
          : { completionTokens: response.usage.completionTokens }),
        ...(response.usage?.thinkingTokens === undefined
          ? {}
          : { reasoningTokens: response.usage.thinkingTokens }),
        ...(response.usage?.costUsd === undefined ? {} : { costUsd: response.usage.costUsd }),
        ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
        ...(response.upstream === undefined ? {} : { upstream: response.upstream }),
        toolCalls: response.toolCalls?.length ?? 0,
      });
      return response;
    } catch (err) {
      failAttempt(err, Math.max(0, deps.now() - callStarted));
      return undefined;
    }
  };

  /** Runs one round's calls; every call appends a tool message, run or refused. */
  const runRoundCalls = async (
    round: number,
    calls: readonly ToolCall[],
  ): Promise<readonly GenerationMessage[]> => {
    const toolMessages: GenerationMessage[] = [];
    // Hoisted so the tag call below needs no assertion: a `const` keeps its
    // narrowing inside the citation closure.
    const citations = deps.citations;
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const traceBase = { round, name: call.name, args: call.args ?? {} };
      const startedCall = deps.now();
      const callMs = (): number => Math.max(0, deps.now() - startedCall);
      const run = toolsRunnable ? deps.tools?.run : undefined;
      if (run === undefined) {
        deps.toolCalls.push({
          ...traceBase,
          ok: false,
          refused: 'tools not offered',
          ms: callMs(),
          preview: '',
        });
        // ADR 0129 §6: a refused call records only the result, never a call.
        deps.recorder.event({
          kind: 'tool-result',
          round,
          tool: call.name,
          ok: false,
          refused: 'tools not offered',
          ms: callMs(),
          resultChars: 0,
        });
        toolMessages.push(refusedMessage(call, 'tools not offered'));
        continue;
      }
      if (deps.budgets.callsUsed >= limits.totalCalls) {
        deps.toolCalls.push({
          ...traceBase,
          ok: false,
          refused: 'tool call budget used',
          ms: callMs(),
          preview: '',
        });
        deps.recorder.event({
          kind: 'tool-result',
          round,
          tool: call.name,
          ok: false,
          refused: 'tool call budget used',
          ms: callMs(),
          resultChars: 0,
        });
        toolMessages.push(refusedMessage(call, 'tool call budget used'));
        continue;
      }
      if (index >= limits.perRound) {
        deps.toolCalls.push({
          ...traceBase,
          ok: false,
          refused: 'too many calls in this round',
          ms: callMs(),
          preview: '',
        });
        deps.recorder.event({
          kind: 'tool-result',
          round,
          tool: call.name,
          ok: false,
          refused: 'too many calls in this round',
          ms: callMs(),
          resultChars: 0,
        });
        toolMessages.push(refusedMessage(call, 'too many calls in this round'));
        continue;
      }
      if (round >= 2) {
        const rounds = TOOL_CATALOGUE.find((entry) => entry.name === call.name)?.rounds;
        if (rounds === 'first' || rounds === undefined) {
          deps.toolCalls.push({
            ...traceBase,
            ok: false,
            refused: 'acting tools run only in the first round',
            ms: callMs(),
            preview: '',
          });
          deps.recorder.event({
            kind: 'tool-result',
            round,
            tool: call.name,
            ok: false,
            refused: 'acting tools run only in the first round',
            ms: callMs(),
            resultChars: 0,
          });
          toolMessages.push(refusedMessage(call, 'acting tools run only in the first round'));
          continue;
        }
        const idArgs = rounds === 'returned-id' ? (RETURNED_ID_ARGS[call.name] ?? []) : undefined;
        if (idArgs !== undefined) {
          const argsRecord =
            typeof call.args === 'object' && call.args !== null
              ? (call.args as Record<string, unknown>)
              : undefined;
          // A call passes when any of the tool's id arguments carries an id an
          // earlier result returned; `open_resource` takes either id shape.
          const known = idArgs.some((idArg) => {
            const idValue = argsRecord?.[idArg];
            return typeof idValue === 'string' && handles.has(idValue);
          });
          if (!known) {
            deps.toolCalls.push({
              ...traceBase,
              ok: false,
              refused: 'unknown id',
              ms: callMs(),
              preview: '',
            });
            deps.recorder.event({
              kind: 'tool-result',
              round,
              tool: call.name,
              ok: false,
              refused: 'unknown id',
              ms: callMs(),
              resultChars: 0,
            });
            toolMessages.push(refusedMessage(call, 'unknown id'));
            continue;
          }
        }
      }
      if (deps.budgets.resultChars >= limits.resultChars) {
        deps.toolCalls.push({
          ...traceBase,
          ok: false,
          refused: 'result budget used',
          ms: callMs(),
          preview: '',
        });
        deps.recorder.event({
          kind: 'tool-result',
          round,
          tool: call.name,
          ok: false,
          refused: 'result budget used',
          ms: callMs(),
          resultChars: 0,
        });
        toolMessages.push(refusedMessage(call, 'result budget used'));
        continue;
      }
      deps.budgets.callsUsed += 1;
      // ADR 0129 §6: a tool that runs is a call step plus a result step.
      deps.recorder.event({ kind: 'tool-call', round, tool: call.name });
      const result = await run(call);
      deps.budgets.resultChars += result.text.length;
      for (const handle of result.handles ?? []) handles.add(handle);
      if (result.ok) {
        for (const source of result.sources) deps.sources.push(source);
        if (result.webSource !== undefined) deps.recordWeb(result.webSource);
        // B2b: only ok results carry a summary — a refused tool adds none.
        // A failover replay of the same content-derived write returns the same
        // summary; list it once so the answer carries one confirmation.
        if (
          result.actionSummary !== undefined &&
          !deps.actionSummaries.includes(result.actionSummary)
        )
          deps.actionSummaries.push(result.actionSummary);
      }
      deps.toolCalls.push({
        ...traceBase,
        ok: result.ok,
        ms: callMs(),
        preview: truncateResultForTrace(neutraliseMarkers(result.text)),
      });
      deps.recorder.event({
        kind: 'tool-result',
        round,
        tool: call.name,
        ok: result.ok,
        ms: callMs(),
        resultChars: result.text.length,
      });
      const citationText =
        result.ok && citations !== undefined
          ? (() => {
              const entries: string[] = [];
              for (const source of result.sources) {
                // Untrusted titles are never printed raw: a source is tagged
                // only when the caller says it is citable, and the printed
                // title is neutralised, bracket-free, single-line and capped.
                if (deps.isCitable?.(source) !== true) continue;
                const tag = citations.tag({ title: source.title, url: source.url });
                entries.push(`[${tag}] ${cleanCitationTitle(source.title)}`);
              }
              return entries.length === 0 ? '' : `\n\nCite as: ${entries.join('; ')}`;
            })()
          : '';
      toolMessages.push({
        role: 'tool',
        toolName: call.name,
        ...(call.id === undefined ? {} : { toolCallId: call.id }),
        text: `[UNTRUSTED TOOL RESULT tool=${result.name}]\n${neutraliseMarkers(result.text)}${citationText}\n[/UNTRUSTED TOOL RESULT]`,
      });
    }
    return toolMessages;
  };

  for (let round = deps.resume?.round ?? 1; round <= limits.rounds; round += 1) {
    const response = await callProvider(round);
    if (response === undefined) return undefined;
    const calls = response.toolCalls ?? [];
    if (calls.length === 0) {
      return finishEntry({
        entry,
        provider,
        response,
        messages,
        deps,
      });
    }
    // The assistant turn stays in the transcript so the next round sees what
    // was called; provider-specific parts are echoed back only within this
    // entry, never across entries (ADR 0075).
    messages.push({
      role: 'assistant',
      text: response.text,
      toolCalls: calls,
      ...(response.providerParts === undefined ? {} : { providerParts: response.providerParts }),
    });
    messages.push(...(await runRoundCalls(round, calls)));
    if (round === 1 && deps.canHandOff === true) {
      // The handing-over entry's call worked: it stays in the attempts list.
      deps.attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'ok',
        ms: deps.entryMs(),
      });
      return {
        handoff: {
          // Provider-specific parts never cross entries (ADR 0075).
          messages: messages.map((message) => {
            if (message.role !== 'assistant' || message.providerParts === undefined) return message;
            const clean: { -readonly [K in keyof GenerationMessage]: GenerationMessage[K] } = {
              ...message,
            };
            delete clean.providerParts;
            return clean;
          }),
          handles: [...handles],
          round: 2,
        },
      };
    }
  }

  // Rounds exhausted with the model still calling tools: one final call with
  // no declarations and the instruction to answer from the results so far.
  const extra: GenerationMessage = { role: 'user', text: ANSWER_INSTRUCTION };
  const final = await callProvider(0, [extra], false);
  if (final === undefined) return undefined;
  return finishEntry({ entry, provider, response: final, messages: [...messages, extra], deps });
};

const finishEntry = async (deps: {
  readonly entry: ChainEntry;
  readonly provider: TextProvider;
  readonly response: GenerateTextResponse;
  readonly messages: readonly GenerationMessage[];
  readonly deps: {
    readonly protectedText: string;
    readonly systemInstruction: string;
    readonly limits: LoopLimits;
    readonly modelIds: readonly string[];
    readonly attempts: Attempt[];
    readonly entryMs: () => number;
    readonly recordUsage: (usage: GenerateTextResponse['usage']) => void;
    readonly reserveCall?: ReserveCall | undefined;
    readonly logger?: Pick<Logger, 'warn' | 'info'> | undefined;
    readonly guildId?: string | undefined;
    /** ADR 0129 §5: the invocation id; every assistant log line carries it. */
    readonly runId?: string | undefined;
    /** ADR 0129 §6: this entry's place in the chain, for the ledger's retry call. */
    readonly position: number;
    readonly of: number;
    /** ADR 0129 §6: the run's step log. */
    readonly recorder: RunRecorder;
    readonly now: () => number;
  };
}): Promise<EntrySuccess | undefined> => {
  const outer = deps.deps;
  const okAttempt = (costUsd?: number): void => {
    // ADR 0129 §8: the answering response's own cost — the attempt carries no
    // other path to it. Defaults to the entry response; the guard-retry
    // branches below pass the retry's cost instead.
    const attemptCost = costUsd ?? deps.response.usage?.costUsd;
    outer.attempts.push({
      provider: deps.entry.providerId,
      model: deps.entry.model,
      keyLabel: deps.entry.keyLabel,
      outcome: 'ok',
      ms: outer.entryMs(),
      // ADR 0129 §4: a working answer keeps the same evidence fields, so a
      // later diagnosis sees the finish reason, upstream and cost directly.
      ...(deps.response.finishReason === undefined
        ? {}
        : { finishReason: deps.response.finishReason.slice(0, 40) }),
      ...(deps.response.upstream === undefined
        ? {}
        : { upstream: deps.response.upstream.slice(0, 60) }),
      ...(attemptCost === undefined ? {} : { costUsd: attemptCost }),
    });
  };
  const guarded = guardAnswer({
    text: deps.response.text,
    protectedText: outer.protectedText,
    modelIds: outer.modelIds,
  });
  // ADR 0129 §6: a guard that stripped text or blocked the answer is a ledger
  // step — only counts and the block reason, never the answer text.
  const recordGuard = (removed: readonly string[], blocked?: string): void => {
    if (removed.length === 0 && blocked === undefined) return;
    outer.recorder.event({
      kind: 'guard',
      removed: removed.length,
      ...(blocked === undefined ? {} : { blocked }),
    });
  };
  recordGuard(
    guarded.removed,
    !guarded.ok && guarded.reason === 'prompt-leak' ? 'prompt-leak' : undefined,
  );
  if (guarded.ok) {
    okAttempt();
    return {
      outcome: 'answered',
      text: guarded.text,
      model: deps.response.model,
      provider: deps.entry.providerId,
      answeredBy: {
        providerId: deps.entry.providerId,
        model: deps.entry.model,
        keyId: deps.entry.keyId,
      },
      ...(deps.response.finishReason === undefined
        ? {}
        : { finishReason: deps.response.finishReason.slice(0, 40) }),
      guard: { removed: [...guarded.removed] },
    };
  }
  if (guarded.reason === 'prompt-leak') {
    okAttempt();
    return {
      outcome: 'answered',
      text: PROMPT_LEAK_TEXT,
      model: deps.response.model,
      provider: deps.entry.providerId,
      answeredBy: {
        providerId: deps.entry.providerId,
        model: deps.entry.model,
        keyId: deps.entry.keyId,
      },
      ...(deps.response.finishReason === undefined
        ? {}
        : { finishReason: deps.response.finishReason.slice(0, 40) }),
      guard: { removed: [...guarded.removed], blocked: 'prompt-leak' },
    };
  }
  // Empty after stripping tool-call text: one retry with no declarations and
  // the same answer-now instruction, then the fixed failure text.
  const reserved = outer.reserveCall?.(deps.entry);
  if (reserved !== undefined && !reserved.ok) {
    outer.attempts.push(
      skippedLocalLimitAttempt(deps.entry, reserved.code, reserved.availableAt, outer.entryMs()),
    );
    outer.recorder.event({
      kind: 'model-skipped',
      provider: deps.entry.providerId,
      model: deps.entry.model,
      keyId: deps.entry.keyId,
      reason: reserved.code,
      availableAt: reserved.availableAt,
    });
  } else {
    // Hoisted so the catch below records the retry call's own duration.
    const retryStarted = outer.now();
    try {
      // ADR 0129 §6: the guard retry is its own ledger call, like any other.
      outer.recorder.event({
        kind: 'model-call',
        position: outer.position,
        of: outer.of,
        provider: deps.entry.providerId,
        model: deps.entry.model,
        keyId: deps.entry.keyId,
        ...(deps.entry.keyLabel === undefined ? {} : { keyLabel: deps.entry.keyLabel }),
        round: 0,
      });
      const retry = await deps.provider.generateText({
        model: deps.entry.model,
        systemInstruction: outer.systemInstruction,
        messages: [...deps.messages, { role: 'user', text: ANSWER_INSTRUCTION }],
        maxOutputTokens: outer.limits.maxOutputTokens,
        thinkingBudget: outer.limits.answerThinking,
      });
      outer.recordUsage(retry.usage);
      const second = guardAnswer({
        text: retry.text,
        protectedText: outer.protectedText,
        modelIds: outer.modelIds,
      });
      // ADR 0129 §6/§8: the retry's ledger result matches the trace — ok when
      // its answer is used (clean, or replaced by the prompt-leak text), and
      // a failed `provider-empty-answer` when the entry fails below, so model
      // health never counts a guard-emptied answer as a success.
      const retryUsed = second.ok || second.reason === 'prompt-leak';
      outer.recorder.event({
        kind: 'model-result',
        provider: deps.entry.providerId,
        model: deps.entry.model,
        keyId: deps.entry.keyId,
        ok: retryUsed,
        ms: Math.max(0, outer.now() - retryStarted),
        ...(retryUsed ? {} : { code: 'provider-empty-answer' }),
        ...(retry.usage?.promptTokens === undefined
          ? {}
          : { promptTokens: retry.usage.promptTokens }),
        ...(retry.usage?.completionTokens === undefined
          ? {}
          : { completionTokens: retry.usage.completionTokens }),
        ...(retry.usage?.thinkingTokens === undefined
          ? {}
          : { reasoningTokens: retry.usage.thinkingTokens }),
        ...(retry.usage?.costUsd === undefined ? {} : { costUsd: retry.usage.costUsd }),
        ...(retry.finishReason === undefined
          ? {}
          : { finishReason: retry.finishReason.slice(0, 40) }),
        ...(retry.upstream === undefined ? {} : { upstream: retry.upstream.slice(0, 60) }),
        toolCalls: retry.toolCalls?.length ?? 0,
      });
      if (second.ok) {
        okAttempt(retry.usage?.costUsd);
        recordGuard(second.removed);
        return {
          outcome: 'answered',
          text: second.text,
          model: retry.model,
          provider: deps.entry.providerId,
          answeredBy: {
            providerId: deps.entry.providerId,
            model: deps.entry.model,
            keyId: deps.entry.keyId,
          },
          ...(retry.finishReason === undefined ? {} : { finishReason: retry.finishReason }),
          guard: { removed: [...guarded.removed, ...second.removed] },
        };
      }
      if (second.reason === 'prompt-leak') {
        okAttempt(retry.usage?.costUsd);
        recordGuard(second.removed, 'prompt-leak');
        return {
          outcome: 'answered',
          text: PROMPT_LEAK_TEXT,
          model: retry.model,
          provider: deps.entry.providerId,
          answeredBy: {
            providerId: deps.entry.providerId,
            model: deps.entry.model,
            keyId: deps.entry.keyId,
          },
          ...(retry.finishReason === undefined ? {} : { finishReason: retry.finishReason }),
          guard: { removed: [...guarded.removed, ...second.removed], blocked: 'prompt-leak' },
        };
      }
    } catch (err) {
      // A failed retry is still a failed answer, not a chain error — but the
      // failure is a journal line (ADR 0129 §5), never a bare `catch {}`.
      // ADR 0129 §6: and a ledger step, like any other failed call.
      const f = classifyProviderFailure(err, {
        provider: deps.entry.providerId,
        model: deps.entry.model,
      });
      outer.recorder.event({
        kind: 'model-result',
        provider: deps.entry.providerId,
        model: deps.entry.model,
        keyId: deps.entry.keyId,
        ok: false,
        ms: Math.max(0, outer.now() - retryStarted),
        code: f.code,
        ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
        ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
        ...(f.finishReason === undefined ? {} : { finishReason: f.finishReason }),
        ...(f.upstream === undefined ? {} : { upstream: f.upstream }),
        ...(err instanceof Error ? { providerMessage: sanitizeProviderMessage(err.message) } : {}),
      });
      const outerLogger = outer.logger;
      if (outerLogger !== undefined) {
        outerLogger.warn(
          safeLogFields({
            component: 'assistant',
            ...(outer.guildId === undefined ? {} : { guildId: outer.guildId }),
            ...(outer.runId === undefined ? {} : { runId: outer.runId }),
            provider: deps.entry.providerId,
            model: deps.entry.model,
            keyLabel: deps.entry.keyLabel,
            code: f.code,
            ms: outer.entryMs(),
            ...(err instanceof Error
              ? { providerMessage: sanitizeProviderMessage(err.message) }
              : {}),
          }),
          'provider attempt failed',
        );
      }
    }
  }
  outer.attempts.push({
    provider: deps.entry.providerId,
    model: deps.entry.model,
    keyLabel: deps.entry.keyLabel,
    outcome: 'error',
    reason: 'empty-answer',
    code: 'provider-empty-answer',
    ...(deps.response.finishReason === undefined
      ? {}
      : { finishReason: deps.response.finishReason.slice(0, 40) }),
    ...(deps.response.upstream === undefined
      ? {}
      : { upstream: deps.response.upstream.slice(0, 60) }),
    ms: outer.entryMs(),
  });
  // Guard failure on the entry that answered: the loop fails here with the
  // fixed text; the caller maps it to "I couldn't finish that answer".
  return {
    outcome: 'failed',
    text: GUARD_FAILURE_TEXT,
    model: deps.response.model,
    provider: deps.entry.providerId,
    answeredBy: {
      providerId: deps.entry.providerId,
      model: deps.entry.model,
      keyId: deps.entry.keyId,
    },
    guard: { removed: [...guarded.removed] },
  };
};
