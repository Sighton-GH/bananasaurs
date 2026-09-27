import { describe, expect, it, vi } from 'vitest';
import { createNativeAutomodSubscriber } from './native-subscriber.js';
import type { AutoModerationEvent } from '../discord/events.js';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof createNativeAutomodSubscriber>[0]['logger'];

const deps = () => {
  const recorded: unknown[] = [];
  const openOrResolveCase = vi.fn(() => ({ caseId: 'case-1' }));
  return {
    recorded,
    openOrResolveCase,
    subscriber: createNativeAutomodSubscriber({
      logger: silentLogger,
      openOrResolveCase,
      recordCaseEvent: (input) => void recorded.push(input),
    }),
  };
};

const event = (over: Partial<AutoModerationEvent> = {}): AutoModerationEvent => ({
  kind: 'autoModerationAction',
  guildId: '111111111111111111',
  receivedAtMs: 1_700_000_000_000,
  ruleId: '222222222222222222',
  triggerType: 'keyword',
  userId: '333333333333333333',
  actionType: 'block',
  channelId: '444444444444444444',
  messageId: undefined,
  alertMessageId: undefined,
  content: 'a forbidden word',
  matchedKeyword: 'forbidden',
  matchedContent: 'forbidden',
  ...over,
});

describe('native automod subscriber', () => {
  it('ignores every event kind but its own', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle({
      kind: 'messageCreate',
      guildId: '111111111111111111',
      receivedAtMs: 1,
      channelId: '444444444444444444',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '555555555555555555',
      authorId: '333333333333333333',
      authorDisplayName: undefined,
      authorIsBot: false,
      content: 'hello',
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(recorded).toEqual([]);
  });

  it('records a block under the native sentinel', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event());
    expect(recorded).toEqual([
      {
        caseId: 'case-1',
        ruleId: 'native:222222222222222222',
        memberId: '333333333333333333',
        matchedCategory: 'keyword',
        matchedSnippet: 'forbidden',
        actionTaken: 'native_blocked',
      },
    ]);
  });

  it('never counts a native hit toward escalation', async () => {
    // ADR 0038: an algorithm nobody can inspect must not increment the counter
    // that drives our timeouts, kicks and bans.
    const { subscriber, openOrResolveCase } = deps();
    await subscriber.handle(event());
    expect(openOrResolveCase).toHaveBeenCalledWith('333333333333333333', {
      countsAsViolation: false,
    });
  });

  it.each([
    ['block', 'native_blocked'],
    ['alert', 'native_alerted'],
    ['timeout', 'native_timeout'],
    ['block_interaction', 'native_blocked_interaction'],
  ] as const)('maps the %s action to %s', async (actionType, expected) => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event({ actionType }));
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { actionTaken: string }).actionTaken).toBe(expected);
  });

  it('falls back to the matched content when Discord names no keyword', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event({ matchedKeyword: undefined, matchedContent: 'forb1dden' }));
    expect((recorded[0] as { matchedSnippet: string }).matchedSnippet).toBe('forb1dden');
  });

  it('records an empty snippet rather than dropping the event when nothing matched', async () => {
    // A spam-triggered rule names neither a keyword nor a matched substring.
    // The decision still happened and is still worth recording.
    const { subscriber, recorded } = deps();
    await subscriber.handle(
      event({ triggerType: 'spam', matchedKeyword: undefined, matchedContent: undefined }),
    );
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { matchedSnippet: string }).matchedSnippet).toBe('');
    expect((recorded[0] as { matchedCategory: string }).matchedCategory).toBe('spam');
  });

  it('clamps a long matchedContent to 200 characters with an ellipsis', async () => {
    // matchedContent can span most of the message for a native rule using regex.
    // An 1,800-character snippet would overflow the 2,000-char ceiling on
    // `/mod history` and cause every event on the case to be dropped. Clamping
    // is consistent with what "snippet" means elsewhere.
    const { subscriber, recorded } = deps();
    const longContent = 'x'.repeat(300);
    await subscriber.handle(event({ matchedKeyword: undefined, matchedContent: longContent }));
    expect(recorded).toHaveLength(1);
    const snippet = (recorded[0] as { matchedSnippet: string }).matchedSnippet;
    expect(snippet).toBe('x'.repeat(200) + '…');
    expect(snippet.length).toBe(201);
  });
});
