import { z } from 'zod';

/** ADR 0129 §6: where a run is in its life. */
export const RUN_STATES = [
  'queued',
  'running',
  'retry-wait',
  'answered',
  'refused',
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];
export const ACTIVE_RUN_STATES: readonly RunState[] = ['queued', 'running', 'retry-wait'];
/** What the run is doing right now. */
export const RUN_STAGES = [
  'queued',
  'starting',
  'conversation',
  'context',
  'calling-model',
  'running-tool',
  'retry-wait',
  'delivering',
  'done',
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/**
 * One step of a run (ADR 0129 §6). Metadata only — every member is .strict(), so a field that could
 * carry message text (question, answer, args, result) is rejected rather than stored.
 */
export const runEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('queued'),
      via: z.enum(['mention', 'reply', 'slash', 'dashboard', 'schedule']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('started'),
      attempt: z.number().int().min(1),
      queueWaitMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conversation'),
      continued: z.boolean(),
      historyTurns: z.number().int().nonnegative(),
      summaryVersion: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('context-built'),
      sections: z
        .array(
          z
            .object({
              name: z.string().max(80),
              chars: z.number().int().nonnegative(),
              estTokens: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(40),
      snippetChunks: z.number().int().nonnegative(),
      memories: z.number().int().nonnegative(),
      channelMessages: z.number().int().nonnegative(),
      toolsOffered: z.array(z.string().max(60)).max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal('model-call'),
      position: z.number().int().nonnegative(),
      of: z.number().int().positive(),
      provider: z.string().max(40),
      model: z.string().max(120),
      keyId: z.string().max(60),
      keyLabel: z.string().max(60).optional(),
      round: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('model-result'),
      provider: z.string().max(40),
      model: z.string().max(120),
      keyId: z.string().max(60),
      ok: z.boolean(),
      ms: z.number().int().nonnegative(),
      promptTokens: z.number().int().nonnegative().optional(),
      completionTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      finishReason: z.string().max(40).optional(),
      upstream: z.string().max(60).optional(),
      costUsd: z.number().nonnegative().optional(),
      code: z.string().max(60).optional(),
      httpStatus: z.number().int().optional(),
      netCode: z.string().max(60).optional(),
      providerMessage: z.string().max(200).optional(),
      toolCalls: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('model-skipped'),
      provider: z.string().max(40),
      model: z.string().max(120),
      keyId: z.string().max(60),
      reason: z.string().max(60),
      availableAt: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('routed'),
      tier: z.enum(['standard', 'light']),
      reason: z.string().max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-call'),
      round: z.number().int().nonnegative(),
      tool: z.string().max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-result'),
      round: z.number().int().nonnegative(),
      tool: z.string().max(60),
      ok: z.boolean(),
      refused: z.string().max(120).optional(),
      ms: z.number().int().nonnegative(),
      resultChars: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('guard'),
      removed: z.number().int().nonnegative(),
      blocked: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry-scheduled'),
      code: z.string().max(60),
      retryAt: z.number().int(),
      attempt: z.number().int().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('delivering'), parts: z.number().int().nonnegative() }).strict(),
  z
    .object({ kind: z.literal('delivered'), messageIds: z.array(z.string().max(25)).max(20) })
    .strict(),
  z
    .object({
      kind: z.literal('finished'),
      outcome: z.enum(['answered', 'refused', 'failed']),
      durationMs: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative().optional(),
      code: z.string().max(60).optional(),
      traceId: z.string().max(80).optional(),
    })
    .strict(),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export interface RunEventRow {
  readonly seq: number;
  readonly at: number;
  readonly event: RunEvent;
}
export interface RunRow {
  readonly runId: string;
  readonly conversationId?: string;
  readonly traceId?: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly behaviourId: string;
  readonly source: 'mention' | 'slash-command' | 'dashboard-test' | 'daily-digest';
  readonly state: RunState;
  readonly stage: RunStage;
  readonly attempt: number;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly retryAt?: number;
  readonly model?: string;
  readonly keyLabel?: string;
  readonly errorCode?: string;
  readonly totalTokens?: number;
}
