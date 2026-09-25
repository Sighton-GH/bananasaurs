import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type ConversationResolution } from '@bananasaurs/core';
import { conversationRepo, guildRepo } from '@bananasaurs/storage';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { buildConversationContext } from './conversation-context.js';

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '333333333333333333';
const AMA = '444444444444444444';
const BO = '555555555555555555';
const NOW = 1_790_000_000_000;

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
});

afterEach(() => t.close());

const seedConversation = (conversationId: string, turns: readonly { role: 'user' | 'assistant' | 'quote'; authorId?: string; authorName: string; text: string }[]): void => {
  const scope = t.scopes.forGuild(GUILD);
  conversationRepo.createConversation(scope, {
    conversationId,
    channelId: CHANNEL,
    behaviourId: 'club',
    startedBy: AMA,
    title: 'fixture conversation',
    source: 'discord',
    at: NOW,
  });
  turns.forEach((turn, index) => {
    conversationRepo.appendTurn(scope, {
      conversationId,
      turnId: `turn-${index}`,
      at: NOW + index,
      role: turn.role,
      ...(turn.authorId === undefined ? {} : { authorId: turn.authorId }),
      authorName: turn.authorName,
      text: turn.text,
    });
  });
};

const followUp: ConversationResolution = {
  kind: 'continue',
  conversationId: 'conv-1',
  rule: 'follow-up',
};

describe('buildConversationContext', () => {
  it('maps one participant without name prefixes and reports one participant', () => {
    seedConversation('conv-1', [
      { role: 'user', authorId: AMA, authorName: 'Ama', text: 'first question' },
      { role: 'assistant', authorName: 'bananasaurs', text: 'first answer' },
    ]);
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: followUp,
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.participants).toBe(1);
    expect(ctx.quoteEnvelope).toBeUndefined();
    expect(ctx.history).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
    ]);
  });

  it('prefixes user turns with author names when more than one human takes part', () => {
    seedConversation('conv-1', [
      { role: 'user', authorId: AMA, authorName: 'Ama', text: 'first question' },
      { role: 'assistant', authorName: 'bananasaurs', text: 'first answer' },
      { role: 'user', authorId: BO, authorName: 'Bo', text: 'second question' },
    ]);
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: followUp,
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.participants).toBe(2);
    expect(ctx.history).toEqual([
      { role: 'user', text: 'Ama: first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'Bo: second question' },
    ]);
  });

  it('wraps the quoted message in the untrusted envelope, never as a system message', () => {
    seedConversation('conv-1', [
      { role: 'user', authorId: AMA, authorName: 'Ama', text: 'is that right?' },
    ]);
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: { kind: 'new', rule: 'quoted-reply', quotedMessageId: '900000000000000001' },
      quoted: { authorName: 'Alex', content: 'the hall opens at seven' },
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.quoteEnvelope).toBe(
      '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
    );
    expect(ctx.history.every((message) => message.role === 'user' || message.role === 'assistant')).toBe(true);
  });

  it('renders a stored quote turn as an enveloped user message', () => {
    seedConversation('conv-1', [
      { role: 'quote', authorName: 'Alex', text: 'the hall opens at seven' },
      { role: 'user', authorId: AMA, authorName: 'Ama', text: 'is that right?' },
    ]);
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: followUp,
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.history[0]).toEqual({
      role: 'user',
      text: '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
    });
    expect(ctx.history.every((message) => message.role === 'user' || message.role === 'assistant')).toBe(true);
  });

  it('does not count the bot display name as a participant', () => {
    seedConversation('conv-1', [
      { role: 'user', authorId: AMA, authorName: 'Ama', text: 'first question' },
      { role: 'user', authorId: AMA, authorName: 'bananasaurs', text: 'mislabelled echo' },
    ]);
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: followUp,
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.participants).toBe(1);
    expect(ctx.history).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'user', text: 'mislabelled echo' },
    ]);
  });

  it('returns empty history for a new conversation without a quote', () => {
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: { kind: 'new', rule: 'fresh' },
      botDisplayName: 'bananasaurs',
    });
    expect(ctx).toEqual({ history: [], participants: 0 });
  });

  it('stays inside the 12 turn window', () => {
    seedConversation(
      'conv-1',
      Array.from({ length: 14 }, (_, index) => ({
        role: 'user' as const,
        authorId: AMA,
        authorName: 'Ama',
        text: `question ${String(index)}`,
      })),
    );
    const ctx = buildConversationContext({
      scope: t.scopes.forGuild(GUILD),
      resolution: followUp,
      botDisplayName: 'bananasaurs',
    });
    expect(ctx.history.length).toBeLessThanOrEqual(12);
    expect(ctx.history.at(-1)?.text).toContain('question 13');
  });
});
