import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  appendTurn,
  createConversation,
  deleteConversation,
  endConversation,
  forgetAuthor,
  getConversation,
  latestForAuthor,
  linkMessages,
  listConversations,
  lookupMessage,
  pruneOlderThan,
  recentTurns,
  setFeedback,
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
    appendTurn(scope, turn({ turnId: 'turn-1', at: 2_000 }));
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

    expect(setFeedback(scope, '600000000000000099', 'up')).toBe(false);
    expect(setFeedback(scope, '600000000000000001', 'up')).toBe(true);
    expect(recentTurns(scope, 'conv-1', { maxTurns: 12, maxChars: 6_000 })[0]?.feedback).toBe('up');
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
});
