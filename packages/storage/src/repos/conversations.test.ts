import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type ConversationSummary } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  appendTurn,
  createConversation,
  deleteConversation,
  endConversation,
  evictedTurnsSince,
  forgetAuthor,
  getConversation,
  getSummary,
  hasConversations,
  latestForAuthor,
  latestWithBotReply,
  linkConversations,
  linkMessages,
  listLinks,
  listConversations,
  listTurns,
  LIST_TURNS_LIMIT,
  lookupMessage,
  messageIdsForConversation,
  peopleForConversations,
  withBotReplySince,
  pruneOlderThan,
  recentTurns,
  searchSummaries,
  setFeedback,
  writeSummaryIfNewer,
  type NewConversation,
  type NewTurn,
} from './conversations.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const USER = '444444444444444444';
const OTHER_USER = '555555555555555555';

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: 0 });
  upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: 0 });
});
afterEach(() => {
  t.close();
});

/** Stored-data fixture: fixed ids and timestamps, no narrative. */
const conversation = (over: Partial<NewConversation> = {}): NewConversation => ({
  conversationId: 'conv-1',
  channelId: CHANNEL,
  behaviourId: 'club',
  startedBy: USER,
  title: 'where is the handbook',
  source: 'discord',
  at: 1_790_000_000_000,
  ...over,
});

const turn = (over: Partial<NewTurn> = {}): NewTurn => ({
  conversationId: 'conv-1',
  turnId: 'turn-1',
  at: 1_790_000_000_000,
  role: 'user',
  authorId: USER,
  authorName: 'someone',
  text: 'where is the handbook?',
  ...over,
});

describe('guild isolation', () => {
  it('keeps a conversation in guild A invisible from guild B', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation());
    expect(getConversation(b, 'conv-1')).toBeUndefined();
    expect(getConversation(a, 'conv-1')?.conversationId).toBe('conv-1');
  });

  it('isolates listConversations, recentTurns, lookupMessage and latestForAuthor', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation());
    appendTurn(a, turn());
    linkMessages(a, 'conv-1', 'turn-1', 'user', ['600000000000000001']);

    expect(listConversations(b, { sort: 'last-activity', order: 'desc', limit: 50 })).toEqual([]);
    expect(recentTurns(b, 'conv-1', { maxTurns: 12, maxChars: 6_000 })).toEqual([]);
    expect(lookupMessage(b, '600000000000000001')).toBeUndefined();
    expect(latestForAuthor(b, USER, CHANNEL)).toBeUndefined();
    expect(latestForAuthor(a, USER, CHANNEL)?.conversationId).toBe('conv-1');
  });

  it('prunes and forgets only within the scoped guild', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation({ at: 1_000 }));
    createConversation(b, conversation({ at: 1_000 }));
    appendTurn(a, turn({ at: 1_000 }));
    appendTurn(b, turn({ at: 1_000 }));

    expect(pruneOlderThan(a, 2_000)).toEqual({ conversations: 1, ids: ['conv-1'] });
    expect(getConversation(a, 'conv-1')).toBeUndefined();
    expect(getConversation(b, 'conv-1')).toBeDefined();

    expect(forgetAuthor(a, USER)).toBe(0); // conv-1 already gone in guild A
    expect(forgetAuthor(b, USER)).toBe(1);
    expect(getConversation(b, 'conv-1')).toBeUndefined();
  });
});

describe('createConversation / getConversation', () => {
  it('starts open with zero turns', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    expect(getConversation(scope, 'conv-1')).toMatchObject({
      status: 'open',
      turnCount: 0,
      lastActivityAt: 1_790_000_000_000,
    });
  });
});

describe('appendTurn', () => {
  it('bumps last_activity_at and turn_count', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 1_000 }));
    appendTurn(scope, turn({ turnId: 'turn-1', at: 2_000, joinRule: 'fresh' }));
    expect(getConversation(scope, 'conv-1')).toMatchObject({
      turnCount: 1,
      lastActivityAt: 2_000,
    });
    appendTurn(
      scope,
      turn({ turnId: 'turn-2', at: 3_000, role: 'assistant', authorId: undefined }),
    );
    expect(getConversation(scope, 'conv-1')).toMatchObject({
      turnCount: 2,
      lastActivityAt: 3_000,
    });
    expect(listTurns(scope, 'conv-1')[0]?.joinRule).toBe('fresh');
    expect(recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 })[0]?.joinRule).toBe(
      'fresh',
    );
  });
});

describe('linkMessages', () => {
  it('is idempotent: linking the same message twice is a no-op', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    appendTurn(scope, turn());
    linkMessages(scope, 'conv-1', 'turn-1', 'user', ['600000000000000001']);
    // Re-linking must not throw and must not change what the message resolves to.
    expect(() =>
      linkMessages(scope, 'conv-1', 'turn-1', 'user', ['600000000000000001']),
    ).not.toThrow();
    expect(lookupMessage(scope, '600000000000000001')).toEqual({
      conversationId: 'conv-1',
      role: 'user',
      channelId: CHANNEL,
      behaviourId: 'club',
    });
  });
});

describe('messageIdsForConversation', () => {
  it('returns every message id linked to the conversation, and nothing else', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1' }));
    createConversation(scope, conversation({ conversationId: 'conv-2' }));
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 'turn-1' }));
    appendTurn(scope, turn({ conversationId: 'conv-2', turnId: 'turn-9' }));
    linkMessages(scope, 'conv-1', 'turn-1', 'user', ['600000000000000001']);
    linkMessages(scope, 'conv-1', 'turn-1', 'assistant', ['600000000000000002']);
    linkMessages(scope, 'conv-2', 'turn-9', 'user', ['600000000000000003']);

    expect(messageIdsForConversation(scope, 'conv-1').sort()).toEqual([
      '600000000000000001',
      '600000000000000002',
    ]);
    expect(messageIdsForConversation(scope, 'conv-2')).toEqual(['600000000000000003']);
    expect(messageIdsForConversation(scope, 'conv-missing')).toEqual([]);
  });

  it('is guild-scoped', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation());
    appendTurn(a, turn());
    linkMessages(a, 'conv-1', 'turn-1', 'user', ['600000000000000001']);

    expect(messageIdsForConversation(b, 'conv-1')).toEqual([]);
    expect(messageIdsForConversation(a, 'conv-1')).toEqual(['600000000000000001']);
  });
});

describe('lookupMessage', () => {
  it('reports the conversation, role and behaviour for a linked message', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    appendTurn(scope, turn({ turnId: 'turn-1', role: 'user' }));
    appendTurn(
      scope,
      turn({ turnId: 'turn-2', role: 'assistant', authorId: undefined, authorName: 'bananasaurs' }),
    );
    linkMessages(scope, 'conv-1', 'turn-1', 'user', ['600000000000000001']);
    linkMessages(scope, 'conv-1', 'turn-2', 'assistant', ['600000000000000002']);

    expect(lookupMessage(scope, '600000000000000001')).toMatchObject({ role: 'user' });
    expect(lookupMessage(scope, '600000000000000002')).toMatchObject({ role: 'assistant' });
    expect(lookupMessage(scope, '600000000000000099')).toBeUndefined();
  });
});

describe('latestForAuthor', () => {
  it('ignores ended conversations', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 'turn-1', at: 1_000 }));
    endConversation(scope, 'conv-1');
    expect(latestForAuthor(scope, USER, CHANNEL)).toBeUndefined();
  });

  it('finds the most recently active open conversation for the author in the channel', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 'turn-1', at: 1_000 }));
    createConversation(scope, conversation({ conversationId: 'conv-2', at: 2_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-2', turnId: 'turn-2', at: 2_000 }));
    expect(latestForAuthor(scope, USER, CHANNEL)).toEqual({
      conversationId: 'conv-2',
      lastActivityAt: 2_000,
    });
  });

  it('never crosses channels or authors', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 1_000 }));
    appendTurn(scope, turn({ at: 1_000 }));
    expect(latestForAuthor(scope, USER, '999999999999999999')).toBeUndefined();
    expect(latestForAuthor(scope, OTHER_USER, CHANNEL)).toBeUndefined();
  });
});

describe('bot reply joins', () => {
  it('finds only open Discord conversations with assistant replies, scoped and newest first', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation({ conversationId: 'old', at: 1_000 }));
    appendTurn(a, turn({ conversationId: 'old', turnId: 'old-u', at: 1_000 }));
    appendTurn(
      a,
      turn({
        conversationId: 'old',
        turnId: 'old-a',
        at: 2_000,
        role: 'assistant',
        authorId: undefined,
      }),
    );
    createConversation(a, conversation({ conversationId: 'new', at: 3_000 }));
    appendTurn(
      a,
      turn({
        conversationId: 'new',
        turnId: 'new-a',
        at: 4_000,
        role: 'assistant',
        authorId: undefined,
      }),
    );
    createConversation(a, conversation({ conversationId: 'ended', at: 5_000 }));
    appendTurn(
      a,
      turn({
        conversationId: 'ended',
        turnId: 'ended-a',
        at: 6_000,
        role: 'assistant',
        authorId: undefined,
      }),
    );
    endConversation(a, 'ended');
    createConversation(
      a,
      conversation({ conversationId: 'dashboard', source: 'dashboard-test', at: 7_000 }),
    );
    appendTurn(
      a,
      turn({
        conversationId: 'dashboard',
        turnId: 'dashboard-a',
        at: 8_000,
        role: 'assistant',
        authorId: undefined,
      }),
    );
    createConversation(b, conversation({ conversationId: 'other-guild', at: 9_000 }));
    appendTurn(
      b,
      turn({
        conversationId: 'other-guild',
        turnId: 'other-a',
        at: 10_000,
        role: 'assistant',
        authorId: undefined,
      }),
    );

    expect(latestWithBotReply(a, CHANNEL)).toEqual({ conversationId: 'new' });
    expect(withBotReplySince(a, CHANNEL, 1_500)).toEqual(expect.arrayContaining(['old', 'new']));
    expect(latestWithBotReply(b, CHANNEL)).toEqual({ conversationId: 'other-guild' });
  });

  it('uses the guild scope and inclusive timestamp for candidates', () => {
    const a = t.scopes.forGuild(GUILD_A);
    createConversation(a, conversation({ conversationId: 'boundary' }));
    appendTurn(
      a,
      turn({
        conversationId: 'boundary',
        turnId: 'boundary-a',
        role: 'assistant',
        authorId: undefined,
        at: 1_500,
      }),
    );
    expect(withBotReplySince(a, CHANNEL, 1_500)).toEqual(['boundary']);
    expect(withBotReplySince(t.scopes.forGuild(GUILD_B), CHANNEL, 0)).toEqual([]);
  });
});

describe('conversation links', () => {
  it('stores links once, lists both directions, and cascades on delete', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1', title: 'one' }));
    createConversation(scope, conversation({ conversationId: 'conv-2', title: 'two' }));
    linkConversations(scope, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-2',
      kind: 'same-channel',
      at: 3_000,
    });
    linkConversations(scope, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-2',
      kind: 'same-channel',
      at: 4_000,
    });
    expect(listLinks(scope, 'conv-1')).toEqual([
      {
        otherConversationId: 'conv-2',
        otherTitle: 'two',
        kind: 'same-channel',
        direction: 'outgoing',
        at: 3_000,
      },
    ]);
    expect(listLinks(scope, 'conv-2')).toEqual([
      {
        otherConversationId: 'conv-1',
        otherTitle: 'one',
        kind: 'same-channel',
        direction: 'incoming',
        at: 3_000,
      },
    ]);
    deleteConversation(scope, 'conv-1');
    expect(listLinks(scope, 'conv-2')).toEqual([]);
  });

  it('isolates links in both directions and ignores self-links', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    for (const scope of [a, b]) {
      createConversation(scope, conversation({ conversationId: 'conv-1' }));
      createConversation(scope, conversation({ conversationId: 'conv-2' }));
    }
    linkConversations(a, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-2',
      kind: 'thread-parent',
      at: 1_000,
    });
    linkConversations(a, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-1',
      kind: 'same-channel',
      at: 1_000,
    });
    expect(listLinks(a, 'conv-1')).toHaveLength(1);
    expect(listLinks(a, 'conv-2')).toHaveLength(1);
    expect(listLinks(b, 'conv-1')).toEqual([]);
    expect(listLinks(b, 'conv-2')).toEqual([]);
  });

  it('removes links when forgetting the last user of a conversation', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1' }));
    createConversation(scope, conversation({ conversationId: 'conv-2' }));
    appendTurn(scope, turn({ conversationId: 'conv-1' }));
    linkConversations(scope, {
      conversationId: 'conv-2',
      linkedConversationId: 'conv-1',
      kind: 'recalled',
      at: 1_000,
    });
    expect(forgetAuthor(scope, USER)).toBe(1);
    expect(listLinks(scope, 'conv-2')).toEqual([]);
  });

  it('rejects invalid join rules and link kinds at the database boundary', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    createConversation(scope, conversation({ conversationId: 'conv-2' }));
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO assistant_conversation_turns (guild_id, conversation_id, turn_id, at, role, author_name, text, join_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(GUILD_A, 'conv-1', 'invalid', 1_000, 'user', 'someone', 'text', 'not-a-rule'),
    ).toThrow();
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO assistant_conversation_links (guild_id, conversation_id, linked_conversation_id, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(GUILD_A, 'conv-1', 'conv-2', 'not-a-kind', 1_000),
    ).toThrow();
  });

  it('records the 0050_conversation_links migration tag in the journal', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => e.tag === '0050_conversation_links')).toBe(true);
  });
});

describe('recentTurns', () => {
  it('caps at 12 turns, newest window, returned oldest first', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    for (let i = 1; i <= 15; i += 1) {
      appendTurn(
        scope,
        turn({ turnId: `turn-${String(i)}`, at: i * 1_000, text: `message ${String(i)}` }),
      );
    }
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    expect(turns).toHaveLength(12);
    expect(turns[0]?.text).toBe('message 4');
    expect(turns[11]?.text).toBe('message 15');
  });

  it('truncates the newest turn to its last maxChars characters rather than dropping it', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    const big = 'a'.repeat(6_900) + 'TAIL'.repeat(25); // 7,000 chars, ends in "TAIL" repeated
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, text: big }));
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toHaveLength(6_000);
    expect(turns[0]?.text.endsWith('TAIL')).toBe(true);
    expect(big.endsWith(turns[0]!.text)).toBe(true);
  });

  it('drops older turns, oldest first, once the character budget is exhausted', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, text: 'x'.repeat(4_000) }));
    appendTurn(scope, turn({ turnId: 'turn-2', at: 2_000, text: 'y'.repeat(4_000) }));
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    // turn-2 (newest, 4000) + turn-1 (4000) would be 8000 > 6000, so turn-1 is dropped.
    expect(turns.map((r) => r.turnId)).toEqual(['turn-2']);
  });

  it('always keeps the opening quote turn, even outside the 12-turn window, and it counts toward the char cap', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    appendTurn(
      scope,
      turn({
        turnId: 'turn-0',
        at: 0,
        role: 'quote',
        authorId: OTHER_USER,
        authorName: 'quoted member',
        text: 'the original quoted message',
      }),
    );
    for (let i = 1; i <= 15; i += 1) {
      appendTurn(
        scope,
        turn({ turnId: `turn-${String(i)}`, at: i * 1_000, text: `message ${String(i)}` }),
      );
    }
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    // 12-turn window alone would be turn-4..turn-15; the quote turn is force-included.
    expect(turns[0]?.turnId).toBe('turn-0');
    expect(turns[0]?.role).toBe('quote');
    expect(turns.at(-1)?.turnId).toBe('turn-15');
    expect(turns).toHaveLength(13);
  });

  it('keeps quote + turns within maxChars by dropping the oldest non-quote turns', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    appendTurn(
      scope,
      turn({
        turnId: 'turn-0',
        at: 0,
        role: 'quote',
        authorId: OTHER_USER,
        authorName: 'quoted member',
        text: 'q'.repeat(2_000),
      }),
    );
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, text: 'a'.repeat(2_000) }));
    appendTurn(scope, turn({ turnId: 'turn-2', at: 2_000, text: 'b'.repeat(2_000) }));
    appendTurn(scope, turn({ turnId: 'turn-3', at: 3_000, text: 'c'.repeat(2_000) }));
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    const total = turns.reduce((sum, r) => sum + r.text.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
    // The quote is kept and the newest non-quote turns win; the oldest is dropped to fit.
    expect(turns.map((r) => r.turnId)).toEqual(['turn-0', 'turn-2', 'turn-3']);
  });

  it('truncates a quote longer than the cap and keeps no other turns', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    const bigQuote = 'q'.repeat(6_500) + 'TAIL';
    appendTurn(
      scope,
      turn({
        turnId: 'turn-0',
        at: 0,
        role: 'quote',
        authorId: OTHER_USER,
        authorName: 'quoted member',
        text: bigQuote,
      }),
    );
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, text: 'newest message' }));
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('quote');
    expect(turns[0]?.text).toHaveLength(6_000);
    expect(bigQuote.endsWith(turns[0]!.text)).toBe(true);
  });

  it('never returns a quote turn that is not the first turn of the conversation', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, role: 'user', text: 'first' }));
    // Not the true opening turn — must be treated as an ordinary, droppable turn.
    appendTurn(
      scope,
      turn({
        turnId: 'turn-2',
        at: 2_000,
        role: 'quote',
        authorId: OTHER_USER,
        authorName: 'quoted member',
        text: 'a mid-conversation quote',
      }),
    );
    appendTurn(
      scope,
      turn({ turnId: 'turn-3', at: 3_000, role: 'assistant', authorId: undefined, text: 'reply' }),
    );
    const turns = recentTurns(scope, 'conv-1', { maxTurns: 2, maxChars: 6_000 });
    expect(turns.map((r) => r.turnId)).toEqual(['turn-2', 'turn-3']);
  });
});

describe('listConversations', () => {
  it('sorts by last activity, filters, and pages with before', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(
      scope,
      conversation({ conversationId: 'conv-old', at: 1_000, title: 'old topic' }),
    );
    createConversation(
      scope,
      conversation({ conversationId: 'conv-new', at: 3_000, title: 'new topic' }),
    );
    appendTurn(scope, turn({ conversationId: 'conv-old', turnId: 't-old', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-new', turnId: 't-new', at: 3_000 }));

    const page = listConversations(scope, { sort: 'last-activity', order: 'desc', limit: 50 });
    expect(page.map((c) => c.conversationId)).toEqual(['conv-new', 'conv-old']);

    const older = listConversations(scope, {
      sort: 'last-activity',
      order: 'desc',
      limit: 50,
      before: 3_000,
    });
    expect(older.map((c) => c.conversationId)).toEqual(['conv-old']);

    expect(
      listConversations(scope, {
        sort: 'last-activity',
        order: 'desc',
        limit: 50,
        search: 'new',
      }).map((c) => c.conversationId),
    ).toEqual(['conv-new']);

    expect(
      listConversations(scope, {
        sort: 'last-activity',
        order: 'desc',
        limit: 50,
        channelId: '999999999999999999',
      }),
    ).toEqual([]);
  });
});

describe('endConversation / deleteConversation', () => {
  it('ends without deleting, and delete cascades to turns and message links', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    appendTurn(scope, turn());
    linkMessages(scope, 'conv-1', 'turn-1', 'user', ['600000000000000001']);

    endConversation(scope, 'conv-1');
    expect(getConversation(scope, 'conv-1')?.status).toBe('ended');
    expect(recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 })).toHaveLength(1);

    deleteConversation(scope, 'conv-1');
    expect(getConversation(scope, 'conv-1')).toBeUndefined();
    expect(recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 })).toEqual([]);
    expect(lookupMessage(scope, '600000000000000001')).toBeUndefined();
  });
});

describe('setFeedback', () => {
  it('sets feedback on the turn a message belongs to, and reports an unknown message', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    appendTurn(scope, turn({ turnId: 'turn-1', role: 'assistant', authorId: undefined }));
    linkMessages(scope, 'conv-1', 'turn-1', 'assistant', ['600000000000000001']);

    expect(setFeedback(scope, '600000000000000099', 'up')).toEqual({
      updated: false,
      traceId: undefined,
    });
    expect(setFeedback(scope, '600000000000000001', 'up')).toEqual({
      updated: true,
      traceId: undefined,
    });
    expect(recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 })[0]?.feedback).toBe('up');
  });
});

describe('setFeedback clears and reports the turn trace', () => {
  it('clears feedback with null and reports the turn trace id', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    appendTurn(
      scope,
      turn({ turnId: 'turn-1', role: 'assistant', authorId: undefined, traceId: 'trace-1' }),
    );
    linkMessages(scope, 'conv-1', 'turn-1', 'assistant', ['600000000000000001']);

    expect(setFeedback(scope, '600000000000000099', 'up')).toEqual({
      updated: false,
      traceId: undefined,
    });
    expect(setFeedback(scope, '600000000000000001', 'up')).toEqual({
      updated: true,
      traceId: 'trace-1',
    });
    expect(listTurns(scope, 'conv-1')[0]?.feedback).toBe('up');
    expect(setFeedback(scope, '600000000000000001', null)).toEqual({
      updated: true,
      traceId: 'trace-1',
    });
    expect(listTurns(scope, 'conv-1')[0]?.feedback).toBeUndefined();
  });
});

describe('pruneOlderThan', () => {
  it('uses last_activity_at, not created_at', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 't1', at: 1_000 }));
    // A later turn keeps the conversation active well past its creation time.
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 't2', at: 10_000 }));

    expect(pruneOlderThan(scope, 5_000)).toEqual({ conversations: 0, ids: [] });
    expect(getConversation(scope, 'conv-1')).toBeDefined();

    expect(pruneOlderThan(scope, 20_000)).toEqual({ conversations: 1, ids: ['conv-1'] });
    expect(getConversation(scope, 'conv-1')).toBeUndefined();
  });
});

describe('forgetAuthor', () => {
  it('deletes the author’s turns and any conversation left with no user turn', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-1', turnId: 't1', at: 1_000, authorId: USER }));
    appendTurn(
      scope,
      turn({
        conversationId: 'conv-1',
        turnId: 't2',
        at: 2_000,
        role: 'assistant',
        authorId: undefined,
        text: 'the answer',
      }),
    );

    // A second conversation has turns from both users — only USER's turn goes.
    createConversation(scope, conversation({ conversationId: 'conv-2', at: 1_000 }));
    appendTurn(scope, turn({ conversationId: 'conv-2', turnId: 't3', at: 1_000, authorId: USER }));
    appendTurn(
      scope,
      turn({ conversationId: 'conv-2', turnId: 't4', at: 2_000, authorId: OTHER_USER }),
    );

    expect(forgetAuthor(scope, USER)).toBe(2);
    // conv-1 has no user turn left (only the assistant's), so it is gone entirely.
    expect(getConversation(scope, 'conv-1')).toBeUndefined();
    // conv-2 still has OTHER_USER's turn, so it survives with only that turn.
    const remaining = recentTurns(scope, 'conv-2', { maxTurns: 12, maxChars: 6_000 });
    expect(remaining.map((r) => r.turnId)).toEqual(['t4']);
  });

  it('clears a surviving shared conversation’s summary so the index forgets it', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    const other = t.scopes.forGuild(GUILD_B);
    const shared: ConversationSummary = {
      topic: 'gearbox rebuild notes',
      facts: [{ text: 'the gearbox needs grease', from: 'member' }],
      botClaims: [],
      openQuestions: [],
      commitments: [],
      participants: [],
    };
    const untouched: ConversationSummary = {
      topic: 'gearbox rebuild notes',
      facts: [{ text: 'the gearbox needs grease', from: 'member' }],
      botClaims: [],
      openQuestions: [],
      commitments: [],
      participants: [],
    };
    createConversation(scope, conversation({ conversationId: 'conv-shared', at: 1_000 }));
    appendTurn(
      scope,
      turn({ conversationId: 'conv-shared', turnId: 't-a', at: 1_000, authorId: USER }),
    );
    appendTurn(
      scope,
      turn({
        conversationId: 'conv-shared',
        turnId: 't-b',
        at: 2_000,
        authorId: OTHER_USER,
        authorName: 'other',
        text: 'agreed',
      }),
    );
    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-shared',
        summary: shared,
        throughAt: 2_000,
        now: 2_001,
      }).written,
    ).toBe(true);
    createConversation(other, conversation({ conversationId: 'conv-other', at: 1_000 }));
    appendTurn(other, turn({ conversationId: 'conv-other', turnId: 't-c', at: 1_000 }));
    expect(
      writeSummaryIfNewer(other, {
        conversationId: 'conv-other',
        summary: untouched,
        throughAt: 1_000,
        now: 1_001,
      }).written,
    ).toBe(true);

    expect(forgetAuthor(scope, USER)).toBe(1);

    // The surviving conversation keeps B's turn but loses its summary.
    expect(recentTurns(scope, 'conv-shared', { maxTurns: 12, maxChars: 6_000 }).map((r) => r.turnId)).toEqual([
      't-b',
    ]);
    expect(getSummary(scope, 'conv-shared')).toBeUndefined();
    expect(
      searchSummaries(scope, { query: 'gearbox', channelIds: [CHANNEL], limit: 5 }),
    ).toEqual([]);
    // Another guild's summaries are untouched.
    expect(getSummary(other, 'conv-other')?.summary.topic).toBe('gearbox rebuild notes');
    expect(
      searchSummaries(other, { query: 'gearbox', channelIds: [CHANNEL], limit: 5 }).map(
        (hit) => hit.conversationId,
      ),
    ).toEqual(['conv-other']);
  });
});

describe('peopleForConversations', () => {
  it('returns distinct human names per conversation in first-seen order', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId: 'conv-1' }));
    appendTurn(
      scope,
      turn({
        conversationId: 'conv-1',
        turnId: 't-quote',
        at: 1_000,
        role: 'quote',
        authorId: OTHER_USER,
        authorName: 'Quoted Alex',
        text: 'the quoted message',
      }),
    );
    appendTurn(
      scope,
      turn({ conversationId: 'conv-1', turnId: 't-user', at: 2_000, authorName: 'Bryan' }),
    );
    appendTurn(
      scope,
      turn({ conversationId: 'conv-1', turnId: 't-user-2', at: 3_000, authorName: 'Bryan' }),
    );
    appendTurn(
      scope,
      turn({
        conversationId: 'conv-1',
        turnId: 't-bot',
        at: 4_000,
        role: 'assistant',
        authorId: undefined,
        authorName: 'Bananasaurs',
        text: 'the answer',
      }),
    );
    // An assistant-only conversation has no people.
    createConversation(scope, conversation({ conversationId: 'conv-2' }));
    appendTurn(
      scope,
      turn({
        conversationId: 'conv-2',
        turnId: 't-bot-2',
        role: 'assistant',
        authorId: undefined,
        authorName: 'Bananasaurs',
        text: 'the answer',
      }),
    );

    const people = peopleForConversations(scope, ['conv-1', 'conv-2', 'conv-missing']);
    expect(people.get('conv-1')).toEqual(['Quoted Alex', 'Bryan']);
    expect(people.get('conv-2')).toEqual([]);
    expect(people.get('conv-missing')).toEqual([]);
  });

  it('never returns another guild’s names', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation({ conversationId: 'conv-1' }));
    appendTurn(a, turn({ conversationId: 'conv-1', turnId: 't-a', authorName: 'Bryan' }));
    createConversation(b, conversation({ conversationId: 'conv-1' }));
    appendTurn(b, turn({ conversationId: 'conv-1', turnId: 't-b', authorName: 'Someone Else' }));

    expect(peopleForConversations(a, ['conv-1']).get('conv-1')).toEqual(['Bryan']);
    expect(peopleForConversations(b, ['conv-1']).get('conv-1')).toEqual(['Someone Else']);
  });

  it('returns an empty map for no ids', () => {
    expect(peopleForConversations(t.scopes.forGuild(GUILD_A), [])).toEqual(new Map());
  });
});

describe('listTurns', () => {
  it('returns every turn oldest first, uncapped by the context window', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    appendTurn(scope, turn({ turnId: 'turn-3', at: 3_000, text: 'third' }));
    appendTurn(scope, turn({ turnId: 'turn-1', at: 1_000, text: 'first' }));
    appendTurn(scope, turn({ turnId: 'turn-2', at: 2_000, text: 'second' }));

    const turns = listTurns(scope, 'conv-1');
    expect(turns.map((r) => r.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(turns.map((r) => r.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps one guild’s turns out of another', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation({ conversationId: 'conv-1' }));
    appendTurn(a, turn({ conversationId: 'conv-1', turnId: 't-a', text: 'guild a turn' }));
    createConversation(b, conversation({ conversationId: 'conv-1' }));
    appendTurn(b, turn({ conversationId: 'conv-1', turnId: 't-b', text: 'guild b turn' }));

    expect(listTurns(a, 'conv-1').map((r) => r.turnId)).toEqual(['t-a']);
    expect(listTurns(b, 'conv-1').map((r) => r.turnId)).toEqual(['t-b']);
    expect(listTurns(a, 'conv-missing')).toEqual([]);
  });

  it('caps at the hard safety limit of 2,000 turns', () => {
    expect(LIST_TURNS_LIMIT).toBe(2_000);
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    for (let i = 0; i < LIST_TURNS_LIMIT + 1; i += 1) {
      appendTurn(
        scope,
        turn({
          conversationId: 'conv-1',
          turnId: `turn-${String(i)}`,
          at: i,
          text: `m${String(i)}`,
        }),
      );
    }
    const turns = listTurns(scope, 'conv-1');
    expect(turns).toHaveLength(LIST_TURNS_LIMIT);
    expect(turns[0]?.turnId).toBe('turn-0');
    expect(turns.at(-1)?.turnId).toBe(`turn-${String(LIST_TURNS_LIMIT - 1)}`);
  });
});

describe('hasConversations', () => {
  it('is false when the guild has no conversations', () => {
    expect(hasConversations(t.scopes.forGuild(GUILD_A))).toBe(false);
  });

  it('is true once the guild has a conversation, and stays guild-isolated', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation());

    expect(hasConversations(a)).toBe(true);
    expect(hasConversations(b)).toBe(false);
  });

  it('is false again after the last conversation is deleted', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    expect(hasConversations(scope)).toBe(true);
    deleteConversation(scope, 'conv-1');
    expect(hasConversations(scope)).toBe(false);
  });
});

describe('conversation summaries (ADR 0091)', () => {
  const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
    topic: 'Friday social planning',
    facts: [{ text: 'The hall opens at six', from: 'member' }],
    botClaims: ['The hall might open at six'],
    openQuestions: ['Who brings snacks?'],
    commitments: [{ who: 'Ada', what: 'bring snacks', when: 'Friday' }],
    participants: ['Ada'],
    ...over,
  });

  it('compare-and-set: an older throughAt is not written, a newer one bumps the version', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());

    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary(),
        throughAt: 2_000,
        now: 9_000,
      }),
    ).toEqual({
      written: true,
      version: 1,
    });
    expect(getSummary(scope, 'conv-1')).toMatchObject({
      throughAt: 2_000,
      version: 1,
      updatedAt: 9_000,
    });
    expect(getSummary(scope, 'conv-1')?.summary).toEqual(summary());

    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary({ topic: 'stale' }),
        throughAt: 1_000,
        now: 9_001,
      }),
    ).toEqual({ written: false, version: 1 });
    expect(getSummary(scope, 'conv-1')?.summary.topic).toBe('Friday social planning');

    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary({ topic: 'newer' }),
        throughAt: 3_000,
        now: 9_002,
      }),
    ).toEqual({ written: true, version: 2 });
    expect(getSummary(scope, 'conv-1')).toMatchObject({
      throughAt: 3_000,
      version: 2,
      updatedAt: 9_002,
    });
  });

  it('keeps summaries guild-scoped: another guild neither reads nor writes the row', () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    createConversation(a, conversation());
    expect(
      writeSummaryIfNewer(a, {
        conversationId: 'conv-1',
        summary: summary(),
        throughAt: 2_000,
        now: 9_000,
      }),
    ).toEqual({
      written: true,
      version: 1,
    });

    expect(getSummary(b, 'conv-1')).toBeUndefined();
    expect(
      writeSummaryIfNewer(b, {
        conversationId: 'conv-1',
        summary: summary({ topic: 'other guild' }),
        throughAt: 5_000,
        now: 9_001,
      }),
    ).toEqual({
      written: false,
      version: 0,
    });
    expect(getSummary(a, 'conv-1')).toMatchObject({ throughAt: 2_000, version: 1 });
  });

  it('reads an invalid stored JSON as undefined', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary(),
        throughAt: 2_000,
        now: 9_000,
      }).written,
    ).toBe(true);
    t.raw
      .prepare(
        `UPDATE assistant_conversations SET summary_json = ? WHERE guild_id = ? AND conversation_id = ?`,
      )
      .run('not json at all', GUILD_A, 'conv-1');
    expect(getSummary(scope, 'conv-1')).toBeUndefined();
  });

  it('throws on an invalid summary instead of writing', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    expect(() =>
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary({ topic: 'x'.repeat(201) }),
        throughAt: 2_000,
        now: 9_000,
      }),
    ).toThrow();
    expect(getSummary(scope, 'conv-1')).toBeUndefined();
  });

  it('evictedTurnsSince returns what recentTurns left out, oldest first', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    for (let i = 1; i <= 15; i += 1) {
      appendTurn(
        scope,
        turn({ turnId: `turn-${String(i)}`, at: i * 1_000, text: `message ${String(i)}` }),
      );
    }
    const window = { maxTurns: 12, maxChars: 6_000 };
    const recent = recentTurns(scope, 'conv-1', window);
    expect(recent).toHaveLength(12);

    const evicted = evictedTurnsSince(scope, 'conv-1', { afterAt: null, window });
    expect(evicted.map((turnEntry) => turnEntry.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3']);

    // The two agree: disjoint, and together they are every stored turn.
    const recentIds = new Set(recent.map((turnEntry) => turnEntry.turnId));
    expect(evicted.some((turnEntry) => recentIds.has(turnEntry.turnId))).toBe(false);
    expect([...evicted, ...recent]).toHaveLength(15);
  });

  it('evictedTurnsSince only returns turns newer than afterAt', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ at: 0 }));
    for (let i = 1; i <= 15; i += 1) {
      appendTurn(
        scope,
        turn({ turnId: `turn-${String(i)}`, at: i * 1_000, text: `message ${String(i)}` }),
      );
    }
    const window = { maxTurns: 12, maxChars: 6_000 };
    expect(
      evictedTurnsSince(scope, 'conv-1', { afterAt: 2_000, window }).map(
        (turnEntry) => turnEntry.turnId,
      ),
    ).toEqual(['turn-3']);
    expect(evictedTurnsSince(scope, 'conv-1', { afterAt: 3_000, window })).toEqual([]);
  });

  it('deleting the conversation removes the summary with the row', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary(),
        throughAt: 2_000,
        now: 9_000,
      }).written,
    ).toBe(true);
    deleteConversation(scope, 'conv-1');
    expect(getConversation(scope, 'conv-1')).toBeUndefined();
    expect(getSummary(scope, 'conv-1')).toBeUndefined();
  });

  it('records the 0051_conversation_summaries migration tag in the journal', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => e.tag === '0051_conversation_summaries')).toBe(true);
  });
});

describe('searchSummaries (ADR 0093)', () => {
  const CHANNEL_B = '666666666666666666';
  const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
    topic: 'Friday social planning',
    facts: [{ text: 'The hall opens at six', from: 'member' }],
    botClaims: [],
    openQuestions: [],
    commitments: [],
    participants: [],
    ...over,
  });

  const seed = (
    conversationId: string,
    channelId: string,
    at: number,
    summaryValue: ConversationSummary,
  ): void => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation({ conversationId, channelId, at }));
    appendTurn(scope, turn({ conversationId, turnId: `turn-${conversationId}`, at, text: 'hi' }));
    expect(
      writeSummaryIfNewer(scope, {
        conversationId,
        summary: summaryValue,
        throughAt: at,
        now: at + 1,
      }).written,
    ).toBe(true);
  };

  it('finds a matching summary and returns it newest first', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-old', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    seed('conv-new', CHANNEL, 2_000, summary({ topic: 'robot arm gripper' }));
    const hits = searchSummaries(scope, {
      query: 'robot arm',
      channelIds: [CHANNEL],
      limit: 5,
    });
    expect(hits.map((hit) => hit.conversationId)).toEqual(['conv-new', 'conv-old']);
    expect(hits[0]?.summary.topic).toBe('robot arm gripper');
    expect(hits[0]?.channelId).toBe(CHANNEL);
    expect(hits[0]?.lastActivityAt).toBe(2_000);
  });

  it('keeps guild B from reading guild A summaries', () => {
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    const hits = searchSummaries(t.scopes.forGuild(GUILD_B), {
      query: 'robot arm',
      channelIds: [CHANNEL],
      limit: 5,
    });
    expect(hits).toEqual([]);
  });

  it('searches only the given channels', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    seed('conv-2', CHANNEL_B, 2_000, summary({ topic: 'robot arm gripper' }));
    expect(
      searchSummaries(scope, { query: 'robot arm', channelIds: [CHANNEL], limit: 5 }).map(
        (hit) => hit.conversationId,
      ),
    ).toEqual(['conv-1']);
    expect(
      searchSummaries(scope, { query: 'robot arm', channelIds: [CHANNEL_B], limit: 5 }).map(
        (hit) => hit.conversationId,
      ),
    ).toEqual(['conv-2']);
  });

  it('returns [] for an empty channel list', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    expect(searchSummaries(scope, { query: 'robot arm', channelIds: [], limit: 5 })).toEqual([]);
  });

  it('excludes the current conversation', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    seed('conv-2', CHANNEL, 2_000, summary({ topic: 'robot arm gripper' }));
    expect(
      searchSummaries(scope, {
        query: 'robot arm',
        channelIds: [CHANNEL],
        excludeConversationId: 'conv-2',
        limit: 5,
      }).map((hit) => hit.conversationId),
    ).toEqual(['conv-1']);
  });

  it('drops a deleted conversation from the index', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    expect(
      searchSummaries(scope, { query: 'robot arm', channelIds: [CHANNEL], limit: 5 }),
    ).toHaveLength(1);
    deleteConversation(scope, 'conv-1');
    expect(searchSummaries(scope, { query: 'robot arm', channelIds: [CHANNEL], limit: 5 })).toEqual(
      [],
    );
  });

  it('re-indexes an updated summary', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: summary({ topic: 'potluck dessert table' }),
        throughAt: 2_000,
        now: 2_001,
      }).written,
    ).toBe(true);
    expect(searchSummaries(scope, { query: 'robot arm', channelIds: [CHANNEL], limit: 5 })).toEqual(
      [],
    );
    expect(
      searchSummaries(scope, { query: 'potluck dessert', channelIds: [CHANNEL], limit: 5 }).map(
        (hit) => hit.conversationId,
      ),
    ).toEqual(['conv-1']);
  });

  it('does not throw on FTS syntax characters in the query', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed('conv-1', CHANNEL, 1_000, summary({ topic: 'robot arm gearbox' }));
    for (const query of ['"unbalanced', 'foo* AND', '(bar', 'column:', 'NEAR(foo, bar)']) {
      expect(() =>
        searchSummaries(scope, { query, channelIds: [CHANNEL], limit: 5 }),
      ).not.toThrow();
    }
  });

  it('stores the rendered summary text alongside the JSON', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    createConversation(scope, conversation());
    const value = summary();
    expect(
      writeSummaryIfNewer(scope, {
        conversationId: 'conv-1',
        summary: value,
        throughAt: 2_000,
        now: 9_000,
      }).written,
    ).toBe(true);
    const row = t.raw
      .prepare(
        `SELECT summary_text AS text FROM assistant_conversations WHERE guild_id = ? AND conversation_id = ?`,
      )
      .get(GUILD_A, 'conv-1') as { text: string | null };
    expect(row.text).toContain('Friday social planning');
    expect(row.text).toContain('The hall opens at six');
  });

  it('records the 0052_conversation_summary_search migration tag in the journal', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => e.tag === '0052_conversation_summary_search')).toBe(true);
  });
});
