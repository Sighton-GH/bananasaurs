// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleSummary } from '../api/automod.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { CutoverPage } from './cutover.js';

afterEach(cleanup);

const NOW = 1_786_000_000_000;
const DAY_MS = 86_400_000;

function rule(overrides: Partial<RuleSummary> = {}): RuleSummary {
  return {
    ruleId: 'no-invites',
    kind: 'invite',
    name: 'No invites',
    mode: 'observe',
    enabled: true,
    config: '{}',
    cutoverState: 'observing',
    observeStartedAt: NOW - 3 * DAY_MS,
    legacyRuleRef: 'carl-bot:spam',
    countsAsViolation: true,
    maxFalsePositiveRate: 0,
    minReviewedMatches: 20,
    enforceSignedOffBy: null,
    enforceSignedOffAt: null,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 3 * DAY_MS,
    matchCount: 12,
    reviewedCount: 5,
    verdicts: { falsePositive: 0, truePositive: 0, unclear: 0 },
    ...overrides,
  };
}

describe('CutoverPage', () => {
  beforeEach(() => {
    // Fake only the clock: `findBy` polls with real timers, while days
    // observed is computed from a fixed `Date.now()`.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports each rule: state, days observed, counts, legacy ref and sign-off', async () => {
    stubFetch([
      {
        url: '/api/automod/rules',
        body: {
          rules: [
            rule(),
            rule({
              ruleId: 'no-links',
              kind: 'link_domain',
              name: 'No links',
              cutoverState: 'ready',
              observeStartedAt: NOW - 20 * DAY_MS,
              legacyRuleRef: null,
              enforceSignedOffBy: 'owner',
              enforceSignedOffAt: NOW - DAY_MS,
              matchCount: 30,
              reviewedCount: 25,
            }),
          ],
        },
      },
    ]);
    renderWithSession(<CutoverPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cutover' })).toBeTruthy();
    expect(
      screen.getByText(
        'Enforcement is offered only by the release gate (ADR 0042); this board reports, it does not move anything.',
      ),
    ).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Cutover board' });
    // The observing rule under the floor reads "3 of 14"; the ready rule
    // past it reads plain days — "of 14" appears exactly once.
    expect(within(table).getByText('3 of 14')).toBeTruthy();
    expect(within(table).getByText('20 days')).toBeTruthy();
    expect(screen.getAllByText(/of 14/)).toHaveLength(1);
    expect(within(table).getByText('observing')).toBeTruthy();
    expect(within(table).getByText('carl-bot:spam')).toBeTruthy();
    expect(within(table).getByText('12')).toBeTruthy();
    expect(within(table).getByText('5')).toBeTruthy();
    expect(within(table).getByText('30')).toBeTruthy();
    expect(within(table).getByText('25')).toBeTruthy();
    expect(
      within(table).getByText(`owner at ${new Date(NOW - DAY_MS).toLocaleString()}`),
    ).toBeTruthy();
    // One rule has no legacy ref and no sign-off: both cells read "—".
    expect(within(table).getAllByText('—')).toHaveLength(2);
  });
});
