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
});
