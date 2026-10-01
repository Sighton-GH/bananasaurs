import { z } from 'zod';

/**
 * Custom ids and components for the task post worker's interactive messages
 * (review approvals, clarification picks, completion select).
 *
 * Mirrors `mod/confirmations.ts` and `panels/components.ts`: `core` may not
 * import discord.js (ADR 0014), so these are the raw wire shapes (numeric
 * literals `ACTION_ROW = 1`, `BUTTON = 2`, `STRING_SELECT = 3`), and every
 * custom id arrives from the client as untrusted input parsed with Zod.
 */

export const TASK_CUSTOM_ID_PREFIX = 'bs.task';
const MAX_CUSTOM_ID = 100;

export type ParsedTaskCustomId =
  | { readonly action: 'approve' | 'reject'; readonly taskId: string; readonly version: number }
  | { readonly action: 'pick'; readonly choiceMessageId: string; readonly taskId: string }
  | { readonly action: 'complete' };

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
    return fail('not a Bananasaurs task custom id');
  });

/** Non-throwing: an unparseable custom id belongs to another component, not an error. */
export const parseTaskCustomId = (raw: string): ParsedTaskCustomId | undefined => {
  const result = taskCustomIdSchema.safeParse(raw);
  return result.success ? result.data : undefined;
};

// --- components ---------------------------------------------------------------

const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
/** Discord's `ButtonStyle` values used here: primary, secondary, success. */
const BUTTON_STYLE_PRIMARY = 1;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_SUCCESS = 3;

const buttonLabel = (title: string, max: number): string => title.trim().slice(0, max) || 'Task';

/** One action row: Approve (success) and Send back (secondary). */
export const buildReviewComponents = (taskId: string, version: number): readonly unknown[] => [
  {
    type: ACTION_ROW,
    components: [
      {
        type: BUTTON,
        style: BUTTON_STYLE_SUCCESS,
        custom_id: buildTaskCustomId({ action: 'approve', taskId, version }),
        label: 'Approve',
      },
      {
        type: BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        custom_id: buildTaskCustomId({ action: 'reject', taskId, version }),
        label: 'Send back',
      },
    ],
  },
];

/** One action row of up to 5 primary buttons, one per candidate task. */
export const buildPickComponents = (
  choiceMessageId: string,
  candidates: readonly { taskId: string; title: string }[],
): readonly unknown[] => [
  {
    type: ACTION_ROW,
    components: candidates.slice(0, 5).map((c) => ({
      type: BUTTON,
      style: BUTTON_STYLE_PRIMARY,
      custom_id: buildTaskCustomId({ action: 'pick', choiceMessageId, taskId: c.taskId }),
      label: buttonLabel(c.title, 80),
    })),
  },
];

/** One action row with one string select listing up to 25 tasks. */
export const buildCompleteSelect = (
  tasks: readonly { taskId: string; title: string; dueLabel: string }[],
): readonly unknown[] => [
  {
    type: ACTION_ROW,
    components: [
      {
        type: STRING_SELECT,
        custom_id: buildTaskCustomId({ action: 'complete' }),
        placeholder: 'Choose a task',
        options: tasks.slice(0, 25).map((t) => ({
          label: buttonLabel(t.title, 100),
          value: t.taskId,
          description: t.dueLabel.trim().slice(0, 100),
        })),
      },
    ],
  },
];

/** Appended to every proactive task post so members know how to log progress. */
export const TASK_REPLY_NOTICE =
  'Reply to this message to log progress. Messages that are not replies to a bot post and do not tag the bot are not read.';
