import { z } from 'zod';

/**
 * Custom ids for the task post worker's interactive messages
 * (review approvals, clarification picks, the completion choice).
 *
 * Mirrors `mod/confirmations.ts` and `panels/components.ts`: `core` may not
 * import discord.js (ADR 0014), and every custom id arrives from the client
 * as untrusted input parsed with Zod.
 */

export const TASK_CUSTOM_ID_PREFIX = 'bs.task';
const MAX_CUSTOM_ID = 100;

export type ParsedTaskCustomId =
  | { readonly action: 'approve' | 'reject'; readonly taskId: string; readonly version: number }
  | { readonly action: 'pick'; readonly choiceMessageId: string; readonly taskId: string }
  | { readonly action: 'complete' }
  | { readonly action: 'start'; readonly taskId: string; readonly version: number }
  | { readonly action: 'update'; readonly taskId: string };

export const buildTaskCustomId = (p: ParsedTaskCustomId): string => {
  switch (p.action) {
    case 'approve':
      return `${TASK_CUSTOM_ID_PREFIX}:approve:${p.taskId}:${p.version}`;
    case 'reject':
      return `${TASK_CUSTOM_ID_PREFIX}:reject:${p.taskId}:${p.version}`;
    case 'pick':
      return `${TASK_CUSTOM_ID_PREFIX}:pick:${p.choiceMessageId}:${p.taskId}`;
    case 'complete':
      return `${TASK_CUSTOM_ID_PREFIX}:complete`;
    case 'start':
      return `${TASK_CUSTOM_ID_PREFIX}:start:${p.taskId}:${p.version}`;
    case 'update':
      return `${TASK_CUSTOM_ID_PREFIX}:update:${p.taskId}`;
  }
};

const uuidSchema = z.string().uuid();
const versionSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((raw, ctx) => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'version out of range' });
      return z.NEVER;
    }
    return n;
  });
const snowflakeSchema = z.string().regex(/^\d{17,20}$/);

const taskCustomIdSchema = z
  .string()
  .max(MAX_CUSTOM_ID)
  .transform((raw, ctx): ParsedTaskCustomId | typeof z.NEVER => {
    const fail = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    };
    const parts = raw.split(':');
    if (parts[0] !== TASK_CUSTOM_ID_PREFIX) return fail('not a Bananasaurs task custom id');
    const action = parts[1];
    if (action === 'complete') {
      return parts.length === 2
        ? { action: 'complete' as const }
        : fail('not a Bananasaurs task custom id');
    }
    if (action === 'approve' || action === 'reject') {
      if (parts.length !== 4) return fail('not a Bananasaurs task custom id');
      const taskId = parts[2] ?? '';
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      const version = versionSchema.safeParse(parts[3] ?? '');
      if (!version.success) return fail('version out of range');
      return { action, taskId, version: version.data };
    }
    if (action === 'pick') {
      if (parts.length !== 4) return fail('not a Bananasaurs task custom id');
      const choiceMessageId = parts[2] ?? '';
      const taskId = parts[3] ?? '';
      if (!snowflakeSchema.safeParse(choiceMessageId).success)
        return fail('choice message id is not a snowflake');
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      return { action: 'pick' as const, choiceMessageId, taskId };
    }
    if (action === 'start') {
      if (parts.length !== 4) return fail('not a Bananasaurs task custom id');
      const taskId = parts[2] ?? '';
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      const version = versionSchema.safeParse(parts[3] ?? '');
      if (!version.success) return fail('version out of range');
      return { action: 'start' as const, taskId, version: version.data };
    }
    if (action === 'update') {
      if (parts.length !== 3) return fail('not a Bananasaurs task custom id');
      const taskId = parts[2] ?? '';
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      return { action: 'update' as const, taskId };
    }
    return fail('not a Bananasaurs task custom id');
  });

/** Non-throwing: an unparseable custom id belongs to another component, not an error. */
export const parseTaskCustomId = (raw: string): ParsedTaskCustomId | undefined => {
  const result = taskCustomIdSchema.safeParse(raw);
  return result.success ? result.data : undefined;
};
