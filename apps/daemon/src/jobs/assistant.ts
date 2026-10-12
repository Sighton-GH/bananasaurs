import {
  assistantInvokeCursor,
  assistantInvokePayload,
  assistantOrderingKey,
  assistantSummariseDedupeKey,
  JOB_KINDS,
  renderSummary,
  SAME_CHANNEL_LINK_WINDOW_MS,
  ProviderError,
  getLiveBuffer,
  resolveConversation,
  RetryAfterError,
  safeLogFields,
  splitForDiscord,
  stripNewTopic,
  totalTokensOf,
  type AssistantInvokePayload,
  type AssistantInvokeCursor,
  traceFailureCode,
  type AssistantTrace,
  type ChannelAccess,
  type ConversationResolution,
  type DiscordMessageRef,
  type GenerationMessage,
  type JobHandler,
  type Logger,
  type OutgoingMessage,
  type RecentMessage,
} from '@bananasaurs/core';
import {
  conversationRepo,
  jobRepo,
  runRepo,
  traceRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import type {
  AssistantCommandService,
  AssistantInvocationResult,
  AssistantTraceDetail,
  InvocationTrace,
} from '../assistant/commands.js';
import { BUSY_REPLY, dailyQuotaReply } from '../assistant/fallback-replies.js';
import { LocalLimitError, localLimitReply } from '../assistant/local-limit.js';
import { ChainFailedError } from '../assistant/chain-failed-error.js';
import {
  buildConversationContext,
  HISTORY_CHARS,
  HISTORY_TURNS,
} from '../assistant/conversation-context.js';
import { buildChannelContext } from '../assistant/channel-context.js';
import { PROVIDER_FAILURE_LOG_REASON, failureLogReason } from '../assistant/provider-failure.js';
import { assistantLogMessage, type AssistantLogInput } from '../assistant/log-message.js';
import { startTyping } from '../assistant/typing.js';
import {
  createRunRecorder,
  NOOP_RUN_RECORDER,
  type RunRecorder,
} from '../assistant/run-recorder.js';

/**
 * The subscriber (`apps/daemon/src/assistant/commands.ts`) enqueues mention
 * invocations for the conversation lookup, quote and resource fetches, and the
 * provider call. Without this split, one slow invocation stalls the per-guild
 * chain behind it.
 *
 * ADR 0086 means no new slash jobs are produced; this path remains to drain queued jobs.
 *
 * Four invariants the independent audit pinned down, plus Task 14's:
 *
 * - The behaviour is re-resolved at run time rather than trusted from the
 *   payload: a prompt edit or disable between enqueue and run takes effect,
 *   and a behaviour deleted in between fails closed with a plain answer.
 * - Invoke and delivery are staged through the job cursor. If the provider
 *   call succeeded but the Discord answer threw, a retry must NOT invoke
 *   again - a second invoke would repeat the provider spend and could
 *   duplicate the ticket and skill-activity effects. The cursor carries the
 *   finished result (and whether the answer landed) across attempts.
 * - Every answer joins a conversation (ADR 0072): replies and same-author
 *   follow-ups keep context, a tagged reply to someone else's message brings
 *   that message in as untrusted quoted context, and the answer posts as a
 *   Discord reply split into safe parts. `partsPosted`/`postedMessageIds`
 *   make a retry resume mid-parts without re-posting (hard rule 6); the
 *   provider is never called again once `invoke-done` is saved.
 * - Typing is best-effort and exempt from hard rule 6: its failure never
 *   fails the job.
 */
const reply = (content: string): OutgoingMessage => ({
  content: content.slice(0, 2_000),
  allowedMentions: { parse: [] },
});

/** Every delivery stage the worker may retry through. */
type CursorStage = 'invoke-done' | 'answered' | 'escalation-sent' | 'logged';
interface StagedCursor {
  readonly stage: CursorStage;
  readonly result: AssistantInvocationResult;
  readonly conversationId?: string | undefined;
  readonly resolution?: ConversationResolution | undefined;
  readonly partsPosted: number;
  readonly postedMessageIds: readonly string[];
  readonly flags: readonly string[];
}
const STAGES: readonly CursorStage[] = ['invoke-done', 'answered', 'escalation-sent', 'logged'];
/** Total order over stages: a retry resumes AFTER the furthest stage reached. */
const stageRank = (stage: CursorStage): number => STAGES.indexOf(stage);

/** A cursor result's validated run detail, minus the absent-marker. */
type CursorDetail = Exclude<AssistantInvokeCursor['result']['detail'], undefined>;
/** A cursor result's validated log-channel trace, minus the absent-marker. */
type CursorTrace = Exclude<AssistantInvokeCursor['result']['trace'], undefined>;
/** The cursor's validated conversation resolution, minus the absent-marker. */
type CursorResolution = Exclude<AssistantInvokeCursor['resolution'], undefined>;

/**
 * Zod's optional fields come back as `undefined`; the result type wants them
 * absent, so each optional is spread only when defined — the compiler, not a
 * cast, proves the rebuilt shape.
 */
const rebuildTrace = (trace: CursorTrace): InvocationTrace => ({
  latencyMs: trace.latencyMs,
  ...(trace.model === undefined ? {} : { model: trace.model }),
  ...(trace.tools === undefined
    ? {}
    : { tools: trace.tools.map((tool) => ({ name: tool.name, ok: tool.ok })) }),
  ...(trace.sources === undefined
    ? {}
    : { sources: trace.sources.map((source) => ({ title: source.title, url: source.url })) }),
  ...(trace.web === undefined ? {} : { web: trace.web }),
  ...(trace.usedFallback === undefined ? {} : { usedFallback: trace.usedFallback }),
});

/** Rebuilds the run detail the trace write reads, omitting every absent optional. */
const rebuildDetail = (detail: CursorDetail): AssistantTraceDetail => ({
  sections: detail.sections.map((section) => ({
    name: section.name,
    chars: section.chars,
    estTokens: section.estTokens,
    text: section.text,
  })),
  history: detail.history.map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            ...(call.id === undefined ? {} : { id: call.id }),
            name: call.name,
            args: call.args,
          })),
        }),
    ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.providerParts === undefined ? {} : { providerParts: message.providerParts }),
  })),
  attempts: detail.attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    ...(attempt.keyLabel === undefined ? {} : { keyLabel: attempt.keyLabel }),
    outcome: attempt.outcome,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    ...(attempt.code === undefined ? {} : { code: attempt.code }),
    ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
    ...(attempt.netCode === undefined ? {} : { netCode: attempt.netCode }),
    ...(attempt.host === undefined ? {} : { host: attempt.host }),
    ...(attempt.availableAt === undefined ? {} : { availableAt: attempt.availableAt }),
    ...(attempt.providerMessage === undefined ? {} : { providerMessage: attempt.providerMessage }),
    ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
    ...(attempt.upstream === undefined ? {} : { upstream: attempt.upstream }),
    ...(attempt.completionTokens === undefined
      ? {}
      : { completionTokens: attempt.completionTokens }),
    ...(attempt.reasoningTokens === undefined ? {} : { reasoningTokens: attempt.reasoningTokens }),
    ...(attempt.costUsd === undefined ? {} : { costUsd: attempt.costUsd }),
    ms: attempt.ms,
  })),
  toolCalls: detail.toolCalls.map((call) => ({
    round: call.round,
    name: call.name,
    args: call.args,
    ok: call.ok,
    ...(call.refused === undefined ? {} : { refused: call.refused }),
    ms: call.ms,
    preview: call.preview,
  })),
  usage: {
    ...(detail.usage.promptTokens === undefined ? {} : { promptTokens: detail.usage.promptTokens }),
    ...(detail.usage.completionTokens === undefined
      ? {}
      : { completionTokens: detail.usage.completionTokens }),
    ...(detail.usage.thinkingTokens === undefined
      ? {}
      : { thinkingTokens: detail.usage.thinkingTokens }),
  },
  guard: {
    removed: [...detail.guard.removed],
    ...(detail.guard.blocked === undefined ? {} : { blocked: detail.guard.blocked }),
  },
  // Slice 3: saved thinking per round. capTrace owns the 8,000-char
  // truncation (and its marker) at the storage boundary.
  ...(detail.reasoning === undefined
    ? {}
    : { reasoning: detail.reasoning.slice(0, 12).map((r) => ({ round: r.round, text: r.text })) }),
  ...(detail.model === undefined ? {} : { model: detail.model }),
  ...(detail.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
  ...(detail.web === undefined ? {} : { web: detail.web }),
  ...(detail.answeredBy === undefined
    ? {}
    : {
        answeredBy: {
          providerId: detail.answeredBy.providerId,
          model: detail.answeredBy.model,
          keyId: detail.answeredBy.keyId,
        },
      }),
  // ADR 0093: the recalled conversation ids ride the cursor to the link
  // write below, like every other detail field.
  ...(detail.recalled === undefined ? {} : { recalled: [...detail.recalled] }),
  ...(detail.included === undefined
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
});

/**
 * Rebuilds the resolution so its shape matches exactly: the `new` variant's
 * `quotedMessageId` is omitted when undefined rather than assigned as such.
 */
const rebuildResolution = (resolution: CursorResolution): ConversationResolution => {
  if (resolution.kind === 'continue') {
    return {
      kind: 'continue',
      conversationId: resolution.conversationId,
      rule: resolution.rule,
    };
  }
  return {
    kind: 'new',
    rule: resolution.rule,
    ...(resolution.quotedMessageId === undefined
      ? {}
      : { quotedMessageId: resolution.quotedMessageId }),
  };
};

const parseCursor = (cursor: string | null): StagedCursor | undefined => {
  if (cursor === null) return undefined;
  try {
    // Own prior write, still validated (hard rule 3): a malformed row is
    // "no progress", never a TypeError on every retry.
    const parsed = assistantInvokeCursor.safeParse(JSON.parse(cursor));
    if (!parsed.success) return undefined;
    const { stage, result, conversationId, resolution, partsPosted, postedMessageIds, flags } =
      parsed.data;
    const trace = result.trace === undefined ? {} : { trace: rebuildTrace(result.trace) };
    const detail = result.detail === undefined ? {} : { detail: rebuildDetail(result.detail) };
    const rest = {
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(resolution === undefined ? {} : { resolution: rebuildResolution(resolution) }),
      partsPosted,
      postedMessageIds,
      flags,
    };
    // Task 20: the service-attached result flags (e.g.
    // `resources-unavailable`) travel in the cursor alongside the job's own
    // `quote-unavailable` flags so a retry keeps both.
    const resultFlags = result.flags === undefined ? {} : { flags: [...result.flags] };
    if (result.ok === false) {
      return {
        stage,
        result: {
          ok: false as const,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
          content: result.content,
          ...resultFlags,
          ...trace,
          ...detail,
        },
        ...rest,
      };
    }
    return {
      stage,
      result:
        result.escalation === undefined
          ? { ok: true, content: result.content, ...resultFlags, ...trace, ...detail }
          : {
              ok: true,
              content: result.content,
              escalation: result.escalation,
              ...resultFlags,
              ...trace,
              ...detail,
            },
      ...rest,
    };
  } catch {
    return undefined;
  }
};

/**
 * A retryable provider failure (429, 5xx, timeout) is what the job table is
 * for: rethrow so the job runs again. An overloaded model (Gemini's HTTP 503)
 * answers the same way two seconds later, so the retries are spaced out
 * rather than using the store's 1 s, 2 s, 4 s backoff: 10 s, 30 s, 90 s. That
 * is bounded below the store's default `maxAttempts` (5), so the member always
 * gets an answer, and ends well inside Discord's 15-minute interaction-token
 * window. Non-retryable failures answer at once.
 *
 * These delays are the defaults for the AI tuning setting
 * `assistant.retryDelaysMs`: at most 4 delays, so the ceiling
 * (`delays.length + 1`) never exceeds the store's `maxAttempts` of 5.
 */
const PROVIDER_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;

/**
 * ADR 0126 R1: how long a mention waits for the guild cache before retrying.
 * The store allows 5 attempts, so this gives login about a minute.
 */
const GUILD_NOT_READY_RETRY_MS = 15_000;

export const assistantInvokeHandler = (deps: {
  guildId: string;
  service: AssistantCommandService;
  /** `undefined` when the sealed token is not this process's - fail closed. */
  openToken: (sealed: string) => string | undefined;
  respond: (
    ref: { interactionId: string; token: string },
    message: OutgoingMessage,
  ) => Promise<DiscordMessageRef | undefined>;
  send: (channelId: string, message: OutgoingMessage) => Promise<DiscordMessageRef | undefined>;
  /** Slice 3: typing ceiling override; absent means 300,000 (the hard ceiling). */
  progressCeilingMs?: (() => number) | undefined;
  logger: Logger;
  /** ADR 0065: the AI log channel, read at run time; undefined means no log. */
  logChannelId: () => string | undefined;
  now: () => number;
  /**
   * Task 14: conversation wiring. Optional so pre-Task-14 callers (and the
   * golden-evaluation pair, which drives the real subscriber and handler
   * with no database) keep compiling: without it the job answers with no
   * history, no quote, no links and no trace. Production always wires it.
   */
  conversations?:
    | {
        readonly scope: GuildScope;
        /** This bot's user id, telling our own messages apart from quotes. */
        readonly botUserId: string;
        /** This bot's display name, used for the assistant turn and labels. */
        readonly botDisplayName: string;
      }
    | undefined;
  /** Task 14: the typing indicator. Best-effort; absent means no typing. */
  sendTyping?: ((channelId: string) => Promise<void>) | undefined;
  /** Test-only override for the typing keepalive interval. */
  typingIntervalMs?: number;
  /** Task 14: quoted-message fetch for unknown references. Absent means no quote. */
  fetchMessageContent?:
    | ((
        channelId: string,
        messageId: string,
      ) => Promise<{ authorId: string; authorName: string; content: string } | undefined>)
    | undefined;
  /**
   * ADR 0089: channel context for mentions — a guild-scoped closure over the
   * Discord port's `fetchChannelMessages`. Absent means no channel context.
   */
  fetchChannelMessages?:
    | ((
        channelId: string,
        opts: { before: string; limit: number },
      ) => Promise<readonly RecentMessage[] | undefined>)
    | undefined;
  /**
   * ADR 0126: Read gates the live channel-context fetches and Write gates
   * the reply. Optional so existing callers keep compiling; absent means no
   * gates. The quoted (replied-to) message fetch below is a handed message
   * and stays ungated.
   */
  channelAccess?: Pick<ChannelAccess, 'check'> | undefined;
  /**
   * ADR 0126 R1: whether the guild is in the client cache. The job worker
   * starts before login, so a mention queued at restart can run before
   * READY, when every channel resolves as unknown. Not ready is a retry,
   * never a skip. Absent means always ready.
   */
  guildReady?: (() => boolean) | undefined;
  /**
   * ADR 0089: the live channel-context window from the AI tuning settings
   * (`assistant.channelContextMessages`). Absent means the window is off.
   */
  readonly channelContextMessages?: (() => number) | undefined;
  /**
   * Task 7: the live retry delays from the AI tuning settings
   * (`assistant.retryDelaysMs`). Absent means today's 10 s / 30 s / 90 s
   * defaults; empty means the first retryable failure answers at once.
   */
  readonly retryDelaysMs?: (() => readonly number[]) | undefined;
  /**
   * ADR 0081: the member-facing clock zone for the local-limit free-up time.
   * Absent means UTC.
   */
  readonly timeZone?: (() => string) | undefined;
}): JobHandler<AssistantInvokePayload> => ({
  kind: JOB_KINDS.assistantInvoke,
  payload: assistantInvokePayload,
  async run(payload, context) {
    const startedAt = deps.now();
    // One-shot delivery for the pre-invoke failure paths (deleted behaviour,
    // daily cap, exhausted busy retries): short fixed strings that predate
    // Task 14's staged posting and stay exactly as they were.
    const answerSingle = async (content: string): Promise<string | undefined> => {
      if (payload.interaction !== undefined) {
        const token = deps.openToken(payload.interaction.sealedToken);
        if (token === undefined) return undefined; // fresh runs fail closed above; a stranded cursor skips the answer only
        const ref = await deps.respond(
          { interactionId: payload.interaction.interactionId, token },
          reply(content),
        );
        return ref?.messageId;
      } else if (payload.channelId !== undefined) {
        const ref = await deps.send(payload.channelId, reply(content));
        return ref?.messageId;
      }
      return undefined;
    };

    /**
     * ADR 0129 §6: the run's step log, bound to this guild and invocation.
     * The row is insert-or-ignore, so the subscriber's earlier `queuedAt`
     * survives. A write failure here warns once and records nothing further —
     * the run continues with the same outcome and reply.
     */
    const ledgerForRun = (): RunRecorder => {
      if (deps.conversations === undefined) return NOOP_RUN_RECORDER;
      try {
        runRepo.ensureRun(deps.conversations.scope, {
          runId: payload.invocationId,
          userId: payload.userId,
          ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
          behaviourId: payload.behaviourId,
          source: payload.source,
          queuedAt: startedAt,
        });
        return createRunRecorder({
          scope: deps.conversations.scope,
          guildId: deps.guildId,
          runId: payload.invocationId,
          now: deps.now,
          logger: deps.logger,
          live: getLiveBuffer(),
        });
      } catch (err) {
        deps.logger.warn(
          safeLogFields({
            component: 'assistant',
            guildId: deps.guildId,
            runId: payload.invocationId,
            err,
          }),
          'assistant run ledger write failed',
        );
        return NOOP_RUN_RECORDER;
      }
    };

    // Fail closed BEFORE any side effect when the answer can never be
    // delivered: a restart forgets the sealing key, and invoking anyway
    // would spend provider quota and write durable ticket/activity effects
    // nobody hears about (independent audit, round 2).
    //
    // Only BEFORE the invoke, though: once a cursor records `invoke-done`,
    // the durable effects (ticket row, activity) already exist, and stage 3
    // needs no token - a restart must still page the reviewers rather than
    // leave an open ticket nobody was told about.
    const prior = parseCursor(context.cursor);
    const reached = prior === undefined ? -1 : stageRank(prior.stage);
    if (
      prior === undefined &&
      payload.interaction !== undefined &&
      deps.openToken(payload.interaction.sealedToken) === undefined
    ) {
      deps.logger.warn(
        safeLogFields({
          component: 'assistant-job',
          guildId: deps.guildId,
          runId: payload.invocationId,
        }),
        'assistant invocation dropped: interaction token is not from this process',
      );
      return;
    }

    // ADR 0126: Write gates the reply. A fresh mention run in a channel the
    // bot may not post in stops before any behaviour lookup, invoke, typing
    // or send: the member sees no reply and no provider call is made. The
    // subscriber already gates at enqueue time; this re-check covers the
    // delay between enqueue and run. The interaction branch above is
    // untouched (no slash commands remain).
    //
    // ADR 0126 F4: the same check runs before every answer post below, not
    // just on a fresh run — a retry past `invoke-done` must not land a
    // staged answer in a channel Write was turned off for while the job
    // waited. Slash answers are not channel posts, so the helper passes
    // them through; the escalation and log stages post to operator
    // channels, which stay exempt.
    const writeAllowedNow = async (): Promise<boolean> => {
      if (
        payload.source !== 'mention' ||
        payload.channelId === undefined ||
        deps.channelAccess === undefined
      )
        return true;
      if (deps.guildReady !== undefined && !deps.guildReady()) {
        throw new RetryAfterError('guild not cached yet', GUILD_NOT_READY_RETRY_MS);
      }
      const decision = await deps.channelAccess.check('write', payload.channelId);
      if (decision.allowed) return true;
      deps.logger.info(
        safeLogFields({
          component: 'assistant-job',
          guildId: deps.guildId,
          runId: payload.invocationId,
          channelId: payload.channelId,
          purpose: 'write',
          reason: decision.reason,
        }),
        'assistant invocation skipped: channel not writable',
      );
      return false;
    };
    if (prior === undefined) {
      if (!(await writeAllowedNow())) {
        if (deps.conversations !== undefined) {
          const key = payload.invocationId;
          const traceId = `trace_${key}`;
          if (traceRepo.getTrace(deps.conversations.scope, traceId) === undefined) {
            traceRepo.insertTrace(deps.conversations.scope, {
              traceId,
              runId: payload.invocationId,
              at: deps.now(),
              userId: payload.userId,
              ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
              behaviourId: payload.behaviourId,
              command: payload.command,
              source: payload.source,
              question: Object.values(payload.input).join('\n'),
              outcome: 'refused',
              durationMs: Math.max(0, deps.now() - startedAt),
              attempts: [],
              sections: [],
              toolCalls: [],
              usage: {},
              guard: { removed: [] },
              timeline: [{ label: 'received', atMs: 0 }],
              error: {
                kind: 'channel-not-writable',
                message: 'Bananasaurs may not post in this channel (channel permissions).',
              },
              discordMessageIds: [],
              sources: [],
              flags: ['channel-not-writable'],
            });
          }
          // ADR 0129 §6: the refused run still closes its ledger row.
          ledgerForRun().event({
            kind: 'finished',
            outcome: 'refused',
            durationMs: Math.max(0, deps.now() - startedAt),
            traceId,
          });
        }
        return;
      }
    }

    // ADR 0129 §6: every step of the run lands in the run ledger, on every
    // attempt including retries.
    const recorder = ledgerForRun();
    {
      let queueWaitMs = 0;
      if (deps.conversations !== undefined) {
        try {
          const queuedAt = runRepo.getRun(deps.conversations.scope, payload.invocationId)?.queuedAt;
          queueWaitMs = Math.max(0, startedAt - (queuedAt ?? startedAt));
        } catch {
          queueWaitMs = 0;
        }
      }
      recorder.event({ kind: 'started', attempt: context.attempts, queueWaitMs });
    }

    const behaviourName = async (): Promise<string> =>
      (await deps.service.behavioursForGuild(deps.guildId)).find(
        (b) => b.id === payload.behaviourId,
      )?.name ?? payload.behaviourId;
    const logEntry = async (
      entry: Pick<AssistantLogInput, 'outcome' | 'answer' | 'reason' | 'trace'>,
    ): Promise<OutgoingMessage> =>
      assistantLogMessage({
        userId: payload.userId,
        channelId: payload.channelId,
        behaviourName: await behaviourName(),
        command: payload.command,
        source: payload.source,
        question: Object.values(payload.input).join('\n'),
        at: deps.now(),
        ...entry,
      });
    /**
     * A failure is logged best-effort: the member has already been answered
     * and the job completes, so a broken log channel must not retry the job
     * and answer them twice.
     */
    const logFailure = async (answerText: string, reason: string): Promise<void> => {
      const logChannelId = deps.logChannelId();
      if (logChannelId === undefined) return;
      try {
        await deps.send(
          logChannelId,
          await logEntry({ outcome: 'failed', answer: answerText, reason }),
        );
      } catch (err) {
        deps.logger.warn(
          safeLogFields({
            component: 'assistant-job',
            guildId: deps.guildId,
            runId: payload.invocationId,
            err,
          }),
          'assistant log channel post failed',
        );
      }
    };

    // `recentTurns` orders by (at, turnId), and our turn ids sort the
    // assistant turn (`turn_<k>_a`) before the user turn (`turn_<k>_u`) —
    // so equal timestamps would misorder the history. Stamp each turn
    // strictly after every existing one; under a live clock this is just
    // `now()`.
    const nextAt = (existing: readonly { readonly at: number }[]): number =>
      Math.max(deps.now(), ...existing.map((turn) => turn.at + 1));

    const saveStaged = (stage: CursorStage, result: AssistantInvocationResult): void => {
      context.saveCursor(
        JSON.stringify({
          stage,
          result,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(resolution === undefined ? {} : { resolution }),
          partsPosted,
          postedMessageIds,
          flags,
        } satisfies StagedCursor),
      );
    };

    // Stage 1: the invoke. Skipped on a retry that already finished it.
    let result: AssistantInvocationResult;
    let conversationId: string | undefined = prior?.conversationId;
    let resolution: ConversationResolution | undefined = prior?.resolution;
    let partsPosted = prior?.partsPosted ?? 0;
    let postedMessageIds: string[] = [...(prior?.postedMessageIds ?? [])];
    const flags: string[] = [...(prior?.flags ?? [])];
    let invokeDoneAt = startedAt;
    if (prior !== undefined) {
      result = prior.result;
    } else {
      let stopTyping = (): void => undefined;
      try {
        const behaviours = await deps.service.behavioursForGuild(deps.guildId);
        const behaviour = behaviours.find((b) => b.id === payload.behaviourId);
        if (behaviour === undefined || !behaviour.enabled) {
          const text = 'That assistant behaviour is no longer available. No action was taken.';
          if (deps.conversations !== undefined) {
            const key = payload.invocationId;
            const traceId = `trace_${key}`;
            if (traceRepo.getTrace(deps.conversations.scope, traceId) === undefined) {
              traceRepo.insertTrace(deps.conversations.scope, {
                traceId,
                runId: payload.invocationId,
                at: deps.now(),
                userId: payload.userId,
                ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
                behaviourId: payload.behaviourId,
                command: payload.command,
                source: payload.source,
                question: Object.values(payload.input).join('\n'),
                outcome: 'refused',
                durationMs: Math.max(0, deps.now() - startedAt),
                attempts: [],
                sections: [],
                toolCalls: [],
                usage: {},
                guard: { removed: [] },
                timeline: [{ label: 'received', atMs: 0 }],
                error: {
                  kind: 'behaviour-unavailable',
                  message: 'The behaviour was deleted or turned off before the request ran.',
                },
                discordMessageIds: [],
                sources: [],
                flags: [...flags],
              });
            }
          }
          await answerSingle(text);
          await logFailure(text, 'The behaviour was deleted or turned off before the request ran.');
          // ADR 0129 §6: the refused run closes its ledger row.
          recorder.event({
            kind: 'finished',
            outcome: 'refused',
            durationMs: Math.max(0, deps.now() - startedAt),
            ...(deps.conversations === undefined
              ? {}
              : { traceId: `trace_${payload.invocationId}` }),
          });
          return;
        }
        if (payload.channelId !== undefined && deps.sendTyping !== undefined) {
          stopTyping = startTyping(() => deps.sendTyping!(payload.channelId!), {
            ...(deps.typingIntervalMs === undefined ? {} : { intervalMs: deps.typingIntervalMs }),
            // Slice 3: while bytes arrive the indicator stays alive to the
            // hard ceiling; the finally below still stops it at run end.
            maxMs: deps.progressCeilingMs?.() ?? 300_000,
            onError: (err) =>
              deps.logger.warn(
                safeLogFields({
                  component: 'assistant-job',
                  guildId: deps.guildId,
                  runId: payload.invocationId,
                  err,
                }),
                'assistant typing indicator failed; continuing',
              ),
          });
        }
        // The conversation join: resolve, fetch an unknown quote, create the
        // row and the quote and user turns, then build the history. The ids derive from
        // the invocation anchor, so a retry reuses the same conversation and
        // turns instead of duplicating them. Needs a channel; a slash
        // invocation without one answers history-free.
        const rawQuestion = Object.values(payload.input).join('\n');
        const strippedQuestion = stripNewTopic(rawQuestion);
        let history: readonly GenerationMessage[] = [];
        let quoteEnvelope: string | undefined;
        let quoteInHistory = false;
        let channelContext: string | undefined;
        let channelMessages = 0;
        // ADR 0091 decision 5: the stored summary a continuing conversation
        // re-injects, with its version travelling to the trace. Assigned in
        // the conversation branch below; the invoke after it reads it.
        let storedSummary: ReturnType<typeof conversationRepo.getSummary> = undefined;
        // ADR 0092 decision 2: the oldest id of the channel-context window —
        // the `channel_history` tool's default `before`, so the first page
        // starts just above what the model already saw. The fetch reports
        // oldest first.
        let channelContextOldestId: string | undefined;
        if (payload.channelId !== undefined && deps.conversations !== undefined) {
          const conv = deps.conversations;
          const channelId = payload.channelId;
          const resolved = resolveConversation({
            now: deps.now(),
            channelId,
            authorId: payload.userId,
            botUserId: conv.botUserId,
            text: rawQuestion,
            ...(payload.referencedMessageId === undefined
              ? {}
              : { referencedMessageId: payload.referencedMessageId }),
            ...(payload.referencedAuthorId === undefined
              ? {}
              : { referencedAuthorId: payload.referencedAuthorId }),
            inThread: payload.threadParentId !== undefined,
            lookupMessage: (messageId) => conversationRepo.lookupMessage(conv.scope, messageId),
            latestForAuthor: (authorId, scopeChannelId) =>
              conversationRepo.latestForAuthor(conv.scope, authorId, scopeChannelId),
            latestWithBotReply: (scopeChannelId) =>
              conversationRepo.latestWithBotReply(conv.scope, scopeChannelId),
            withBotReplySince: (scopeChannelId, sinceMs) =>
              conversationRepo.withBotReplySince(conv.scope, scopeChannelId, sinceMs),
          });
          resolution = resolved;
          // Quoted rules name a message we do not know: fetch it in the same
          // channel as untrusted evidence. A fetch failure flags the trace
          // `quote-unavailable` and continues without the quote (ruling).
          let quoted: { authorId: string; authorName: string; content: string } | undefined;
          if (resolved.kind === 'new' && resolved.quotedMessageId !== undefined) {
            if (deps.fetchMessageContent === undefined) {
              flags.push('quote-unavailable');
            } else {
              try {
                const fetched = await deps.fetchMessageContent(channelId, resolved.quotedMessageId);
                if (fetched === undefined) flags.push('quote-unavailable');
                else
                  quoted = {
                    authorId: fetched.authorId,
                    authorName: fetched.authorName,
                    content: fetched.content,
                  };
              } catch (err) {
                deps.logger.warn(
                  safeLogFields({
                    component: 'assistant-job',
                    guildId: deps.guildId,
                    runId: payload.invocationId,
                    err,
                  }),
                  'assistant quoted message fetch failed; continuing without the quote',
                );
                flags.push('quote-unavailable');
              }
            }
          }
          const key = payload.invocationId;
          conversationId = resolved.kind === 'continue' ? resolved.conversationId : `conv_${key}`;
          const userTurnId = `turn_${key}_u`;
          const createdAt = deps.now();
          if (conversationRepo.getConversation(conv.scope, conversationId) === undefined) {
            const title = strippedQuestion.slice(0, 120);
            conversationRepo.createConversation(conv.scope, {
              conversationId,
              channelId,
              behaviourId: payload.behaviourId,
              startedBy: payload.userId,
              title: title === '' ? 'Assistant conversation' : title,
              source: 'discord',
              at: createdAt,
            });
          }
          // A crash between the row write and the links must not lose them:
          // the link writes are insert-or-ignore, so a `new` resolution
          // rewrites them on every run and a retry backfills them exactly
          // once.
          if (resolved.kind === 'new') {
            for (const linkedConversationId of conversationRepo.withBotReplySince(
              conv.scope,
              channelId,
              createdAt - SAME_CHANNEL_LINK_WINDOW_MS,
            )) {
              if (linkedConversationId !== conversationId) {
                conversationRepo.linkConversations(conv.scope, {
                  conversationId,
                  linkedConversationId,
                  kind: 'same-channel',
                  at: createdAt,
                });
              }
            }
            if (payload.threadParentId !== undefined) {
              const known = conversationRepo.lookupMessage(conv.scope, channelId);
              if (known !== undefined && known.channelId === payload.threadParentId) {
                conversationRepo.linkConversations(conv.scope, {
                  conversationId,
                  linkedConversationId: known.conversationId,
                  kind: 'thread-parent',
                  at: createdAt,
                });
              }
            }
          }

          // A new conversation that starts from a quoted message stores the
          // quote as the opening `quote` turn, before the user turn: the
          // pinned-quote window and the transcript both read it from there.
          // The id derives from the invocation anchor like the user turn, so
          // a retry reuses it instead of duplicating it.
          if (resolved.kind === 'new' && quoted !== undefined) {
            const quoteTurnId = `turn_${key}_q`;
            const beforeQuote = conversationRepo.listTurns(conv.scope, conversationId);
            if (!beforeQuote.some((turn) => turn.turnId === quoteTurnId)) {
              conversationRepo.appendTurn(conv.scope, {
                conversationId,
                turnId: quoteTurnId,
                at: nextAt(beforeQuote),
                role: 'quote',
                authorId: quoted.authorId,
                authorName: quoted.authorName,
                text: quoted.content,
              });
            }
          }
          const beforeUser = conversationRepo.listTurns(conv.scope, conversationId);
          if (!beforeUser.some((turn) => turn.turnId === userTurnId)) {
            conversationRepo.appendTurn(conv.scope, {
              conversationId,
              turnId: userTurnId,
              at: nextAt(beforeUser),
              role: 'user',
              authorId: payload.userId,
              authorName: payload.authorName ?? 'a member',
              text: strippedQuestion,
              joinRule: resolved.rule,
            });
          }
          // ADR 0091 decision 5: a continuing conversation re-injects its
          // stored summary ahead of the recent turns, and its version travels
          // with the invoke to the stored trace.
          storedSummary =
            resolved.kind === 'continue'
              ? conversationRepo.getSummary(conv.scope, conversationId)
              : undefined;
          const built = buildConversationContext({
            scope: conv.scope,
            resolution: resolved,
            ...(quoted === undefined ? {} : { quoted }),
            botDisplayName: conv.botDisplayName,
            // The turn just written above is stored, never history: the
            // question reaches the model once, as the request's user text.
            excludeTurnId: userTurnId,
            // ADR 0091 decision 5: a continuing conversation re-injects its
            // stored summary ahead of the recent turns.
            ...(storedSummary === undefined
              ? {}
              : { summaryText: renderSummary(storedSummary.summary) }),
            now: deps.now(),
          });
          history = built.history;
          quoteEnvelope = built.quoteEnvelope;
          quoteInHistory = built.quoteInHistory;
          // ADR 0089: channel context for mentions. The channel's recent
          // messages (and, in a thread, the thread's starter) travel as
          // untrusted background ahead of the question. A failed fetch flags
          // the trace `channel-context-unavailable` and continues without
          // the block — it never fails the answer. This sits inside the
          // fresh-invoke branch, so a retry past `invoke-done` never fetches
          // again.
          const channelWindow = deps.channelContextMessages?.() ?? 0;
          // ADR 0126: Read gates the live fetches below (the window and, in
          // a thread, the starter). The quoted fetch above is a handed
          // message and stays ungated. Denied skips the whole block and
          // flags the trace; the answer still goes out.
          let channelContextAllowed = true;
          if (
            payload.source === 'mention' &&
            payload.messageId !== undefined &&
            conversationId !== undefined &&
            channelWindow > 0 &&
            deps.fetchChannelMessages !== undefined &&
            deps.channelAccess !== undefined
          ) {
            if (!(await deps.channelAccess.check('read', channelId)).allowed) {
              channelContextAllowed = false;
              if (!flags.includes('channel-context-denied')) flags.push('channel-context-denied');
            }
          }
          if (
            payload.source === 'mention' &&
            payload.messageId !== undefined &&
            conversationId !== undefined &&
            channelWindow > 0 &&
            deps.fetchChannelMessages !== undefined &&
            channelContextAllowed
          ) {
            const flagUnavailable = (): void => {
              if (!flags.includes('channel-context-unavailable'))
                flags.push('channel-context-unavailable');
            };
            const invokingMessageId = payload.messageId;
            // In a thread the starter comes first: message `threadId` in the
            // parent channel, falling back to the thread itself (forum
            // posts). Its `at` is the thread id's snowflake time — the fetch
            // reports no timestamp of its own.
            let starter: { authorName: string; content: string; at: number } | undefined;
            if (payload.threadParentId !== undefined && deps.fetchMessageContent !== undefined) {
              try {
                const first = await deps.fetchMessageContent(payload.threadParentId, channelId);
                const fetched = first ?? (await deps.fetchMessageContent(channelId, channelId));
                if (fetched === undefined) {
                  deps.logger.warn(
                    safeLogFields({
                      component: 'assistant-job',
                      guildId: deps.guildId,
                      runId: payload.invocationId,
                    }),
                    'assistant thread starter fetch failed; continuing without the starter',
                  );
                  flagUnavailable();
                } else {
                  starter = {
                    authorName: fetched.authorName,
                    content: fetched.content,
                    at: Number(BigInt(channelId) >> 22n) + 1420070400000,
                  };
                }
              } catch (err) {
                deps.logger.warn(
                  safeLogFields({
                    component: 'assistant-job',
                    guildId: deps.guildId,
                    runId: payload.invocationId,
                    err,
                  }),
                  'assistant thread starter fetch failed; continuing without the starter',
                );
                flagUnavailable();
              }
            }
            try {
              const fetched = await deps.fetchChannelMessages(channelId, {
                before: invokingMessageId,
                limit: channelWindow,
              });
              if (fetched === undefined) {
                deps.logger.warn(
                  safeLogFields({
                    component: 'assistant-job',
                    guildId: deps.guildId,
                    runId: payload.invocationId,
                  }),
                  'assistant channel context fetch failed; continuing without the block',
                );
                flagUnavailable();
              } else {
                // The fetch reports oldest first: the window's oldest id is
                // the history tool's default cursor, even when every line was
                // excluded from the block itself.
                channelContextOldestId = fetched[0]?.messageId;
                // Already-linked messages are in the transcript; the invoking
                // message becomes the current question. Neither is repeated.
                const exclude = new Set<string>([invokingMessageId]);
                for (const id of conversationRepo.messageIdsForConversation(
                  conv.scope,
                  conversationId,
                )) {
                  exclude.add(id);
                }
                const context = buildChannelContext({
                  messages: fetched,
                  excludeMessageIds: exclude,
                  ...(starter === undefined ? {} : { starter }),
                  botUserId: conv.botUserId,
                  botDisplayName: conv.botDisplayName,
                  now: deps.now(),
                });
                if (context.block !== '') {
                  channelContext = context.block;
                  channelMessages = context.count;
                }
              }
            } catch (err) {
              deps.logger.warn(
                safeLogFields({
                  component: 'assistant-job',
                  guildId: deps.guildId,
                  runId: payload.invocationId,
                  err,
                }),
                'assistant channel context fetch failed; continuing without the block',
              );
              flagUnavailable();
            }
          }
          // ADR 0129 §6: the conversation join is a ledger step, and the row
          // now points at the conversation the turns went to.
          recorder.update({ conversationId });
          recorder.event({
            kind: 'conversation',
            continued: resolved.kind === 'continue',
            historyTurns: history.filter((message) => message.role === 'user').length,
            ...(storedSummary === undefined ? {} : { summaryVersion: storedSummary.version }),
          });
        }
        try {
          result = await deps.service.invoke({
            guildId: deps.guildId,
            channelId: payload.channelId,
            userId: payload.userId,
            callerRoleIds: payload.callerRoleIds,
            behaviour,
            command: payload.command,
            input: payload.input,
            source: payload.source,
            invocationId: payload.invocationId,
            history,
            ...(quoteEnvelope === undefined ? {} : { quoteEnvelope }),
            ...(quoteInHistory ? { quoteInHistory: true as const } : {}),
            ...(channelContext === undefined ? {} : { channelContext }),
            ...(channelMessages === 0 ? {} : { channelMessages }),
            ...(storedSummary === undefined ? {} : { summaryVersion: storedSummary.version }),
            ...(channelContextOldestId === undefined ? {} : { channelContextOldestId }),
            // ADR 0093: the conversation being answered in, so recall
            // never returns the conversation to itself.
            ...(conversationId === undefined ? {} : { conversationId }),
            askerName: payload.authorName,
            ...(payload.mentionedUserIds === undefined
              ? {}
              : { mentionedUserIds: payload.mentionedUserIds }),
            ...(payload.mentionedRoleIds === undefined
              ? {}
              : { mentionedRoleIds: payload.mentionedRoleIds }),
            ...(payload.hasAttachments === true ? { hasAttachments: true as const } : {}),
            referencedMessageId: payload.referencedMessageId,
            // ADR 0129 §6: the service records its context and model steps.
            recorder,
          });
        } finally {
          stopTyping();
        }
        invokeDoneAt = deps.now();
        // Task 20: flags the service attached to the result (currently only
        // `resources-unavailable`) join the job's own flags before the trace
        // write — the same way `quote-unavailable` above does — and persist
        // in the cursor via `saveStaged`, so a retry keeps them.
        for (const flag of result.flags ?? []) {
          if (!flags.includes(flag)) flags.push(flag);
        }
      } catch (err) {
        stopTyping();
        const delays = deps.retryDelaysMs?.() ?? PROVIDER_RETRY_DELAYS_MS;
        const ceiling = delays.length + 1;
        const isQuota = err instanceof ChainFailedError && err.quotaScope === 'daily-free';
        const isLocalLimit = err instanceof LocalLimitError;
        const willRetry =
          !isQuota &&
          !isLocalLimit &&
          err instanceof ProviderError &&
          err.retryable &&
          context.attempts < ceiling;
        const final = !willRetry;
        const attemptsOf = (value: unknown): AssistantTrace['attempts'] => {
          if (value instanceof ChainFailedError || value instanceof LocalLimitError) {
            return value.attempts ?? [];
          }
          return [];
        };
        const detailOf = (value: unknown): AssistantTraceDetail | undefined => {
          if (value instanceof ChainFailedError || value instanceof LocalLimitError) {
            return value.detail;
          }
          return undefined;
        };
        // ADR 0129: the same failure code History and the transcript show.
        const codeOf = (value: unknown): string | undefined =>
          traceFailureCode({
            attempts: attemptsOf(value),
            ...(value instanceof ChainFailedError
              ? { error: { kind: value.kind, message: value.summary } }
              : {}),
          }) ?? (value instanceof ChainFailedError ? value.code : undefined);
        /** ADR 0129 §1: one failed trace per job attempt, for any error. Skipped when the id exists. */
        const insertFailureTrace = (
          err: unknown,
          opts: { readonly final: boolean },
        ): string | undefined => {
          if (deps.conversations === undefined) return undefined;
          const conv = deps.conversations;
          const key = payload.invocationId;
          const traceId = `trace_${key}_a${context.attempts}`;
          if (traceRepo.getTrace(conv.scope, traceId) !== undefined) return traceId;
          const elapsed = Math.max(0, deps.now() - startedAt);
          const detail = detailOf(err);
          const attempts = attemptsOf(err);
          const included = detail?.included;
          const failureError =
            err instanceof ChainFailedError
              ? { kind: err.kind, message: err.summary }
              : err instanceof LocalLimitError
                ? { kind: err.code, message: 'every assistant model is at its configured limit' }
                : {
                    kind: 'internal',
                    message:
                      'An internal error stopped the request; the daemon log has the detail.',
                  };
          traceRepo.insertTrace(conv.scope, {
            traceId,
            runId: payload.invocationId,
            at: deps.now(),
            userId: payload.userId,
            ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
            behaviourId: payload.behaviourId,
            command: payload.command,
            source: payload.source,
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(opts.final && conversationId !== undefined ? { turnId: `turn_${key}_a` } : {}),
            question: Object.values(payload.input).join('\n'),
            outcome: 'failed',
            durationMs: elapsed,
            attempts,
            sections: detail?.sections ?? [],
            toolCalls: detail?.toolCalls ?? [],
            usage: detail?.usage ?? {},
            guard: detail?.guard ?? { removed: [] },
            ...(detail?.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
            ...(detail?.reasoning === undefined
              ? {}
              : { reasoning: detail.reasoning.slice(0, 12).map((r) => ({ ...r })) }),
            ...(included === undefined
              ? {}
              : {
                  included: {
                    toolsOffered: included.toolsOffered,
                    snippetChunkIds: included.snippetChunkIds,
                    quote: included.quote,
                    historyTurns: included.historyTurns,
                    ...(included.channelMessages === undefined
                      ? {}
                      : { channelMessages: included.channelMessages }),
                    ...(included.summaryVersion === undefined
                      ? {}
                      : { summaryVersion: included.summaryVersion }),
                  },
                }),
            timeline: [
              { label: 'received', atMs: 0 },
              { label: 'failed', atMs: elapsed },
            ],
            error: failureError,
            discordMessageIds: [],
            sources: [],
            flags: [...flags, opts.final ? 'gave-up' : `retry:${context.attempts}`],
          });
          return traceId;
        };
        /** ADR 0129 §6: a failed run closes its ledger row with the last
         * failed attempt's code and the failure trace id, when present. */
        const recordFailureFinished = (err: unknown, traceId: string | undefined): void => {
          const detail = detailOf(err);
          const total = detail === undefined ? null : totalTokensOf(detail.usage);
          const code = codeOf(err);
          recorder.event({
            kind: 'finished',
            outcome: 'failed',
            durationMs: Math.max(0, deps.now() - startedAt),
            ...(total === null ? {} : { totalTokens: total }),
            ...(code === undefined ? {} : { code }),
            ...(traceId === undefined ? {} : { traceId }),
          });
        };
        /** ADR 0129 §1: the failure reply saved as the assistant turn, linked to its trace. */
        const appendFailureTurn = (
          text: string,
          traceId: string,
          postedMessageId: string | undefined,
        ): void => {
          if (conversationId === undefined || deps.conversations === undefined) return;
          const conv = deps.conversations;
          const key = payload.invocationId;
          try {
            const turns = conversationRepo.listTurns(conv.scope, conversationId);
            const turnId = `turn_${key}_a`;
            if (turns.every((turn) => turn.turnId !== turnId)) {
              conversationRepo.appendTurn(conv.scope, {
                conversationId,
                turnId,
                at: nextAt(turns),
                role: 'assistant',
                authorName: conv.botDisplayName,
                text,
                traceId,
              });
            }
            if (payload.messageId !== undefined) {
              conversationRepo.linkMessages(conv.scope, conversationId, `turn_${key}_u`, 'user', [
                payload.messageId,
              ]);
            }
            if (postedMessageId !== undefined) {
              conversationRepo.linkMessages(conv.scope, conversationId, turnId, 'assistant', [
                postedMessageId,
              ]);
            }
          } catch (err) {
            deps.logger.warn(
              safeLogFields({
                component: 'assistant-job',
                guildId: deps.guildId,
                runId: payload.invocationId,
                err,
              }),
              'assistant failure turn write failed',
            );
          }
        };
        // ADR 0077: a daily free-model cap answers at once - no job retry,
        // no RetryAfterError - because a retry only burns another of
        // tomorrow's requests for the same guaranteed failure.
        if (err instanceof ProviderError && err.quotaScope === 'daily-free') {
          const text = dailyQuotaReply(err.resetAt, deps.now());
          const traceId = insertFailureTrace(err, { final: true });
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
              err,
            }),
            'assistant invocation hit a daily free-model quota cap; answering at once',
          );
          const posted = await answerSingle(text);
          if (traceId !== undefined) appendFailureTurn(text, traceId, posted);
          await logFailure(text, failureLogReason(attemptsOf(err)));
          recordFailureFinished(err, traceId);
          return;
        }
        // ADR 0081: every entry at its owner-set limit is answered at once
        // with the free-up time — no job retry, no RetryAfterError.
        if (err instanceof LocalLimitError) {
          const text = localLimitReply(err.availableAt, deps.now(), deps.timeZone?.() ?? 'UTC');
          const traceId = insertFailureTrace(err, { final: true });
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
              code: err.code,
              availableAt: err.availableAt,
            }),
            'every assistant model is at its configured limit; answering at once',
          );
          const posted = await answerSingle(text);
          if (traceId !== undefined) appendFailureTurn(text, traceId, posted);
          await logFailure(text, failureLogReason(attemptsOf(err)));
          recordFailureFinished(err, traceId);
          return;
        }
        if (err instanceof ProviderError && err.retryable && context.attempts < ceiling) {
          insertFailureTrace(err, { final: false });
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
              attempt: context.attempts,
              ...(err instanceof ChainFailedError ? { code: err.code } : { err }),
            }),
            'assistant invocation hit a retryable provider error; job will retry',
          );
          // ADR 0129 §6: the wait is a ledger step, with the same delay the
          // retry below uses.
          const delayMs = delays[context.attempts - 1] ?? delays.at(-1)!;
          recorder.event({
            kind: 'retry-scheduled',
            code: codeOf(err) ?? 'internal',
            retryAt: deps.now() + delayMs,
            attempt: context.attempts,
          });
          throw new RetryAfterError(err.message, delayMs);
        }
        // Anything else - or the last permitted attempt - answers the member
        // instead of vanishing into a job retry.
        const traceId = insertFailureTrace(err, { final });
        const code = codeOf(err);
        deps.logger.error(
          safeLogFields({
            component: 'assistant-job',
            guildId: deps.guildId,
            runId: payload.invocationId,
            ...(code !== undefined ? { code } : { err }),
          }),
          'assistant invocation failed before a response was produced',
        );
        const text =
          err instanceof ProviderError && err.retryable
            ? BUSY_REPLY
            : 'I could not complete that request. No action was taken.';
        const posted = await answerSingle(text);
        if (traceId !== undefined) appendFailureTurn(text, traceId, posted);
        const reason =
          err instanceof ChainFailedError || err instanceof LocalLimitError
            ? failureLogReason(attemptsOf(err))
            : PROVIDER_FAILURE_LOG_REASON;
        await logFailure(text, reason);
        recordFailureFinished(err, traceId);
        deps.logger.info(
          safeLogFields({
            component: 'assistant-job',
            guildId: deps.guildId,
            runId: payload.invocationId,
            outcome: 'failed',
            ...(code === undefined ? {} : { code }),
            ms: Math.max(0, deps.now() - startedAt),
            attempt: context.attempts,
          }),
          'assistant run finished',
        );
        return;
      } finally {
        // Backstop for every path after startTyping: the keepalive stops even
        // if a pre-invoke step throws or a future path skips the immediate
        // stop after invoke. Idempotent, so the normal stops are unaffected.
        stopTyping();
      }
      // Persist BEFORE the first delivery attempt: a delivery throw from here
      // on retries with this cursor and never re-invokes.
      partsPosted = 0;
      postedMessageIds = [];
      saveStaged('invoke-done', result);
    }

    // One part, posted where it belongs: a mention's first part replies to
    // the member's message, later parts are plain sends; a slash answer's
    // first part follows up the interaction (capturing its message id) and
    // later parts go to the channel. Returns the posted message id, or
    // `undefined` when Discord reported none (or there was nowhere to post).
    const postPart = async (
      index: number,
      text: string,
      slashToken: string | undefined,
      pings?: { readonly userIds: readonly string[]; readonly roles: readonly string[] },
    ): Promise<string | undefined> => {
      // ADR 0145: only the first part carries the ids; later parts stay `{ parse: [] }`.
      const allowedMentions: NonNullable<OutgoingMessage['allowedMentions']> = {
        parse: [],
        ...(pings === undefined || pings.userIds.length === 0 ? {} : { users: pings.userIds }),
        ...(pings === undefined || pings.roles.length === 0 ? {} : { roles: pings.roles }),
      };
      const message = (replyTo?: string): OutgoingMessage =>
        replyTo === undefined
          ? { content: text, allowedMentions }
          : { content: text, allowedMentions, replyTo };
      if (payload.interaction !== undefined) {
        if (index === 0) {
          // A stranded slash cursor whose token is gone skips the answer
          // only (as before Task 14): the escalation and log stages below
          // still run.
          if (slashToken === undefined) return undefined;
          const ref = await deps.respond(
            { interactionId: payload.interaction.interactionId, token: slashToken },
            message(),
          );
          return ref?.messageId;
        }
        if (payload.channelId === undefined) {
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
            }),
            'assistant follow-up part has no channel; dropping the remainder',
          );
          return undefined;
        }
        const ref = await deps.send(payload.channelId, message());
        return ref?.messageId;
      }
      if (payload.channelId === undefined) {
        deps.logger.warn(
          safeLogFields({
            component: 'assistant-job',
            guildId: deps.guildId,
            runId: payload.invocationId,
          }),
          'assistant mention answer has no channel; dropping the remainder',
        );
        return undefined;
      }
      if (index === 0 && payload.messageId !== undefined) {
        const ref = await deps.send(payload.channelId, message(payload.messageId));
        return ref?.messageId;
      }
      const ref = await deps.send(payload.channelId, message());
      return ref?.messageId;
    };

    // Stage 2: the staged answer. Parts `[0, partsPosted)` already landed, so
    // a retry posts only the rest; every part is saved before the next, so a
    // crash mid-parts never re-posts one (hard rule 6). Afterwards the
    // assistant turn, the message links and the trace land exactly once.
    if (reached < stageRank('answered')) {
      const parts = splitForDiscord(result.content);
      const slashToken =
        payload.interaction === undefined
          ? undefined
          : deps.openToken(payload.interaction.sealedToken);
      // Fresh slash runs passed the fail-closed check above, so the token is
      // good; a stranded retry with a dead token skips the whole answer.
      const answerable = payload.interaction === undefined || slashToken !== undefined;
      // ADR 0129 §6: the delivery is two ledger steps around the posts.
      recorder.event({ kind: 'delivering', parts: parts.length });
      if (answerable) {
        for (let index = partsPosted; index < parts.length; index += 1) {
          // ADR 0126 F4: Write turned off while the job waited leaves the
          // staged answer unposted — the cursor stays at `invoke-done` with
          // the posted count untouched, so a later retry resumes here.
          if (!(await writeAllowedNow())) {
            recorder.event({
              kind: 'finished',
              outcome: 'refused',
              durationMs: Math.max(0, deps.now() - startedAt),
              code: 'channel-not-writable',
            });
            return;
          }

          const posted = await postPart(
            index,
            parts[index]!,
            slashToken,
            index === 0 && result.ok ? result.pings : undefined,
          );
          if (posted !== undefined) postedMessageIds.push(posted);
          partsPosted = index + 1;
          saveStaged('invoke-done', result);
        }
      }
      recorder.event({ kind: 'delivered', messageIds: postedMessageIds.slice(0, 20) });
      if (conversationId !== undefined && deps.conversations !== undefined) {
        const conv = deps.conversations;
        const key = payload.invocationId;
        const assistantTurnId = `turn_${key}_a`;
        const beforeAssistant = conversationRepo.listTurns(conv.scope, conversationId);
        if (!beforeAssistant.some((turn) => turn.turnId === assistantTurnId)) {
          conversationRepo.appendTurn(conv.scope, {
            conversationId,
            turnId: assistantTurnId,
            at: nextAt(beforeAssistant),
            role: 'assistant',
            authorName: conv.botDisplayName,
            text: result.content,
            // Task 20: the turn carries its trace id so a later 👍/👎
            // reaction on a linked message can flag the matching trace.
            traceId: `trace_${key}`,
          });
        }
        if (payload.messageId !== undefined) {
          conversationRepo.linkMessages(conv.scope, conversationId, `turn_${key}_u`, 'user', [
            payload.messageId,
          ]);
        }
        if (postedMessageIds.length > 0) {
          conversationRepo.linkMessages(
            conv.scope,
            conversationId,
            assistantTurnId,
            'assistant',
            postedMessageIds,
          );
        }
        const traceId = `trace_${key}`;
        if (traceRepo.getTrace(conv.scope, traceId) === undefined) {
          const detail = result.detail;
          const outcome = result.ok ? 'answered' : (result.outcome ?? 'refused');
          traceRepo.insertTrace(conv.scope, {
            traceId,
            runId: payload.invocationId,
            at: deps.now(),
            userId: payload.userId,
            ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
            behaviourId: payload.behaviourId,
            command: payload.command,
            source: payload.source,
            conversationId,
            turnId: assistantTurnId,
            question: Object.values(payload.input).join('\n'),
            answer: result.content,
            outcome,
            durationMs: result.trace?.latencyMs ?? 0,
            attempts: detail?.attempts ?? [],
            ...(detail?.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
            usage: detail?.usage ?? {},
            sections: detail?.sections ?? [],
            toolCalls: detail?.toolCalls ?? [],
            guard: detail?.guard ?? { removed: [] },
            ...(detail?.reasoning === undefined
              ? {}
              : { reasoning: detail.reasoning.slice(0, 12).map((r) => ({ ...r })) }),
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
              { label: 'invoke-done', atMs: Math.max(0, invokeDoneAt - startedAt) },
              { label: 'answered', atMs: Math.max(0, deps.now() - startedAt) },
            ],
            discordMessageIds: [...postedMessageIds],
            sources: [...(result.trace?.sources ?? [])],
            flags: [...flags],
          });
          const totalTokens = detail === undefined ? null : totalTokensOf(detail.usage);
          deps.logger.info(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
              outcome,
              ...(result.trace?.model === undefined ? {} : { model: result.trace.model }),
              ms: result.trace?.latencyMs ?? 0,
              ...(totalTokens === null ? {} : { totalTokens }),
              attempt: context.attempts,
            }),
            'assistant run finished',
          );
        }
      }
      saveStaged('answered', result);
      // ADR 0129 §6: the answered (or refused) run closes its ledger row
      // with the trace id the insert above wrote.
      {
        const key = payload.invocationId;
        const outcome = result.ok ? 'answered' : (result.outcome ?? 'refused');
        const detail = result.detail;
        const total = detail === undefined ? null : totalTokensOf(detail.usage);
        recorder.event({
          kind: 'finished',
          outcome,
          durationMs: Math.max(0, deps.now() - startedAt),
          ...(total === null ? {} : { totalTokens: total }),
          ...(conversationId === undefined || deps.conversations === undefined
            ? {}
            : { traceId: `trace_${key}` }),
        });
      }
      // ADR 0093 decision 3: every conversation whose summary this run
      // looked back at is linked with kind `recalled`. The insert is
      // idempotent (insert-or-ignore) and this stage is skipped on a retry,
      // so a retry never duplicates a link.
      if (conversationId !== undefined && deps.conversations !== undefined) {
        const convScope = deps.conversations.scope;
        for (const recalledId of result.detail?.recalled ?? []) {
          try {
            conversationRepo.linkConversations(convScope, {
              conversationId,
              linkedConversationId: recalledId,
              kind: 'recalled',
              at: deps.now(),
            });
          } catch (err) {
            deps.logger.warn(
              safeLogFields({
                component: 'assistant-job',
                guildId: deps.guildId,
                runId: payload.invocationId,
                err,
              }),
              'assistant recalled link write failed; continuing',
            );
          }
        }
      }
      // ADR 0091 decision 3: turns that fell out of the history window get
      // one summary job on the entry that answered. An enqueue failure is
      // logged and never fails the answer.
      if (conversationId !== undefined && deps.conversations !== undefined) {
        try {
          const answeredBy = result.detail?.answeredBy;
          if (answeredBy !== undefined) {
            const convScope = deps.conversations.scope;
            const evicted = conversationRepo.evictedTurnsSince(convScope, conversationId, {
              afterAt: conversationRepo.getSummary(convScope, conversationId)?.throughAt ?? null,
              window: { maxTurns: HISTORY_TURNS, maxChars: HISTORY_CHARS },
            });
            const newest = evicted.at(-1);
            if (newest !== undefined) {
              jobRepo.enqueue(convScope, {
                kind: JOB_KINDS.assistantSummarise,
                payload: JSON.stringify({
                  conversationId,
                  throughAt: newest.at,
                  providerId: answeredBy.providerId,
                  model: answeredBy.model,
                  keyId: answeredBy.keyId,
                }),
                dedupeKey: assistantSummariseDedupeKey(conversationId, newest.at),
                orderingKey: assistantOrderingKey({
                  channelId: payload.channelId,
                  threadParentId: payload.threadParentId,
                  userId: payload.userId,
                }),
                now: deps.now(),
              });
            }
          }
        } catch (err) {
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              runId: payload.invocationId,
              err,
            }),
            'assistant summary enqueue failed; continuing without a summary',
          );
        }
      }
    }

    // Stage 3: the escalation post, with its own sent marker for the same
    // reason.
    if (
      reached < stageRank('escalation-sent') &&
      result.ok &&
      result.escalation !== undefined &&
      payload.channelId !== undefined
    ) {
      const reviewers = result.escalation.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ');
      await deps.send(result.escalation.channelId, {
        content:
          `${reviewers}${reviewers === '' ? '' : '\n'}IT request ${result.escalation.ticketId} from <@${payload.userId}> in <#${payload.channelId}>:\n${result.content}`.slice(
            0,
            2_000,
          ),
        allowedMentions: { parse: [], roles: result.escalation.reviewerRoleIds },
      });
      saveStaged('escalation-sent', result);
    }

    // Stage 4: the AI log channel (ADR 0065), after the member has their
    // answer. Its own marker, so a retry resumes here and never re-answers.
    const logChannelId = deps.logChannelId();
    if (reached < stageRank('logged') && logChannelId !== undefined) {
      await deps.send(
        logChannelId,
        await logEntry({
          outcome: result.ok ? 'answered' : (result.outcome ?? 'refused'),
          answer: result.content,
          trace: result.trace,
        }),
      );
      saveStaged('logged', result);
    }
  },
});
