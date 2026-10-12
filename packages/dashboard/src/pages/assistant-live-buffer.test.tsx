// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@bananasaurs/core';
import { SessionProvider } from '../app/session.js';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { describeRunEvent, runLiveUrl } from '../api/runs.js';
import { LiveText } from './assistant-live-buffer.js';
import { StepLog } from './assistant-live.js';

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LiveText', () => {
  it('polls the live route and shows answer plus collapsed thinking', async () => {
    const mock = stubFetch([
      { url: runLiveUrl('run-1'), body: { answer: 'hello Sam L', thinking: 'why this answer' } },
    ]);
    renderWithSession(<LiveText runId="run-1" />);
    expect(await screen.findByText(/hello Sam L/)).toBeDefined();
    expect(await screen.findByText(/why this answer/)).toBeDefined();
    const details = screen.getByText(/why this answer/).closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(mock).toHaveBeenCalled();
  });
});

describe('LiveText details', () => {
  it('opens the thinking when the summary is clicked', async () => {
    stubFetch([{ url: runLiveUrl('run-1'), body: { answer: 'a', thinking: 'deep thought' } }]);
    renderWithSession(<LiveText runId="run-1" />);
    const summary = await screen.findByText('Thinking');
    fireEvent.click(summary);
    expect(summary.closest('details')?.open).toBe(true);
  });

  it('keeps polling every 2 s while the run is live', async () => {
    vi.useFakeTimers();
    const mock = stubFetch([{ url: runLiveUrl('run-1'), body: { answer: 'a', thinking: '' } }]);
    renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    expect(mock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the run is finished', async () => {
    vi.useFakeTimers();
    const mock = stubFetch([{ url: runLiveUrl('run-1'), body: { answer: 'done', thinking: '' } }]);
    renderWithSession(<LiveText runId="run-1" finished />);
    await act(async () => {});
    expect(mock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('done')).toBeTruthy();
  });
});

function seqFetch(live: (n: number) => { status: number; body: unknown }) {
  let n = 0;
  const mock = vi.fn(() => {
    n += 1;
    const r = live(n);
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('LiveText finish and failure handling', () => {
  it('keeps the last text when a later poll returns empty (buffer dropped at finish)', async () => {
    vi.useFakeTimers();
    seqFetch((n) => ({
      status: 200,
      body: n === 1 ? { answer: 'final words', thinking: 'why' } : { answer: '', thinking: '' },
    }));
    renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    expect(screen.getByText('final words')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('final words')).toBeTruthy();
    expect(screen.queryByText(/Waiting for the first streamed text/)).toBeNull();
  });

  it('renders nothing for a finished run whose live data is empty', async () => {
    seqFetch(() => ({ status: 200, body: { answer: '', thinking: '' } }));
    const { container } = renderWithSession(<LiveText runId="run-1" finished />);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('does not fetch again after finished is set, and keeps the text', async () => {
    vi.useFakeTimers();
    const mock = seqFetch(() => ({ status: 200, body: { answer: 'kept', thinking: '' } }));
    const view = renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    expect(mock).toHaveBeenCalledTimes(1);
    view.rerender(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <LiveText runId="run-1" finished />
      </SessionProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('kept')).toBeTruthy();
  });

  it.each([401, 403, 404])('renders nothing and does not retry on HTTP %i', async (status) => {
    vi.useFakeTimers();
    const mock = seqFetch(() => ({
      status,
      body: { error: status === 401 ? 'unauthenticated' : 'nope', message: 'no' },
    }));
    const { container } = renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
  });

  it('shows a calm error and retries on a transient failure', async () => {
    vi.useFakeTimers();
    const mock = seqFetch((n) =>
      n === 1
        ? { status: 500, body: { error: 'boom', message: 'boom' } }
        : { status: 200, body: { answer: 'back', thinking: '' } },
    );
    renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    expect(screen.getByText(/Could not load live text/)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(mock.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByText('back')).toBeTruthy();
  });

  it('keeps the thinking details open across polls', async () => {
    vi.useFakeTimers();
    stubFetch([{ url: runLiveUrl('run-1'), body: { answer: 'a', thinking: 'deep' } }]);
    renderWithSession(<LiveText runId="run-1" />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Thinking'));
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.getByText('Thinking').closest('details')?.open).toBe(true);
  });

  it('bounds and wraps long text', async () => {
    stubFetch([{ url: runLiveUrl('run-1'), body: { answer: 'x'.repeat(8000), thinking: '' } }]);
    renderWithSession(<LiveText runId="run-1" />);
    const p = await screen.findByText(/^x{8000}$/);
    expect(p.className).toContain('whitespace-pre-wrap');
    expect(p.className).toContain('break-words');
    expect(p.className).toContain('max-h-64');
    expect(p.className).toContain('overflow-y-auto');
  });
});

describe('describeRunEvent model-progress', () => {
  const progress = (answerChars: number, reasoningChars: number): RunEvent => ({
    kind: 'model-progress',
    round: 1,
    answerChars,
    reasoningChars,
    keepalives: 0,
    msSinceLastByte: 0,
  });
  it('renders both sides', () => {
    expect(describeRunEvent(progress(1240, 3100))).toBe(
      'Receiving… 1,240 chars of answer, 3,100 chars of thinking',
    );
  });
  it('omits a zero thinking side', () => {
    expect(describeRunEvent(progress(12, 0))).toBe('Receiving… 12 chars of answer');
  });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('LiveText failure then finish', () => {
  it('StepLog: a failing first /live then finish renders no card and makes no more requests', async () => {
    vi.useFakeTimers();
    const queued = { runId: 'run-1', seq: 1, at: 1000, event: { kind: 'queued', via: 'mention' } };
    const done = {
      runId: 'run-1',
      seq: 2,
      at: 3000,
      event: { kind: 'finished', outcome: 'answered', durationMs: 2000 },
    };
    let liveCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === runLiveUrl('run-1')) {
          liveCalls += 1;
          return Promise.resolve(json({ error: 'boom' }, 500));
        }
        return Promise.resolve(json({ events: url.includes('after=0') ? [queued] : [done] }));
      }),
    );
    renderWithSession(<StepLog runId="run-1" />);
    await act(async () => {});
    expect(liveCalls).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('finished')).toBeDefined();
    expect(screen.queryByText('Live answer')).toBeNull();
    expect(screen.queryByText(/Could not load live text/)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(liveCalls).toBe(1);
    expect(screen.queryByText('Live answer')).toBeNull();
  });
});

describe('LiveText run switch', () => {
  it('a late fetch from the old run cannot overwrite the new run cache', async () => {
    vi.useFakeTimers();
    let resolveA: ((r: Response) => void) | undefined;
    let bCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === runLiveUrl('run-a')) return new Promise<Response>((r) => (resolveA = r));
        bCalls += 1;
        return Promise.resolve(json({ answer: bCalls === 1 ? 'B text' : '', thinking: '' }));
      }),
    );
    const view = renderWithSession(<LiveText runId="run-a" />);
    await act(async () => {});
    view.rerender(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <LiveText runId="run-b" />
      </SessionProvider>,
    );
    await act(async () => {});
    expect(screen.getByText('B text')).toBeDefined();
    await act(async () => {
      resolveA?.(json({ answer: 'A text', thinking: '' }));
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('A text')).toBeNull();
    expect(screen.getByText('B text')).toBeDefined();
  });
});

describe('LiveText under StrictMode', () => {
  it('live then finish: text survives the dropped buffer and no request follows finish', async () => {
    vi.useFakeTimers();
    let dropped = false;
    const mock = seqFetch(() => ({
      status: 200,
      body: dropped ? { answer: '', thinking: '' } : { answer: 'streamed text', thinking: 'why' },
    }));
    const view = renderWithSession(
      <StrictMode>
        <LiveText runId="run-1" />
      </StrictMode>,
    );
    await act(async () => {});
    expect(screen.getByText('streamed text')).toBeTruthy();
    dropped = true;
    const before = mock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mock.mock.calls.length).toBeGreaterThan(before);
    // The daemon dropped the buffer at finish: an empty reply must not erase the text.
    expect(screen.getByText('streamed text')).toBeTruthy();
    view.rerender(
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <StrictMode>
          <LiveText runId="run-1" finished />
        </StrictMode>
      </SessionProvider>,
    );
    await act(async () => {});
    const callsAtFinish = mock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(mock.mock.calls.length).toBe(callsAtFinish);
    expect(screen.getByText('streamed text')).toBeTruthy();
  });
});
