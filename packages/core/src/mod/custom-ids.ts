import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';

/** ADR 0141 decision 5: targets travel in the id; every effect re-authorises the clicker. */
export type ModCardAction =
  | { action: 'delete'; channelId: string; messageId: string; authorId: string }
  | { action: 'warn'; userId: string }
  | { action: 'timeout'; userId: string }
  | { action: 'history'; userId: string; page: number };

const PREFIX = 'bs.mod';

export const buildModCustomId = (a: ModCardAction): string => {
  switch (a.action) {
    case 'delete':
      return `${PREFIX}:delete:${a.channelId}:${a.messageId}:${a.authorId}`;
    case 'warn':
    case 'timeout':
      return `${PREFIX}:${a.action}:${a.userId}`;
    case 'history':
      return `${PREFIX}:history:${a.userId}:${a.page}`;
  }
};

const id = snowflakeIdSchema;
const page = z.coerce.number().int().min(0).max(999);

export const parseModCustomId = (raw: string): ModCardAction | undefined => {
  if (raw.length > 100 || !raw.startsWith(`${PREFIX}:`)) return undefined;
  const parts = raw.split(':');
  const action = parts[1];
  if (action === 'delete' && parts.length === 5) {
    const parsed = z.tuple([id, id, id]).safeParse(parts.slice(2));
    return parsed.success
      ? {
          action,
          channelId: String(parsed.data[0]),
          messageId: String(parsed.data[1]),
          authorId: String(parsed.data[2]),
        }
      : undefined;
  }
  if ((action === 'warn' || action === 'timeout') && parts.length === 3) {
    const parsed = id.safeParse(parts[2]);
    return parsed.success ? { action, userId: String(parsed.data) } : undefined;
  }
  if (action === 'history' && parts.length === 4) {
    const parsed = z.tuple([id, page]).safeParse(parts.slice(2));
    return parsed.success
      ? { action, userId: String(parsed.data[0]), page: parsed.data[1] }
      : undefined;
  }
  return undefined;
};
