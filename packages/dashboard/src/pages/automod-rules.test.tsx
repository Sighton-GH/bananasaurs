// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleSummary } from '../api/automod.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AutomodRulesPage } from './automod-rules.js';

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
    legacyRuleRef: null,
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

describe('AutomodRulesPage', () => {
  beforeEach(() => {
    // Fake only the clock: `findBy` polls with real timers, while the
    // Observed column reads `Date.now()`.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders one row per rule from GET /api/automod/rules', async () => {
    stubFetch([
      {
        url: '/api/automod/rules',
        body: {
          rules: [rule({ verdicts: { falsePositive: 2, truePositive: 4, unclear: 1 } })],
        },
      },
    ]);
    renderWithSession(<AutomodRulesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Automod' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Automod rules' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    const link = within(table).getByRole('link', { name: 'No invites' });
    expect(link.getAttribute('href')).toBe('/automod/no-invites');
    expect(within(table).getByText('Invite links')).toBeTruthy();
    expect(within(table).getByText('(invite)')).toBeTruthy();
    expect(within(table).getByText('observe')).toBeTruthy();
    expect(within(table).getByText('3 days')).toBeTruthy();
    expect(within(table).getByText('12')).toBeTruthy();
    const reviewed = within(table).getByRole('link', { name: '7 (2 false positives)' });
    expect(reviewed.getAttribute('href')).toBe('/review?rule=no-invites');
  });

  it('posts the create body exactly and toasts on success', async () => {
    const mock = stubFetch([
      { url: '/api/automod/rules', body: { rules: [] } },
      { method: 'POST', url: '/api/automod/rules', body: { ok: true } },
    ]);
    renderWithSession(<AutomodRulesPage />);
    await screen.findByText('No rules yet. Create one below.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No links' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'regex' } });
    fireEvent.change(screen.getByLabelText('Configuration data'), {
      target: { value: '{"pattern":"x"}' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/rules' && (c[1] as RequestInit).method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({
      ruleId: 'no-links',
      kind: 'regex',
      name: 'No links',
      config: { pattern: 'x' },
    });
    expect(screen.getByRole('status').textContent).toContain('Rule created');
  });

  it('renders a 400 invalid-config detail under the configuration field', async () => {
    stubFetch([
      { url: '/api/automod/rules', body: { rules: [] } },
      {
        method: 'POST',
        url: '/api/automod/rules',
        status: 400,
        body: { error: 'invalid-config', reason: 'invalid-config', detail: 'pattern is required' },
      },
    ]);
    renderWithSession(<AutomodRulesPage />);
    await screen.findByText('No rules yet. Create one below.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No links' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    });
    expect(await screen.findByText('pattern is required')).toBeTruthy();
    expect(screen.queryByText('Rule created')).toBeNull();
  });

  it('renders a 409 through the server answer', async () => {
    stubFetch([
      { url: '/api/automod/rules', body: { rules: [] } },
      {
        method: 'POST',
        url: '/api/automod/rules',
        status: 409,
        body: {
          error: 'exists',
          title: 'Already exists',
          message: 'A rule with that id already exists.',
          hint: 'Pick another id or edit the existing rule.',
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderWithSession(<AutomodRulesPage />);
    await screen.findByText('No rules yet. Create one below.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No links' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    });
    expect(await screen.findByText('Already exists')).toBeTruthy();
    expect(screen.getByText('A rule with that id already exists.')).toBeTruthy();
  });

  it('shows the empty state when there are no rules', async () => {
    stubFetch([{ url: '/api/automod/rules', body: { rules: [] } }]);
    renderWithSession(<AutomodRulesPage />);
    expect(await screen.findByText('No rules yet. Create one below.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
