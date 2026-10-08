// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import type { RunEvent } from '@bananasaurs/core';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { activeRunsUrl, describeRunEvent } from '../api/runs.js';
import { SessionProvider } from '../app/session.js';
import { InProgressPanel, PendingTurn, StepLog } from './assistant-live.js';

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('describeRunEvent', () => {
  it('describes a failed model-result with the code, status, latency and provider text', () => {
    const event: RunEvent = {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'stealth/space-bunny-alpha',
      keyId: 'key-1',
      ok: false,
      code: 'provider-bad-model',
      httpStatus: 404,
      ms: 291,
      providerMessage: 'No endpoints found',
    };
    const text = describeRunEvent(event);
    expect(text).toContain('provider-bad-model');
    expect(text).toContain('HTTP 404');
    expect(text).toContain('291 ms');
    expect(text).toContain('No endpoints found');
  });

  it('describes a successful model-result with tokens, reasoning, finish and tool calls', () => {
    const event: RunEvent = {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'club-model',
      keyId: 'key-1',
      ok: true,
      ms: 120,
      promptTokens: 100,
      completionTokens: 20,
      reasoningTokens: 5,
      finishReason: 'stop',
      toolCalls: 2,
    };
    expect(describeRunEvent(event)).toBe(
      'club-model answered in 120 ms, 100 in / 20 out tokens, 5 reasoning, finish stop, 2 tool calls',
    );
  });

  it('describes every other event kind in plain English', () => {
    const cases: Array<{ readonly event: RunEvent; readonly text: string }> = [
      { event: { kind: 'queued', via: 'mention' }, text: 'Queued (mention)' },
      {
        event: { kind: 'started', attempt: 2, queueWaitMs: 1500 },
        text: 'Started (attempt 2, waited 1,500 ms in queue)',
      },
      {
        event: { kind: 'conversation', continued: true, historyTurns: 4 },
        text: 'Continued conversation, 4 earlier turns',
      },
      {
        event: { kind: 'conversation', continued: false, historyTurns: 0 },
        text: 'New conversation, 0 earlier turns',
      },
      {
        event: {
          kind: 'context-built',
          sections: [
            { name: 'a', chars: 100, estTokens: 30 },
            { name: 'b', chars: 200, estTokens: 70 },
          ],
          snippetChunks: 2,
          memories: 3,
          channelMessages: 5,
          toolsOffered: ['t1', 't2'],
        },
        text: 'Built the prompt: 2 sections, ~100 tokens, 2 club-source snippets, 3 memories, 5 channel messages, 2 tools offered',
      },
      {
        event: {
          kind: 'model-call',
          position: 0,
          of: 2,
          provider: 'openrouter',
          model: 'club-model',
          keyId: 'key-1',
          round: 1,
        },
        text: 'Asked club-model (model 1 of 2, round 1)',
      },
      {
        event: {
          kind: 'model-skipped',
          provider: 'openrouter',
          model: 'old-model',
          keyId: 'key-1',
          reason: 'disabled',
        },
        text: 'Skipped old-model: disabled',
      },
      {
        event: { kind: 'tool-call', round: 1, tool: 'search_sources' },
        text: 'Calling tool search_sources',
      },
      {
        event: {
          kind: 'tool-result',
          round: 1,
          tool: 'search_sources',
          ok: true,
          ms: 15,
          resultChars: 42,
        },
        text: 'Tool search_sources ok, 42 chars, 15 ms',
      },
      {
        event: {
          kind: 'tool-result',
          round: 2,
          tool: 'read_chunk',
          ok: false,
          ms: 5,
          resultChars: 0,
        },
        text: 'Tool read_chunk refused: failed',
      },
      {
        event: {
          kind: 'tool-result',
          round: 2,
          tool: 'read_chunk',
          ok: false,
          ms: 5,
          resultChars: 0,
          refused: 'unknown handle',
        },
        text: 'Tool read_chunk refused: unknown handle',
      },
      { event: { kind: 'guard', removed: 1 }, text: 'Output guard removed 1 item(s)' },
      {
        event: { kind: 'guard', removed: 0, blocked: 'member-email' },
        text: 'Output guard removed 0 item(s), blocked member-email',
      },
      {
        event: {
          kind: 'retry-scheduled',
          code: 'provider-connect-timeout',
          retryAt: new Date(2026, 9, 8, 13, 5, 10).getTime(),
          attempt: 1,
        },
        text: 'Retry 2 scheduled for 13:05:10 after provider-connect-timeout',
      },
      { event: { kind: 'delivering', parts: 2 }, text: 'Posting the answer (2 part(s))' },
      { event: { kind: 'delivered', messageIds: ['a', 'b'] }, text: 'Posted 2 message(s)' },
      {
        event: { kind: 'finished', outcome: 'answered', durationMs: 1200, totalTokens: 130 },
        text: 'Finished: answered in 1,200 ms, 130 tokens',
      },
      {
        event: { kind: 'finished', outcome: 'failed', durationMs: 50, code: 'provider-timeout' },
        text: 'Finished: failed (provider-timeout) in 50 ms',
      },
    ];
    for (const { event, text } of cases) {
      expect(describeRunEvent(event)).toBe(text);
    }
  });
});

const RUN = {
  runId: 'run-1',
  conversationId: 'conv-1',
  userId: '100000000000000001',
  channelId: '333333333333333333',
  behaviourId: 'club',
  source: 'mention',
  state: 'running',
  stage: 'calling-model',
  attempt: 1,
  queuedAt: Date.now() - 65_000,
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 1_000,
  label: 'Asking nemotron (model 1 of 2)',
  stalled: true,
  member: { username: 'bryan', displayName: 'Bryan' },
};

/** First fetch answers one run, every later fetch answers none. */
function stubRunsOnce() {
  const calls: string[] = [];
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = calls.length === 1 ? { runs: [RUN] } : { runs: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

describe('InProgressPanel', () => {
  it('shows the run label and Stalled, then reports the finished run id once', async () => {
    vi.useFakeTimers();
    const calls = stubRunsOnce();
    const onFinished = vi.fn();
    renderWithSession(
      <Router>
        <InProgressPanel onFinished={onFinished} />
      </Router>,
    );
    await act(async () => {});
    expect(calls[0]).toBe(activeRunsUrl());
    expect(screen.getByText('Asking nemotron (model 1 of 2)')).toBeTruthy();
    expect(screen.getByText('Stalled')).toBeTruthy();

    // The next poll finds no runs: the finished id is reported exactly once.
    // The run is stalled, so the panel polls at the slow cadence.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(onFinished).toHaveBeenCalledTimes(0);
    await act(async () => {
      vi.advanceTimersByTime(13000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith('run-1');
    expect(screen.getByText('Nothing running right now.')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('polls slow when the only runs are stalled (ADR 0129)', async () => {
    vi.useFakeTimers();
    const calls = stubRunsOnce();
    renderWithSession(
      <Router>
        <InProgressPanel />
      </Router>,
    );
    await act(async () => {});
    expect(calls).toHaveLength(1);
    expect(screen.getByText('Stalled')).toBeTruthy();

    // A stalled-only list holds the slow cadence: 2 s polls nothing.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls).toHaveLength(1);

    // The slow 15 s tick polls again.
    await act(async () => {
      vi.advanceTimersByTime(13000);
    });
    expect(calls).toHaveLength(2);
  });

  it('polls fast while a non-stalled run is active (ADR 0129)', async () => {
    vi.useFakeTimers();
    const active = { ...RUN, stalled: false };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls.push(activeRunsUrl());
        return Promise.resolve(
          new Response(JSON.stringify({ runs: [active] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    renderWithSession(
      <Router>
        <InProgressPanel />
      </Router>,
    );
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls).toHaveLength(2);
  });

  it('says plainly when nothing runs', async () => {
    stubFetch([{ url: activeRunsUrl(), body: { runs: [] } }]);
    renderWithSession(
      <Router>
        <InProgressPanel />
      </Router>,
    );
    expect(await screen.findByText('Nothing running right now.')).toBeTruthy();
  });
});

describe('PendingTurn', () => {
  it('renders the pending bot turn only for its conversation', async () => {
    stubFetch([{ url: activeRunsUrl(), body: { runs: [RUN] } }]);
    const { unmount } = renderWithSession(
      <Router>
        <PendingTurn conversationId="conv-1" onFinished={() => undefined} />
      </Router>,
    );
    expect(await screen.findAllByText(/Asking nemotron/)).toHaveLength(2);
    unmount();
    cleanup();
    renderWithSession(
      <Router>
        <PendingTurn conversationId="conv-other" onFinished={() => undefined} />
      </Router>,
    );
    await act(async () => {});
    expect(screen.queryAllByText(/Asking nemotron/)).toHaveLength(0);
  });

  it('reloads the transcript when the seen run is replaced by another run', async () => {
    vi.useFakeTimers();
    const runA = {
      ...RUN,
      stalled: false,
      runId: 'run-a',
      label: 'Asking nemotron (model 1 of 2)',
    };
    const runB = { ...RUN, stalled: false, runId: 'run-b', label: 'Asking club (model 2 of 2)' };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const body = calls.length === 1 ? { runs: [runA] } : { runs: [runB] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const onFinished = vi.fn();
    renderWithSession(
      <Router>
        <PendingTurn conversationId="conv-1" onFinished={onFinished} />
      </Router>,
    );
    await act(async () => {});
    expect(calls[0]).toBe(activeRunsUrl());
    expect(screen.getAllByText(/Asking nemotron/).length).toBeGreaterThan(0);

    // Run A is replaced by run B between polls: A's completion still reloads once.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/Asking club/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Asking nemotron/)).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

const E1 = { seq: 1, at: 1_790_000_000_000, event: { kind: 'queued', via: 'mention' } };
const E2 = {
  seq: 2,
  at: 1_790_000_000_500,
  event: {
    kind: 'model-result',
    provider: 'openrouter',
    model: 'club-model',
    keyId: 'key-1',
    ok: true,
    ms: 900,
    promptTokens: 100,
    completionTokens: 20,
  },
};
const E3 = {
  seq: 3,
  at: 1_790_000_001_200,
  event: { kind: 'finished', outcome: 'answered', durationMs: 1200 },
};

describe('StepLog', () => {
  it('appends incremental polls without duplicating rows', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const body = url.includes('after=2') ? { events: [E3] } : { events: [E1, E2] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    renderWithSession(
      <Router>
        <StepLog runId="run-1" />
      </Router>,
    );
    await act(async () => {});
    expect(calls[0]).toContain('after=0');
    expect(screen.getAllByText('queued')).toHaveLength(1);
    expect(screen.getAllByText('model-result')).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls[1]).toContain('after=2');
    expect(screen.getAllByText('queued')).toHaveLength(1);
    expect(screen.getAllByText('model-result')).toHaveLength(1);
    expect(screen.getAllByText('finished')).toHaveLength(1);
    expect(screen.getByText('+0.5 s')).toBeTruthy();
    expect(screen.getByText('club-model answered in 900 ms, 100 in / 20 out tokens')).toBeTruthy();
    expect(screen.getByText('Finished: answered in 1,200 ms')).toBeTruthy();
  });

  it('stops polling once the finished event has been seen (ADR 0129)', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const body = url.includes('after=2') ? { events: [E3] } : { events: [E1, E2] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    renderWithSession(
      <Router>
        <StepLog runId="run-1" />
      </Router>,
    );
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls).toHaveLength(2);
    expect(screen.getAllByText('finished')).toHaveLength(1);

    // No further requests while the finished log stays on screen.
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(calls).toHaveLength(2);
    expect(screen.getAllByText('finished')).toHaveLength(1);
    expect(screen.getByText('Finished: answered in 1,200 ms')).toBeTruthy();
  });

  it('starts over when the viewed run changes', async () => {
    vi.useFakeTimers();
    const at = 1_790_000_000_000;
    const aQueued = { seq: 1, at, event: { kind: 'queued', via: 'mention' } };
    const aDone = {
      seq: 2,
      at: at + 500,
      event: { kind: 'finished', outcome: 'answered', durationMs: 1200 },
    };
    const bPosting = { seq: 1, at, event: { kind: 'delivering', parts: 2 } };
    const bTool = {
      seq: 2,
      at: at + 500,
      event: { kind: 'tool-call', round: 1, tool: 'search_sources' },
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const events = url.includes('after=0')
          ? url.includes('/run-a/')
            ? [aQueued, aDone]
            : [bPosting, bTool]
          : [];
        return Promise.resolve(
          new Response(JSON.stringify({ events }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const view = renderWithSession(
      <Router>
        <StepLog runId="run-a" />
      </Router>,
    );
    await act(async () => {});
    expect(calls[0]).toContain('run-a');
    expect(calls[0]).toContain('after=0');
    expect(screen.getByText('Finished: answered in 1,200 ms')).toBeTruthy();

    view.rerender(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <Router>
          <StepLog runId="run-b" />
        </Router>
      </SessionProvider>,
    );
    await act(async () => {});
    // Only B's events from seq 1: B polls from after=0, not from A's last seq.
    expect(calls.some((c) => c.includes('run-b') && c.includes('after=0'))).toBe(true);
    expect(screen.getByText('Posting the answer (2 part(s))')).toBeTruthy();
    expect(screen.getByText('Calling tool search_sources')).toBeTruthy();
    expect(screen.queryByText('Finished: answered in 1,200 ms')).toBeNull();

    // B is still running, so the log keeps the fast cadence for B.
    const pollsBefore = calls.filter((c) => c.includes('run-b')).length;
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls.filter((c) => c.includes('run-b')).length).toBeGreaterThan(pollsBefore);
    expect(calls.some((c) => c.includes('run-b') && c.includes('after=2'))).toBe(true);
  });

  it('says plainly when the run stored no step log', async () => {
    stubFetch([
      {
        url: '/api/assistant/runs/run-1/events?after=0',
        status: 404,
        body: { error: 'not-found' },
      },
    ]);
    renderWithSession(
      <Router>
        <StepLog runId="run-1" />
      </Router>,
    );
    expect(await screen.findByText('No step log is stored for this run.')).toBeTruthy();
  });
});
