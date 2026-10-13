import { z } from 'zod';

/** ADR 0140: links shown as buttons on a task card. Discord's button label budget is 34 with an emoji. */
export const TASK_LINKS_MAX = 5;
export const TASK_LINK_LABEL_MAX = 34;
export const TASK_LINK_URL_MAX = 512;

export const taskLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(TASK_LINK_LABEL_MAX),
    url: z
      .string()
      .max(TASK_LINK_URL_MAX)
      .url()
      .refine((url) => url.startsWith('https://'), 'must start with https://'),
  })
  .strict();

export const taskLinksSchema = z.array(taskLinkSchema).max(TASK_LINKS_MAX);
export type TaskLinkInput = z.infer<typeof taskLinkSchema>;
