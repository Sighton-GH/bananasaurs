// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@bananasaurs/core';
import { renderWithSession, stubFetch } from '../test-support.js';
import { describeRunEvent, runLiveUrl } from '../api/runs.js';
import { LiveText } from './assistant-live-buffer.js';

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
