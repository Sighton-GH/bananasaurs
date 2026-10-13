import { describe, expect, it } from 'vitest';
import { buildModCustomId, parseModCustomId } from './custom-ids.js';

const C = '111111111111111111';
const M = '222222222222222222';
const U = '333333333333333333';

describe('bs.mod custom ids', () => {
  it.each([
    { action: 'delete', channelId: C, messageId: M, authorId: U },
    { action: 'warn', userId: U },
    { action: 'timeout', userId: U },
    { action: 'history', userId: U, page: 3 },
  ] as const)('round-trips %o', (a) => {
    const id = buildModCustomId(a);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseModCustomId(id)).toEqual(a);
  });
  it.each([
    'bs.mod:delete:1:2:3',
    'bs.mod:warn:abc',
    'bs.mod:history:333333333333333333:-1',
    'bs.mod:ban:333333333333333333',
    'bs.task:start:x:1',
    'modconfirm:abc',
    `bs.mod:warn:${'1'.repeat(200)}`,
  ])('ignores %s', (raw) => {
    expect(parseModCustomId(raw)).toBeUndefined();
  });
});
