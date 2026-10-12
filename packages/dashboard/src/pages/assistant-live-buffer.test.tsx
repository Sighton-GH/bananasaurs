// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
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
