import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { attributeAndLogDeletion, type MessageDeleteAttributionPorts } from './attribute-deletion.js';
import type { LogRoute } from './routing.js';
import type { LogMessageDeletePayload } from '../jobs/kinds.js';
import { parseSnowflakeId } from '../ids.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const DEST_A = '333333333333333333';
const DEST_B = '444444444444444444';
const AUTHOR = '555555555555555555';
const MESSAGE = '666666666666666666';
const logger = pino({ level: 'silent' });

const makeRoute = (over: Partial<LogRoute> & { routeId: string }): LogRoute => ({
  channelId: DEST_A,
  includeContent: true,
  enabled: true,
  excludedChannelIds: [],
  ...over,
});

const payload = (over: Partial<LogMessageDeletePayload> = {}): LogMessageDeletePayload => ({
  channelId: parseSnowflakeId(CHANNEL),
  messageId: parseSnowflakeId(MESSAGE),
  authorId: parseSnowflakeId(AUTHOR),
  content: 'hello',
  deletedAtMs: 1_000,
  ...over,
});

function makeFake() {
  const claims = new Set<string>();
  const sent: { channelId: string; content: string; allowedMentions: { parse: readonly [] } }[] =
    [];
  const failing = new Set<string>();
  let routes: LogRoute[] = [];
  let fetchCount = 0;
  let recordCount = 0;
  const attributions = new Map<string, { actorId: string | undefined; inferred: boolean }>();
  let claimedCounts = 0;
  const ports: MessageDeleteAttributionPorts = {
    guildId: GUILD,
    listEnabledRoutesFor: () => routes,
    fetchAuditLog: async () => {
      fetchCount += 1;
      return [];
    },
    claimedCountFor: () => 0,
    incrementClaimedCount: () => {
      claimedCounts += 1;
    },
    findExistingAttribution: (messageId) => attributions.get(messageId),
    recordAudit: ({ actorId, inferred, payload: p }) => {
      recordCount += 1;
      attributions.set(p.messageId, { actorId, inferred });
    },
    claim: ({ eventKind, fingerprint }) => {
      const key = `${eventKind}:${fingerprint}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    release: ({ eventKind, fingerprint }) => {
      claims.delete(`${eventKind}:${fingerprint}`);
    },
    sendMessage: async (channelId, message) => {
      sent.push({
        channelId,
        content: message.content,
        allowedMentions: message.allowedMentions,
      });
      if (failing.has(channelId)) throw new Error(`send failed: ${channelId}`);
      return undefined;
    },
    logger,
    now: () => 0,
  };
  return {
    ports,
    sent,
    failing,
    claims,
    setRoutes: (next: LogRoute[]) => {
      routes = next;
    },
    counts: () => ({ fetchCount, fetchCalls: fetchCount, recordCount, claimedCounts }),
  };
}

describe('attributeAndLogDeletion fan-out', () => {
  it('does nothing when no route matches — no audit fetch, no send', async () => {
    const fake = makeFake();
    fake.setRoutes([]);
    await attributeAndLogDeletion(fake.ports, payload());
    expect(fake.sent).toHaveLength(0);
    expect(fake.counts().fetchCount).toBe(0);
    expect(fake.counts().recordCount).toBe(0);
  });

  it('two routes mean one audit fetch, one recordAudit, two sends', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await attributeAndLogDeletion(fake.ports, payload());
    expect(fake.counts().fetchCount).toBe(1);
    expect(fake.counts().recordCount).toBe(1);
    expect(fake.sent.map((s) => s.channelId).sort()).toEqual([DEST_A, DEST_B].sort());
  });

  it('every deletion log post disables mention parsing, so quoted text never pings', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await attributeAndLogDeletion(fake.ports, payload({ content: 'hello @everyone' }));
    expect(fake.sent.length).toBeGreaterThan(0);
    for (const line of fake.sent) {
      expect(line.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('strips content for the route with content off', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, includeContent: false }),
      makeRoute({ routeId: 'b', channelId: DEST_B, includeContent: true }),
    ]);
    await attributeAndLogDeletion(fake.ports, payload({ content: 'secret words' }));
    const byChannel = new Map(fake.sent.map((s) => [s.channelId, s.content]));
    expect(byChannel.get(DEST_A)).not.toContain('secret words');
    expect(byChannel.get(DEST_B)).toContain('secret words');
  });

  it('skips a route whose exclusions contain the payload parentChannelId', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A, excludedChannelIds: ['888888888888888888'] }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    await attributeAndLogDeletion(
      fake.ports,
      payload({
        channelId: parseSnowflakeId('777777777777777777'),
        parentChannelId: parseSnowflakeId('888888888888888888'),
      }),
    );
    expect(fake.sent.map((s) => s.channelId)).toEqual([DEST_B]);
  });

  it('a failure on route 1 posts route 2 and rethrows; the retry posts only route 1 without re-resolving', async () => {
    const fake = makeFake();
    fake.setRoutes([
      makeRoute({ routeId: 'a', channelId: DEST_A }),
      makeRoute({ routeId: 'b', channelId: DEST_B }),
    ]);
    fake.failing.add(DEST_A);
    const p = payload();
    await expect(attributeAndLogDeletion(fake.ports, p)).rejects.toThrow();
    expect(fake.sent).toHaveLength(2);
    expect(fake.counts().recordCount).toBe(1);

    fake.failing.clear();
    await attributeAndLogDeletion(fake.ports, p);
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.channelId).toBe(DEST_A);
    // The retry reused the existing attribution: no second fetch, no second record.
    expect(fake.counts().fetchCount).toBe(1);
    expect(fake.counts().recordCount).toBe(1);
  });
});
