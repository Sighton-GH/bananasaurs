// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { NativeHit, ReviewableMatch, RuleSummary } from '../api/automod.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ReviewPage } from './review.js';

afterEach(cleanup);

function rule(overrides: Partial<RuleSummary> = {}): RuleSummary {
  return {
    ruleId: 'kw-one',
    kind: 'keyword_filter',
    name: 'Keyword one',
    mode: 'observe',
    enabled: true,
    config: '{}',
    cutoverState: 'observing',
    observeStartedAt: null,
    legacyRuleRef: null,
    countsAsViolation: true,
    maxFalsePositiveRate: 0,
    minReviewedMatches: 20,
    enforceSignedOffBy: null,
    enforceSignedOffAt: null,
    createdAt: 1,
    updatedAt: 1,
    matchCount: 1,
    reviewedCount: 0,
    verdicts: { falsePositive: 0, truePositive: 0, unclear: 0 },
    ...overrides,
  };
}

function match(overrides: Partial<ReviewableMatch> = {}): ReviewableMatch {
  return {
    eventId: 'evt-1',
    ruleId: 'kw-one',
    memberId: 'member-1',
    at: 1_700_000_000_000,
    matchedCategory: 'profanity',
    matchedSnippet: 'badword',
    actionTaken: 'would_delete',
    trace: undefined,
    fixtureContent: undefined,
    ...overrides,
  };
}

function nativeHit(overrides: Partial<NativeHit> = {}): NativeHit {
  return {
    eventId: 'native-evt-1',
    ruleId: 'native:spam-content',
    memberId: 'member-2',
    at: 1_700_000_100_000,
    matchedCategory: 'spam',
    matchedSnippet: 'buy now buy now',
    actionTaken: 'blocked',
    ...overrides,
  };
}

function renderAt(path: string) {
  const { hook } = memoryLocation({ path });
  return renderWithSession(
    <Router hook={hook}>
      <ReviewPage />
    </Router>,
  );
}

describe('ReviewPage', () => {
  it('renders one tally row per rule with the verdict sums', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [],
          nativeHits: [],
          nativeBlocked: 0,
          verdicts: {
            'kw-one': { falsePositive: 1, truePositive: 3, unclear: 1 },
            'no-links': { falsePositive: 0, truePositive: 0, unclear: 0 },
          },
        },
      },
      {
        url: '/api/automod/rules',
        body: { rules: [rule(), rule({ ruleId: 'no-links', kind: 'link_domain' })] },
      },
    ]);
    renderAt('/review');
    expect(await screen.findByRole('heading', { level: 1, name: 'Review' })).toBeTruthy();
    const tally = await screen.findByRole('table', { name: 'Reviewed matches per rule' });
    const rows = within(tally).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + two rules
    const kwRow = within(tally).getByRole('link', { name: 'kw-one' }).closest('tr')!;
    expect(within(kwRow).getAllByText('1')).toHaveLength(2); // false positive + unclear
    expect(within(kwRow).getByText('3')).toBeTruthy(); // true positive
    expect(within(kwRow).getByText('5')).toBeTruthy(); // reviewed sum
  });

  it('adds a zero row for a rule present in matches but absent from verdicts', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [match({ ruleId: 'unlisted-rule' })],
          nativeHits: [],
          nativeBlocked: 0,
          verdicts: {},
        },
      },
      { url: '/api/automod/rules', body: { rules: [] } },
    ]);
    renderAt('/review');
    const tally = await screen.findByRole('table', { name: 'Reviewed matches per rule' });
    expect(within(tally).getByRole('link', { name: 'unlisted-rule' })).toBeTruthy();
    const zeroRow = within(tally).getByRole('link', { name: 'unlisted-rule' }).closest('tr')!;
    expect(within(zeroRow).getAllByText('0')).toHaveLength(4);
  });

  it('shows the F3.2 warning when native has blocked messages and an overlap-kind rule is in view', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [match()],
          nativeHits: [],
          nativeBlocked: 4,
          verdicts: { 'kw-one': { falsePositive: 0, truePositive: 0, unclear: 0 } },
        },
      },
      { url: '/api/automod/rules', body: { rules: [rule()] } },
    ]);
    renderAt('/review');
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/Native AutoMod has blocked 4 messages/);
  });

  it('hides the F3.2 warning when native has blocked messages but only a regex rule is in view', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [match({ ruleId: 'rx-one' })],
          nativeHits: [],
          nativeBlocked: 4,
          verdicts: { 'rx-one': { falsePositive: 0, truePositive: 0, unclear: 0 } },
        },
      },
      { url: '/api/automod/rules', body: { rules: [rule({ ruleId: 'rx-one', kind: 'regex' })] } },
    ]);
    renderAt('/review');
    await screen.findByRole('heading', { level: 1, name: 'Review' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('hides the F3.2 warning when native has blocked nothing', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [match()],
          nativeHits: [],
          nativeBlocked: 0,
          verdicts: { 'kw-one': { falsePositive: 0, truePositive: 0, unclear: 0 } },
        },
      },
      { url: '/api/automod/rules', body: { rules: [rule()] } },
    ]);
    renderAt('/review');
    await screen.findByRole('heading', { level: 1, name: 'Review' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows fixture content when present and the snippet note when absent', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: {
          matches: [
            match({ eventId: 'evt-fixture', fixtureContent: 'the whole flagged message' }),
            match({ eventId: 'evt-no-fixture', fixtureContent: undefined }),
          ],
          nativeHits: [],
          nativeBlocked: 0,
          verdicts: {},
        },
      },
      { url: '/api/automod/rules', body: { rules: [rule()] } },
    ]);
    renderAt('/review');
    expect(await screen.findByText('the whole flagged message')).toBeTruthy();
    expect(screen.getAllByText('badword')).toHaveLength(1);
    expect(
      screen.getByText(/snippet only — the message is not held: it was deleted in enforce mode/),
    ).toBeTruthy();
  });

  it('clicking False positive posts the verdict to the right URL and reloads', async () => {
    const mock = stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: { matches: [match()], nativeHits: [], nativeBlocked: 0, verdicts: {} },
      },
      { url: '/api/automod/rules', body: { rules: [rule()] } },
      {
        method: 'POST',
        url: '/api/automod/review/evt-1/verdict',
        body: { ok: true, outcome: 'recorded' },
      },
    ]);
    renderAt('/review');
    await screen.findByRole('heading', { level: 1, name: 'Review' });
    const before = mock.mock.calls.filter(
      (c) => (c[0] as string) === '/api/automod/review?limit=50',
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'False positive' }));
    });
    const post = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/automod/review/evt-1/verdict' &&
        (c[1] as RequestInit).method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({ verdict: 'false_positive' });
    await screen.findByText('Verdict recorded');
    const after = mock.mock.calls.filter(
      (c) => (c[0] as string) === '/api/automod/review?limit=50',
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  it('renders native hits in their own table with verdict buttons', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: { matches: [], nativeHits: [nativeHit()], nativeBlocked: 1, verdicts: {} },
      },
      { url: '/api/automod/rules', body: { rules: [] } },
    ]);
    renderAt('/review');
    const nativeTable = await screen.findByRole('table', { name: 'Native AutoMod hits' });
    expect(within(nativeTable).getByText('buy now buy now')).toBeTruthy();
    expect(within(nativeTable).getByRole('button', { name: 'False positive' })).toBeTruthy();
    expect(within(nativeTable).getByRole('button', { name: 'True positive' })).toBeTruthy();
    expect(within(nativeTable).getByRole('button', { name: 'Unclear' })).toBeTruthy();
  });

  it('?rule= adds &ruleId= to the review request URL', async () => {
    const mock = stubFetch([
      {
        url: '/api/automod/review?limit=50&ruleId=kw-one',
        body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
      },
      { url: '/api/automod/rules', body: { rules: [] } },
    ]);
    renderAt('/review?rule=kw-one');
    await screen.findByRole('heading', { level: 1, name: 'Review' });
    const call = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/review?limit=50&ruleId=kw-one',
    );
    expect(call).toBeTruthy();
  });

  it('shows the empty-queue text when there is nothing to review', async () => {
    stubFetch([
      {
        url: '/api/automod/review?limit=50',
        body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
      },
      { url: '/api/automod/rules', body: { rules: [] } },
    ]);
    renderAt('/review');
    expect(
      await screen.findByText(
        'Nothing to review. Matches recorded during the observe window appear here.',
      ),
    ).toBeTruthy();
  });
});
