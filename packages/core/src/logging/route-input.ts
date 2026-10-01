import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';
import { LOG_EVENT_KINDS } from './subscriber.js';

export const logEventKindSchema = z
  .string()
  .refine((k) => LOG_EVENT_KINDS.includes(k), (k) => ({
    message: `no such log event kind: ${k}`,
  }));

/**
 * What a client sends to create or replace a route (ADR 0123). Shared by the
 * HTTP API and the operator CLI so the two cannot disagree.
 */
export const logRouteInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    channelId: snowflakeIdSchema,
    includeContent: z.boolean().default(true),
    enabled: z.boolean().default(true),
    eventKinds: z.array(logEventKindSchema).min(1),
    excludedChannelIds: z.array(snowflakeIdSchema).max(500).default([]),
  })
  .refine((v) => !v.excludedChannelIds.includes(v.channelId), {
    message: 'the destination channel cannot also be an excluded channel',
    path: ['excludedChannelIds'],
  })
  .transform((v) => ({
    ...v,
    name: v.name ?? `→ ${v.channelId}`,
    eventKinds: [...new Set(v.eventKinds)].sort(),
    excludedChannelIds: [...new Set(v.excludedChannelIds)].sort(),
  }));

export type LogRouteInput = z.output<typeof logRouteInputSchema>;

export const logRouteIdSchema = z.string().uuid();
