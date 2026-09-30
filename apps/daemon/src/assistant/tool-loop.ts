import {
  classifyProviderFailure,
  guardAnswer,
  ProviderError,
  safeLogFields,
  type AssistantTrace,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type GenerationMessage,
  type Logger,
  type TextProvider,
  type ToolCall,
  type ToolDeclaration,
  TRUNCATION_SUFFIX,
} from '@bananasaurs/core';
import type { CitationRegistry } from './citations.js';
import type { ChainEntry } from './model-chain.js';
import type { QuotaLedger } from './quota-ledger.js';
import type { AssistantToolResult, ToolSource } from './tools.js';
import { attemptReasonFor } from './provider-failure.js';
import { neutraliseMarkers } from './untrusted.js';

/**
 * The id arguments of every follow-up tool (ADR 0071). Round 2+ offers only
 * these tools, and only with an id an earlier result in the same request
 * returned (or in the catalogue the harness put in the prompt). Both —
 * `read_chunk` and `open_resource` — are implemented; the enforcement below
 * still names them. `open_resource` takes either id: the resource id opens
 * the resource, the doc id lists its headings (ADR 0092 decision 3).
 * `channel_history` pages with the `before` id an earlier page returned; in
 * round 1 a call without `before` is allowed (ADR 0092 decision 2).
 */
export const ID_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  read_chunk: ['chunkId'],
  open_resource: ['resourceId', 'docId'],
  channel_history: ['before'],
};

export interface LoopTools {
  /** Round 1 may call any allowed read-only tool. */
  readonly firstRound: readonly ToolDeclaration[];
  /** Rounds 2+: only ID_TOOL_ARGS names; filtered again before sending. */
  readonly idRound: readonly ToolDeclaration[];
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
const GUARD_FAILURE_TEXT = "I couldn't finish that answer — please try again.";
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
  readonly reserveCall?: ReserveCall | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
  readonly guildId?: string | undefined;
  readonly citations?: CitationRegistry | undefined;
  /**
   * Whether a tool result's source may be tagged for citation. Absent means
   * no source is citable and no "Cite as" line is emitted.
   */
  readonly isCitable?: ((source: { title: string; url: string }) => boolean) | undefined;
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
  let sawPrompt = false;
  let sawCompletion = false;
  let sawThinking = false;
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
  };
  const usageOf = (): AssistantTrace['usage'] => ({
    ...(sawPrompt ? { promptTokens } : {}),
    ...(sawCompletion ? { completionTokens } : {}),
    ...(sawThinking ? { thinkingTokens } : {}),
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

  for (const entry of input.chain) {
    const started = input.now();
    const ms = (): number => Math.max(0, input.now() - started);
    if (entry.provider === undefined || entry.skip !== undefined) {
      attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'skipped',
        ...(entry.skip === undefined ? {} : { reason: entry.skip }),
        ms: ms(),
      });
      continue;
    }
    const isFree = entry.model.endsWith(':free');
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
      continue;
    }

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
        cappedKeys.set(entry.keyId, resetAt);
        input.quotaLedger?.markExhausted(entry.keyId, resetAt ?? nextUtcMidnight(input.now()));
      },
      reserveCall: input.reserveCall,
      logger: input.logger,
      guildId: input.guildId,
      now: input.now,
      citations: input.citations,
      isCitable: input.isCitable,
      entryMs: ms,
    });
    if (answered !== undefined) {
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

const declarationsFor = (
  tools: LoopTools | undefined,
  provider: TextProvider,
  round: number,
): readonly ToolDeclaration[] => {
  if (tools === undefined) return [];
  if (!provider.capabilities.has('tools')) return [];
  const offered = round === 1 ? tools.firstRound : tools.idRound;
  // Follow-up rounds offer only the ID tools (`read_chunk`,
  // `open_resource`), filtered against the round's declarations.
  return round === 1 ? [...offered] : offered.filter((d) => d.name in ID_TOOL_ARGS);
};

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

const refusedMessage = (call: ToolCall, reason: string): GenerationMessage => ({
  role: 'tool',
  toolName: call.name,
  ...(call.id === undefined ? {} : { toolCallId: call.id }),
  text: `Refused: ${reason}`,
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
  readonly reserveCall?: ReserveCall | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
  readonly guildId?: string | undefined;
  readonly citations?: CitationRegistry | undefined;
  readonly isCitable?: ((source: { title: string; url: string }) => boolean) | undefined;
  readonly now: () => number;
  readonly entryMs: () => number;
}): Promise<EntrySuccess | undefined> => {
  const { entry, limits } = deps;
  const provider = entry.provider as TextProvider;
  const handles = new Set<string>(deps.initialHandles);
  const messages: GenerationMessage[] = [...deps.history, { role: 'user', text: deps.userText }];
  // Tools run only when they were offered: a provider without the `tools`
  // capability answers text-only, and any tool calls it returns anyway are
  // refused rather than executed.
  const toolsRunnable = deps.tools !== undefined && provider.capabilities.has('tools');

  const failAttempt = (err: unknown): void => {
    if (err instanceof ProviderError) deps.noteError(err);
    const f = classifyProviderFailure(err, {
      provider: entry.providerId,
      model: entry.model,
    });
    const logFailure = (): void => {
      if (deps.logger === undefined) return;
      deps.logger.warn(
        safeLogFields({
          component: 'assistant',
          ...(deps.guildId === undefined ? {} : { guildId: deps.guildId }),
          provider: entry.providerId,
          model: entry.model,
          keyLabel: entry.keyLabel,
          code: f.code,
          ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
          ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
          ...(f.host === undefined ? {} : { host: f.host }),
          ms: deps.entryMs(),
          ...(err instanceof Error ? { providerMessage: err.message } : {}),
        }),
        'provider attempt failed',
      );
    };
    if (isDailyCap(err)) {
      deps.onDailyCap(err.resetAt);
      deps.attempts.push({
        provider: entry.providerId,
        model: entry.model,
        keyLabel: entry.keyLabel,
        outcome: 'error',
        reason: 'daily-free',
        code: f.code,
        ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
        ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
        ...(f.host === undefined ? {} : { host: f.host }),
        ms: deps.entryMs(),
      });
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
    deps.attempts.push({
      provider: entry.providerId,
      model: entry.model,
      keyLabel: entry.keyLabel,
      outcome,
      // Hard rule 4: the attempt keeps a fixed reason from the error's
      // kind/status. The provider's own text stays in the Pino line only —
      // it can echo request details, so it never reaches the trace.
      ...(err instanceof Error ? { reason: attemptReasonFor(err) } : {}),
      code: f.code,
      ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
      ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
      ...(f.host === undefined ? {} : { host: f.host }),
      ms: deps.entryMs(),
    });
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
    try {
      const response = await provider.generateText(request);
      deps.recordUsage(response.usage);
      return response;
    } catch (err) {
      failAttempt(err);
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
        toolMessages.push(refusedMessage(call, 'too many calls in this round'));
        continue;
      }
      if (round >= 2) {
        const idArgs = ID_TOOL_ARGS[call.name];
        if (idArgs === undefined) {
          deps.toolCalls.push({
            ...traceBase,
            ok: false,
            refused: 'not allowed after reading results',
            ms: callMs(),
            preview: '',
          });
          toolMessages.push(refusedMessage(call, 'not allowed after reading results'));
          continue;
        }
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
          toolMessages.push(refusedMessage(call, 'unknown id'));
          continue;
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
        toolMessages.push(refusedMessage(call, 'result budget used'));
        continue;
      }
      deps.budgets.callsUsed += 1;
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

  for (let round = 1; round <= limits.rounds; round += 1) {
    const response = await callProvider(round);
    if (response === undefined) return undefined;
    const calls = response.toolCalls ?? [];
    if (calls.length === 0) {
      return finishEntry({ entry, provider, response, messages, deps });
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
  };
}): Promise<EntrySuccess | undefined> => {
  const outer = deps.deps;
  const okAttempt = (): void => {
    outer.attempts.push({
      provider: deps.entry.providerId,
      model: deps.entry.model,
      keyLabel: deps.entry.keyLabel,
      outcome: 'ok',
      ms: outer.entryMs(),
    });
  };
  const guarded = guardAnswer({
    text: deps.response.text,
    protectedText: outer.protectedText,
    modelIds: outer.modelIds,
  });
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
        : { finishReason: deps.response.finishReason }),
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
        : { finishReason: deps.response.finishReason }),
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
  } else {
    try {
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
      if (second.ok) {
        okAttempt();
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
        okAttempt();
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
    } catch {
      // A failed retry is still a failed answer, not a chain error.
    }
  }
  outer.attempts.push({
    provider: deps.entry.providerId,
    model: deps.entry.model,
    keyLabel: deps.entry.keyLabel,
    outcome: 'error',
    reason: 'empty-answer',
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
