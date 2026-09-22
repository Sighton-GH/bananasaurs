// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ProvidersPage } from './providers.js';

const WARNINGS = {
  warnings: [
    { provider: 'nim-free', reason: 'stale', trainsOnInput: 'no', reviewedAt: 0 },
    { provider: 'sketchy-ai', reason: 'not-no', trainsOnInput: 'unknown', reviewedAt: 0 },
  ],
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ProvidersPage', () => {
  it('lists the eligibility warnings with reasons and training flags', async () => {
    stubFetch([{ url: '/api/providers/eligibility', body: WARNINGS }]);
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('nim-free')).toBeTruthy();
    expect(screen.getByText(/terms review is old/)).toBeTruthy();
    expect(screen.getByText(/service has not confirmed/)).toBeTruthy();
    expect(screen.getByText('Not confirmed')).toBeTruthy();
  });

  it('says what a clean bill means when there are no warnings', async () => {
    stubFetch([{ url: '/api/providers/eligibility', body: { warnings: [] } }]);
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText(/configured AI service says it will not use/)).toBeTruthy();
  });

  it('mark reviewed states that only the review date changes, posts and reloads', async () => {
    const mock = stubFetch([
      { url: '/api/providers/eligibility', body: WARNINGS },
      {
        method: 'POST',
        url: '/api/providers/nim-free/review',
        body: {
          provider: 'nim-free',
          trainsOnInput: 'no',
          evidenceUrl: 'https://example.test/tos',
          productionUseAllowed: false,
          reviewedAt: 1000,
          previouslyReviewedAt: 0,
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByText('nim-free');
    fireEvent.click(screen.getAllByRole('button', { name: 'I checked these terms today' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('writes the review date only');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'I checked these terms today' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0] as string).toBe('/api/providers/nim-free/review');
    expect(bodyOf(post)).toEqual({});
    expect(
      mock.mock.calls.filter((c) => (c[0] as string) === '/api/providers/eligibility'),
    ).toHaveLength(2);
  });
});
