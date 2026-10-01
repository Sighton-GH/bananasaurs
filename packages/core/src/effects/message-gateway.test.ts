import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type {
  DiscordMessageRef,
  DiscordPort,
  OutgoingMessage,
  Snowflake,
} from '../discord/port.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import {
  contentHashFor,
  MESSAGE_SEND_RATE_LIMIT,
  sendMessageEffect,
  type MessageGatewayDeps,
  type MessageIntent,
  type SendLedgerRow,
} from './message-gateway.js';

/**
 * `sendMessageEffect` (`message-gateway.ts`) tested against fake ports, no
 * database and no network — the same shape as `moderation-gateway.test.ts`'s
 * minimal `DiscordPort` fake. The ledger below mirrors `claimSend`'s
 * INSERT OR IGNORE semantics so replay/collision behaviour is real, not
 * asserted against a mock.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const OTHER_CHANNEL = parseSnowflakeId('333333333333333333');
const TOKEN_ID = 'tok_testrow000000000000000000000001';

const RATE_LIMIT = MESSAGE_SEND_RATE_LIMIT;
const HOUR_MS = 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;

interface FakeCall {
  method: string;
  args: readonly unknown[];
}

/**
 * The narrow slice of `DiscordPort` this gateway touches: the single
 * `sendMessage` REST call. Every other method throws — a call to one would
 * mean this gateway reached outside its documented surface.
 */
class MinimalSendDiscord implements DiscordPort {
  calls: FakeCall[] = [];
  sentMessages: OutgoingMessage[] = [];
  /** Simulated network latency, for the concurrency probe below. */
  sendDelayMs = 0;
  private nextFailure: Error | undefined;
  private idSeq = 0;

  failNext(error: Error): void {
    this.nextFailure = error;
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }
  callsFor(method: string): readonly FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async sendMessage(
    guildId: Snowflake,
    channelId: Snowflake,
    message: OutgoingMessage,
  ): Promise<DiscordMessageRef> {
    this.record('sendMessage', [guildId, channelId, message]);
    if (this.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    }
    if (this.nextFailure !== undefined) {
      const err = this.nextFailure;
      this.nextFailure = undefined;
      throw err;
    }
    this.sentMessages.push(message);
    this.idSeq += 1;
    return { channelId, messageId: `44444444444444444${this.idSeq}` };
  }

  // --- unused by this gateway: any call here is a gateway that reached
  // outside its documented surface. -------------------------------------
  private notUsed(method: string): never {
    throw new Error(`sendMessageEffect is not expected to call DiscordPort.${method}`);
  }
  async addRole(): Promise<void> {
    this.notUsed('addRole');
  }
  async removeRole(): Promise<void> {
    this.notUsed('removeRole');
  }
  async fetchRoles(): Promise<never> {
    this.notUsed('fetchRoles');
  }
  async fetchBotHighestRolePosition(): Promise<never> {
    this.notUsed('fetchBotHighestRolePosition');
  }
  async fetchMember(): Promise<never> {
    this.notUsed('fetchMember');
  }
  async fetchMessage(): Promise<{ exists: true }> {
    this.notUsed('fetchMessage');
  }
  async createReaction(): Promise<void> {
    this.notUsed('createReaction');
  }
  async fetchReactionUsers(): Promise<never> {
    this.notUsed('fetchReactionUsers');
  }
  async editMessage(): Promise<void> {
    this.notUsed('editMessage');
  }
  async deleteMessage(): Promise<void> {
    this.notUsed('deleteMessage');
  }
  async timeoutMember(): Promise<void> {
    this.notUsed('timeoutMember');
  }
  async untimeoutMember(): Promise<void> {
    this.notUsed('untimeoutMember');
  }
  async kickMember(): Promise<void> {
    this.notUsed('kickMember');
  }
  async banMember(): Promise<void> {
    this.notUsed('banMember');
  }
  async unbanMember(): Promise<void> {
    this.notUsed('unbanMember');
  }
  async bulkDeleteMessages(): Promise<void> {
    this.notUsed('bulkDeleteMessages');
  }
  async fetchRecentMessages(): Promise<never> {
    this.notUsed('fetchRecentMessages');
  }

  async listPublicThreads(): Promise<never> {
    this.notUsed('listPublicThreads');
  }
  async isThreadMember(): Promise<never> {
    this.notUsed('isThreadMember');
  }
  async fetchThreadInfo(): Promise<never> {
    this.notUsed('fetchThreadInfo');
  }
  async fetchMessageMeta(): Promise<never> {
    this.notUsed('fetchMessageMeta');
  }
  async pinMessage(): Promise<void> {
    this.notUsed('pinMessage');
  }
  async unpinMessage(): Promise<void> {
    this.notUsed('unpinMessage');
  }
  async deleteOwnReaction(): Promise<void> {
    this.notUsed('deleteOwnReaction');
  }
  async fetchMessageAuthor(): Promise<never> {
    this.notUsed('fetchMessageAuthor');
  }
  async listScheduledEvents(): Promise<never> {
    this.notUsed('listScheduledEvents');
  }
  async deferInteraction(): Promise<void> {
    this.notUsed('deferInteraction');
  }
  async respondToInteraction(): Promise<never> {
    this.notUsed('respondToInteraction');
  }
  async fetchMessageContent(): Promise<never> {
    this.notUsed('fetchMessageContent');
  }
  async fetchChannelMessages(): Promise<never> {
    this.notUsed('fetchChannelMessages');
  }
  async sendTyping(): Promise<void> {
    this.notUsed('sendTyping');
  }
  async fetchAuditLog(): Promise<never> {
    this.notUsed('fetchAuditLog');
  }
  async leaveGuild(): Promise<void> {
    this.notUsed('leaveGuild');
  }
}

interface SafetyState {
  killswitch: boolean;
  breakerOpen: boolean;
  dryRun: boolean;
}

/** In-memory `mcp_sends`: INSERT OR IGNORE on the key, rows carry sentAt. */
class FakeSendLedger {
  rows = new Map<string, SendLedgerRow>();

  find(idempotencyKey: string): SendLedgerRow | undefined {
    return this.rows.get(idempotencyKey);
  }

  claim(input: {
    idempotencyKey: string;
    channelId: string;
    contentHash: string;
    tokenId: string;
    now: number;
    outcome: 'sent' | 'dry_run';
  }): { readonly claimed: boolean } {
    if (this.rows.has(input.idempotencyKey)) return { claimed: false };
    this.rows.set(input.idempotencyKey, {
      idempotencyKey: input.idempotencyKey,
      channelId: input.channelId,
      contentHash: input.contentHash,
      messageId: undefined,
      tokenId: input.tokenId,
      sentAt: input.now,
      outcome: input.outcome,
    });
    return { claimed: true };
  }

  recordMessageId(input: { idempotencyKey: string; messageId: string }): void {
    const row = this.rows.get(input.idempotencyKey);
    if (row) this.rows.set(input.idempotencyKey, { ...row, messageId: input.messageId });
  }

  countSince(sinceMs: number): number {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.sentAt >= sinceMs) n += 1;
    }
    return n;
  }

  findRecentByContent(contentHash: string, channelId: string, sinceMs: number): boolean {
    for (const row of this.rows.values()) {
      if (row.contentHash === contentHash && row.channelId === channelId && row.sentAt >= sinceMs) {
        return true;
      }
    }
    return false;
  }
}

interface Harness {
  discord: MinimalSendDiscord;
  ledger: FakeSendLedger;
  audits: unknown[];
  logText(): string;
  state: SafetyState;
  nowMs: { value: number };
  deps: () => MessageGatewayDeps;
  setState(patch: Partial<SafetyState>): void;
  /** Every reason the gateway passed to `tripBreaker` — must stay empty (M5-D12). */
  trips: string[];
}

const build = (
  opts: {
    guildKnown?: boolean;
    allowedChannels?: readonly (typeof CHANNEL)[];
    guildChannels?: readonly string[];
  } = {},
): Harness => {
  const state: SafetyState = { killswitch: false, breakerOpen: false, dryRun: false };
  const discord = new MinimalSendDiscord();
  const ledger = new FakeSendLedger();
  const audits: unknown[] = [];
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'debug' }, sink);
  const nowMs = { value: 1_700_000_000_000 };
  const guildKnown = opts.guildKnown ?? true;
  const allowed = new Set<string>(opts.allowedChannels ?? [CHANNEL]);
  const inGuild = new Set<string>(opts.guildChannels ?? [CHANNEL, OTHER_CHANNEL]);
  const trips: string[] = [];

  const deps = (): MessageGatewayDeps => ({
    guildId: GUILD,
    discord,
    logger,
    now: () => nowMs.value,
    state: {
      read: () => (guildKnown ? { ...state } : undefined),
      isChannelAllowed: (channelId) => allowed.has(channelId),
      isChannelInGuild: (channelId) => inGuild.has(channelId),
      // The role gateway's state carries `tripBreaker` and calls it on
      // rate-cap overflow (`gateway.ts:280`); this gateway's does not. The
      // spy sits on the same shape so the test below fails if anyone threads
      // a trip through here (M5-D12).
      tripBreaker: (reason: string) => {
        trips.push(reason);
      },
    } as MessageGatewayDeps['state'],
    sends: {
      find: (key) => ledger.find(key),
      claim: (input) => ledger.claim(input),
      recordMessageId: (input) => ledger.recordMessageId(input),
      countSince: (sinceMs) => ledger.countSince(sinceMs),
      findRecentByContent: (hash, channelId, sinceMs) =>
        ledger.findRecentByContent(hash, channelId, sinceMs),
    },
    audit: {
      record: (input) => {
        audits.push(input);
      },
    },
  });

  return {
    discord,
    ledger,
    audits,
    logText: () => chunks.join(''),
    state,
    nowMs,
    deps,
    setState(patch) {
      Object.assign(state, patch);
    },
    trips,
  };
};

const intent = (over: Partial<MessageIntent> = {}): MessageIntent => ({
  channelId: CHANNEL,
  content: 'standup in 5 minutes',
  idempotencyKey: 'key-1',
  tokenId: TOKEN_ID,
  ...over,
});

describe('sendMessageEffect', () => {
  it('refuses a channel outside the allowlist and never calls Discord', async () => {
    const h = build();
    const outcome = await sendMessageEffect(
      h.deps(),
      intent({ channelId: OTHER_CHANNEL, idempotencyKey: 'key-allow' }),
    );

    expect(outcome).toEqual({ status: 'refused', reason: 'channel-not-allowlisted' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
  });

  it('refuses an allowlisted channel that is not in the guild and never calls Discord (C2 send-time)', async () => {
    // The allowlist is data: a row written before allow-time validation
    // existed must not be able to post outside the guild. A DM-shaped id
    // holding a row lands here, with its own reason, never at the REST call.
    const h = build({ allowedChannels: [OTHER_CHANNEL], guildChannels: [CHANNEL] });
    const outcome = await sendMessageEffect(
      h.deps(),
      intent({ channelId: OTHER_CHANNEL, idempotencyKey: 'key-outside' }),
    );

    expect(outcome).toEqual({ status: 'refused', reason: 'channel-not-in-guild' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
  });

  it('refuses when the guild is unknown and never calls Discord', async () => {
    const h = build({ guildKnown: false });
    const outcome = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-unknown' }));

    expect(outcome).toEqual({ status: 'refused', reason: 'guild-unknown' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
  });

  it('refuses when the kill switch is on and never calls Discord', async () => {
    const h = build();
    h.setState({ killswitch: true });
    const outcome = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-kill' }));

    expect(outcome).toEqual({ status: 'refused', reason: 'killswitch' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
  });

  it('refuses when the breaker is open and never calls Discord', async () => {
    const h = build();
    h.setState({ breakerOpen: true });
    const outcome = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-breaker' }));

    expect(outcome).toEqual({ status: 'refused', reason: 'breaker-open' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
  });

  it('never trips the circuit breaker, including on the rate-cap path (M5-D12)', async () => {
    // Deliberately asymmetric with `gateway.ts:280`, where a rate-cap
    // overflow trips the breaker: the breaker is guild-wide and shared with
    // the moderation effect path, so an MCP send hitting its cap must refuse
    // without opening it — otherwise the MCP surface would hold a lever that
    // pauses moderation for the entire guild.
    const h = build();
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      const outcome = await sendMessageEffect(
        h.deps(),
        intent({ idempotencyKey: `key-notrip-${i}`, content: `no-trip message ${i}` }),
      );
      expect(outcome.status).toBe('sent');
    }
    const capped = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-notrip-cap', content: 'no-trip over the cap' }),
    );
    expect(capped).toEqual({ status: 'refused', reason: 'rate-cap' });

    // A plain send and a breaker-open refusal trip nothing either.
    h.nowMs.value += HOUR_MS + 1;
    const sent = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-notrip-ok', content: 'no-trip after the window' }),
    );
    expect(sent.status).toBe('sent');
    h.setState({ breakerOpen: true });
    await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-notrip-open' }));

    expect(h.trips).toHaveLength(0);
  });

  it('refuses the send that overflows the cap; the last one under it succeeds', async () => {
    const h = build();
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      const outcome = await sendMessageEffect(
        h.deps(),
        intent({ idempotencyKey: `key-cap-${i}`, content: `cap message ${i}` }),
      );
      expect(outcome.status).toBe('sent');
    }
    const overflow = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-cap-overflow', content: 'cap message overflow' }),
    );

    expect(overflow).toEqual({ status: 'refused', reason: 'rate-cap' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(RATE_LIMIT);
  });

  it('replays an already-claimed key under a full rate cap; a new key is still refused', async () => {
    // M5-D9: a replay is not a send — it costs no Discord call and consumes
    // no capacity, so it must not depend on present conditions. With the cap
    // ahead of the ledger read, this replay came back `rate-cap`: told its
    // message failed while the message was sitting in the channel (M5-D3's
    // trap from the other direction). Both directions asserted, or the test
    // proves only that the cap was removed.
    const h = build();
    const first = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-pinned', content: 'pinned message' }),
    );
    expect(first.status).toBe('sent');
    for (let i = 0; i < RATE_LIMIT - 1; i += 1) {
      const outcome = await sendMessageEffect(
        h.deps(),
        intent({ idempotencyKey: `key-fill-${i}`, content: `fill message ${i}` }),
      );
      expect(outcome.status).toBe('sent');
    }

    const replay = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-pinned', content: 'pinned message' }),
    );
    expect(replay.status).toBe('replayed');

    const fresh = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-pinned-new', content: 'a genuinely new message' }),
    );
    expect(fresh).toEqual({ status: 'refused', reason: 'rate-cap' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(RATE_LIMIT);
  });

  it('concurrent sends under one key reach Discord exactly once: the claim precedes the call', async () => {
    // The sequential replay test cannot catch a claim moved after the REST
    // call — sequentially, the first call's post-call claim is already in
    // place when the retry reads, so it still replays. Only concurrent
    // invocations overlap between the read and the claim, which is why this
    // test starts both together and awaits both together. One must send and
    // the other must replay the first's row; exactly one REST call in total.
    const h = build();
    h.discord.sendDelayMs = 20;
    const [first, second] = await Promise.all([
      sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-race' })),
      sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-race' })),
    ]);

    expect([first.status, second.status].sort()).toEqual(['replayed', 'sent']);
    expect(h.discord.callsFor('sendMessage')).toHaveLength(1);
  });

  it('replays the same key with the same content: one Discord call in total', async () => {
    const h = build();
    const first = await sendMessageEffect(h.deps(), intent());
    const second = await sendMessageEffect(h.deps(), intent());

    expect(first.status).toBe('sent');
    expect(first).toEqual({
      status: 'sent',
      messageId: (second as { messageId: string }).messageId,
    });
    expect(second.status).toBe('replayed');
    expect(h.discord.callsFor('sendMessage')).toHaveLength(1);
  });

  it('refuses a reused key with different content and never calls Discord again', async () => {
    const h = build();
    const first = await sendMessageEffect(h.deps(), intent());
    expect(first.status).toBe('sent');

    const collision = await sendMessageEffect(
      h.deps(),
      intent({ content: 'a completely different message' }),
    );

    expect(collision).toEqual({ status: 'refused', reason: 'duplicate-key-different-content' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(1);
  });

  it('refuses identical content under a different key 30s later, sends it 61s later', async () => {
    const h = build();
    const first = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-b1' }));
    expect(first.status).toBe('sent');

    h.nowMs.value += 30_000;
    const tooSoon = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-b2' }));
    expect(tooSoon).toEqual({ status: 'refused', reason: 'duplicate-content-recently' });

    h.nowMs.value += 31_000;
    const later = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-b3' }));
    expect(later.status).toBe('sent');
    expect(h.discord.callsFor('sendMessage')).toHaveLength(2);
  });

  it('records a dry-run in the ledger without calling Discord', async () => {
    const h = build();
    h.setState({ dryRun: true });
    const outcome = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-dry' }));

    expect(outcome).toEqual({ status: 'dry-run' });
    expect(h.discord.callsFor('sendMessage')).toHaveLength(0);
    expect(h.ledger.find('key-dry')).toMatchObject({ outcome: 'dry_run' });
  });

  it('sends the happy path with mentions forced empty, as captured at the fake port', async () => {
    const h = build();
    const outcome = await sendMessageEffect(
      h.deps(),
      intent({ content: 'hello @everyone, read this' }),
    );

    expect(outcome.status).toBe('sent');
    expect(h.discord.callsFor('sendMessage')).toHaveLength(1);
    expect(h.discord.sentMessages).toHaveLength(1);
    expect(h.discord.sentMessages[0]).toMatchObject({
      content: 'hello @everyone, read this',
      allowedMentions: { parse: [] },
    });
  });

  it('returns failed when the REST call rejects, keeps the claim, and replays the retry', async () => {
    const h = build();
    h.discord.failNext(new Error('socket hang up'));
    const failed = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-fail' }));

    expect(failed).toEqual({ status: 'failed', code: 'Error' });
    // The claim precedes the call, so the ledger still holds the row: a retry
    // with the same key replays instead of double-sending.
    expect(h.ledger.find('key-fail')).toBeDefined();

    const retry = await sendMessageEffect(h.deps(), intent({ idempotencyKey: 'key-fail' }));
    expect(retry.status).toBe('replayed');
    expect(h.discord.callsFor('sendMessage')).toHaveLength(1);
  });

  it('a throwing REST call writes exactly one failed audit row and no content', async () => {
    // I3: the case that matters is Discord accepting the POST and the
    // response being lost — the message is in the channel and the audit trail
    // must still say an attempt happened, without claiming nothing was
    // posted (nobody knows that).
    const h = build();
    const secret = 'failed-audit-content-probe-7e1c-unique';
    h.discord.failNext(new Error('socket hang up'));
    const failed = await sendMessageEffect(
      h.deps(),
      intent({ content: secret, idempotencyKey: 'key-fail-audit' }),
    );

    expect(failed).toEqual({ status: 'failed', code: 'Error' });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ channelId: CHANNEL, outcome: 'failed' });
    expect(h.audits[0]).not.toHaveProperty('content');
    expect(JSON.stringify(h.audits[0])).not.toContain(secret);
  });

  it('never writes message content to any log line', async () => {
    const h = build();
    const secret = 'quarterly-planning-notes-9f3a-unique';
    await sendMessageEffect(h.deps(), intent({ content: secret }));
    h.setState({ killswitch: true });
    await sendMessageEffect(h.deps(), intent({ content: secret, idempotencyKey: 'key-log2' }));

    expect(h.logText()).not.toContain(secret);
  });

  it('records an audit row carrying the channel and never the content', async () => {
    const h = build();
    const outcome = await sendMessageEffect(
      h.deps(),
      intent({ content: 'audit-content-probe-4d2b' }),
    );

    expect(outcome.status).toBe('sent');
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ channelId: CHANNEL });
    expect(h.audits[0]).not.toHaveProperty('content');
    expect(JSON.stringify(h.audits[0])).not.toContain('audit-content-probe-4d2b');
  });

  it('hashes channel and content together, deterministically', () => {
    expect(contentHashFor('chan', 'hello')).toBe(contentHashFor('chan', 'hello'));
    expect(contentHashFor('chan', 'hello')).not.toBe(contentHashFor('chan', 'hello!'));
    expect(contentHashFor('chan', 'hello')).not.toBe(contentHashFor('other-chan', 'hello'));
    expect(contentHashFor('chan', 'hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('slides the rate-cap window: an hour-old send no longer counts', async () => {
    const h = build();
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      const outcome = await sendMessageEffect(
        h.deps(),
        intent({ idempotencyKey: `key-slide-${i}`, content: `slide message ${i}` }),
      );
      expect(outcome.status).toBe('sent');
    }
    h.nowMs.value += HOUR_MS + 1;
    const after = await sendMessageEffect(
      h.deps(),
      intent({ idempotencyKey: 'key-slide-new', content: 'slide message new' }),
    );

    expect(after.status).toBe('sent');
    expect(DUPLICATE_WINDOW_MS).toBe(60_000);
  });
});
