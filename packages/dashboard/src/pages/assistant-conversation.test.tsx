// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantConversationPage } from './assistant-conversation.js';

/** One stored conversation as data: fixed ids and timestamps, no narrative. */
const DETAIL = {
  conversation: {
    conversationId: 'conv-1',
    channelId: '333333333333333333',
    behaviourId: 'club',
    startedBy: '100000000000000001',
    title: 'Where is the handbook',
    source: 'dashboard-test',
    status: 'open',
    createdAt: 1_790_000_000_000,
    lastActivityAt: 1_790_000_002_000,
    turnCount: 3,
  },
  turns: [
    {
      turnId: 't-quote',
      at: 1_790_000_000_000,
      role: 'quote',
      authorId: '100000000000000002',
      authorName: 'Sasha',
      text: 'the original message being answered',
    },
    {
      turnId: 't-user',
      at: 1_790_000_001_000,
      role: 'user',
      authorId: '100000000000000001',
      authorName: 'Bryan',
      text: 'where is the handbook?',
    },
    {
      turnId: 't-assistant',
      at: 1_790_000_002_000,
      role: 'assistant',
      authorName: 'Bananasaurs',
      text: 'In the resources.',
      traceId: 'trace-1',
      feedback: 'up',
      sources: [{ title: 'Handbook', url: 'https://example.com/handbook' }],
    },
  ],
  links: [],
};

function renderDetail(detail: unknown = DETAIL) {
  const mock = stubFetch([
    { url: '/api/assistant/conversations/conv-1', body: detail },
    { method: 'POST', url: '/api/assistant/conversations/conv-1/end', body: { status: 'ended' } },
    {
      method: 'DELETE',
      url: '/api/assistant/conversations/conv-1',
      body: { deleted: true, traces: 1 },
    },
  ]);
  const { hook } = memoryLocation({ path: '/assistant/conversations/conv-1' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/conversations/:id" component={AssistantConversationPage} />
    </Router>,
  );
  return mock;
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantConversationPage', () => {
  it('renders the transcript oldest first with who, time and text', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversation' })).toBeTruthy();
    expect(screen.getByText('Where is the handbook')).toBeTruthy();
    expect(screen.getByText('where is the handbook?')).toBeTruthy();
    expect(screen.getByText('In the resources.')).toBeTruthy();
    expect(screen.getByText('Bryan')).toBeTruthy();
    expect(screen.getByText('Bananasaurs')).toBeTruthy();
    const times = Array.from(document.querySelectorAll('time')).map((t) =>
      t.getAttribute('dateTime'),
    );
    expect(times).toEqual([
      new Date(1_790_000_000_000).toISOString(),
      new Date(1_790_000_001_000).toISOString(),
      new Date(1_790_000_002_000).toISOString(),
    ]);
  });

  it('shows quote turns as a labelled quoted block', async () => {
    renderDetail();
    expect(await screen.findByText('Quoted message')).toBeTruthy();
    expect(screen.getByText('the original message being answered')).toBeTruthy();
  });

  it('shows the assistant turn sources and a View details link to the trace', async () => {
    renderDetail();
    expect(await screen.findByText('Handbook')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View details' });
    expect((link as HTMLAnchorElement).pathname).toBe('/assistant/history/trace-1');
  });

  it('offers What the AI saw inline on the traced assistant turn', async () => {
    stubFetch([
      { url: '/api/assistant/conversations/conv-1', body: DETAIL },
      {
        url: '/api/assistant/traces/trace-1',
        body: {
          trace: {
            traceId: 'trace-1',
            attempts: [{ provider: 'openrouter', model: 'conv-model', outcome: 'ok', ms: 100 }],
            usage: { promptTokens: 30, completionTokens: 8 },
            sections: [
              {
                name: 'user-message',
                chars: 21,
                estTokens: 6,
                text: 'where is the handbook?',
              },
            ],
            toolCalls: [],
          },
        },
      },
    ]);
    const { hook } = memoryLocation({ path: '/assistant/conversations/conv-1' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/conversations/:id" component={AssistantConversationPage} />
      </Router>,
    );
    await screen.findByText('In the resources.');
    // One button: only the assistant turn with a trace gets it, and View details stays.
    expect(screen.getAllByRole('button', { name: 'What the AI saw' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'View details' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'What the AI saw' }));
    });
    expect(await screen.findByText('conv-model')).toBeTruthy();
    expect(
      screen.getByText("The member's message and evidence · 21 characters · about 6 tokens"),
    ).toBeTruthy();
  });

  it('badges a dashboard-test conversation and an up-vote', async () => {
    renderDetail();
    expect(await screen.findByText('Dashboard test')).toBeTruthy();
    expect(screen.getByText('👍')).toBeTruthy();
  });

  it('ends an open conversation', async () => {
    const mock = renderDetail();
    await screen.findByRole('button', { name: 'End conversation' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    });
    const call = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/conversations/conv-1/end' &&
        (c[1] as RequestInit)?.method === 'POST',
    );
    expect(call).toBeTruthy();
  });

  it('deletes only after a confirmation that names the title', async () => {
    const mock = renderDetail();
    await screen.findByRole('button', { name: 'Delete conversation' });
    const triggers = screen.getAllByRole('button', { name: 'Delete conversation' });
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Where is the handbook');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    });
    const call = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/conversations/conv-1' &&
        (c[1] as RequestInit)?.method === 'DELETE',
    );
    expect(call).toBeTruthy();
    expect(bodyOf(call!)).toBeUndefined();
  });

  it('offers no End button once the conversation is ended', async () => {
    renderDetail({
      ...DETAIL,
      conversation: { ...DETAIL.conversation, status: 'ended' },
    });
    await screen.findByText('In the resources.');
    expect(screen.queryByRole('button', { name: 'End conversation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete conversation' })).toBeTruthy();
  });

  it('says plainly when the id is unknown', async () => {
    const { hook } = memoryLocation({ path: '/assistant/conversations/nope' });
    stubFetch([
      {
        url: '/api/assistant/conversations/nope',
        status: 404,
        body: { error: 'not-found' },
      },
    ]);
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/conversations/:id" component={AssistantConversationPage} />
      </Router>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no conversation with this id is stored for this server');
  });

  it('notes how a user turn joined on continue rules only', async () => {
    const userTurn = (turnId: string, text: string, extra: Record<string, string> = {}) => ({
      turnId,
      at: 1_790_000_001_000,
      role: 'user',
      authorId: '100000000000000001',
      authorName: 'Bryan',
      text,
      ...extra,
    });
    renderDetail({
      ...DETAIL,
      links: [],
      turns: [
        userTurn('t-fresh', 'a fresh question', { joinRule: 'fresh' }),
        userTurn('t-bot', 'replying to the bot', { joinRule: 'reply-to-bot' }),
        userTurn('t-turn', 'replying to an earlier message', { joinRule: 'reply-to-turn' }),
        userTurn('t-follow', 'following up myself', { joinRule: 'follow-up' }),
        userTurn('t-thread', 'asking in the same thread', { joinRule: 'thread' }),
        userTurn('t-channel', 'following up another member', {
          joinRule: 'channel-follow-up',
        }),
        userTurn('t-plain', 'no rule was recorded'),
      ],
    });
    const notes = [
      'Replied to the bot',
      'Replied to an earlier message',
      'Follow-up from the same member',
      'Asked in the same thread',
      'Joined as a follow-up from another member in the channel',
    ];
    for (const note of notes) {
      expect(await screen.findByText(note)).toBeTruthy();
    }
    for (const text of ['a fresh question', 'no rule was recorded']) {
      const item = screen.getByText(text).closest('li');
      for (const note of notes) {
        expect(item?.textContent).not.toContain(note);
      }
    }
  });

  it('lists linked conversations in both directions with the kind in words', async () => {
    renderDetail({
      ...DETAIL,
      links: [
        {
          otherConversationId: 'conv-2',
          otherTitle: 'Same channel chat',
          kind: 'same-channel',
          direction: 'outgoing',
          at: 3_000,
        },
        {
          otherConversationId: 'conv-3',
          otherTitle: 'Thread follow-on',
          kind: 'thread-parent',
          direction: 'outgoing',
          at: 2_000,
        },
        {
          otherConversationId: 'conv-0',
          otherTitle: 'Parent topic',
          kind: 'thread-parent',
          direction: 'incoming',
          at: 1_000,
        },
        {
          otherConversationId: 'conv-4',
          otherTitle: 'Earlier research',
          kind: 'recalled',
          direction: 'outgoing',
          at: 4_000,
        },
        {
          otherConversationId: 'conv-5',
          otherTitle: 'Later reference',
          kind: 'recalled',
          direction: 'incoming',
          at: 5_000,
        },
      ],
    });
    expect(await screen.findByText('Linked conversations')).toBeTruthy();
    const same = screen.getByRole('link', { name: 'Same channel chat' });
    expect((same as HTMLAnchorElement).pathname).toBe('/assistant/conversations/conv-2');
    const parent = screen.getByRole('link', { name: 'Parent topic' });
    expect((parent as HTMLAnchorElement).pathname).toBe('/assistant/conversations/conv-0');
    expect(screen.getByText('In the same channel at the same time')).toBeTruthy();
    expect(screen.getByText('Continues in a thread started from')).toBeTruthy();
    expect(screen.getByText('Has a thread conversation')).toBeTruthy();
    expect(screen.getByText('Looked back at')).toBeTruthy();
    expect(screen.getByText('Looked back at by')).toBeTruthy();
  });

  it('says plainly when no conversations are linked', async () => {
    renderDetail({ ...DETAIL, links: [] });
    expect(await screen.findByText('Linked conversations')).toBeTruthy();
    expect(screen.getByText('No linked conversations.')).toBeTruthy();
  });
});
