import { describe, expect, it } from 'vitest';
import { LOG_EVENT_KINDS } from './subscriber.js';
import { logEventKindSchema, logRouteIdSchema, logRouteInputSchema } from './route-input.js';

const CHANNEL = '333333333333333333';
const OTHER_CHANNEL = '444444444444444444';

describe('logRouteInputSchema', () => {
  it('defaults the name and includeContent, leaves enabled undefined, and sorts and de-duplicates', async () => {
    const parsed = await logRouteInputSchema.parseAsync({
      channelId: CHANNEL,
      eventKinds: ['member_join', 'member_join', 'member_leave'],
      excludedChannelIds: [OTHER_CHANNEL, OTHER_CHANNEL],
    });
    expect(parsed.name).toBe(`→ ${CHANNEL}`);
    expect(parsed.includeContent).toBe(true);
    // Create resolves this to true; update resolves it to the stored route's
    // own state. A schema default here would silently re-enable a disabled
    // route on update.
    expect(parsed.enabled).toBe(undefined);
    expect(parsed.eventKinds).toEqual(['member_join', 'member_leave']);
    expect(parsed.excludedChannelIds).toEqual([OTHER_CHANNEL]);
  });

  it('keeps an explicit name, trimming it', async () => {
    const parsed = await logRouteInputSchema.parseAsync({
      name: '  mod log  ',
      channelId: CHANNEL,
      includeContent: false,
      enabled: false,
      eventKinds: ['member_join'],
      excludedChannelIds: [],
    });
    expect(parsed.name).toBe('mod log');
    expect(parsed.includeContent).toBe(false);
    expect(parsed.enabled).toBe(false);
  });

  it('rejects an unknown event kind', async () => {
    const result = await logRouteInputSchema.safeParseAsync({
      channelId: CHANNEL,
      eventKinds: ['membre_join'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message).join(';')).toContain(
      'no such log event kind: membre_join',
    );
  });

  it('rejects an empty event-kind list', async () => {
    const result = await logRouteInputSchema.safeParseAsync({
      channelId: CHANNEL,
      eventKinds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-snowflake destination channel', async () => {
    const result = await logRouteInputSchema.safeParseAsync({
      channelId: '#general',
      eventKinds: ['member_join'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects the destination listed among the exclusions', async () => {
    const result = await logRouteInputSchema.safeParseAsync({
      channelId: CHANNEL,
      eventKinds: ['member_join'],
      excludedChannelIds: [CHANNEL],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message).join(';')).toContain(
      'the destination channel cannot also be an excluded channel',
    );
  });

  it('accepts every LOG_EVENT_KINDS value, so `all` has something true to expand to', async () => {
    for (const kind of LOG_EVENT_KINDS) {
      expect(logEventKindSchema.safeParse(kind).success, kind).toBe(true);
    }
  });
});

describe('logRouteIdSchema', () => {
  it('accepts a UUID', () => {
    expect(
      logRouteIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success,
    ).toBe(true);
  });

  it("rejects 'abc'", () => {
    expect(logRouteIdSchema.safeParse('abc').success).toBe(false);
  });
});
