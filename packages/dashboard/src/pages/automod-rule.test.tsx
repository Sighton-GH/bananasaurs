// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { RuleDetail } from '../api/automod.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AutomodRulePage } from './automod-rule.js';

afterEach(cleanup);

const NOW = 1_786_000_000_000;
const DAY_MS = 86_400_000;

function detail(overrides: Partial<RuleDetail> = {}): RuleDetail {
  return {
    ruleId: 'kw-one',
    kind: 'keyword_filter',
    name: 'Keyword one',
    enabled: true,
    config: '{}',
    configObject: {},
    countsAsViolation: true,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 3 * DAY_MS,
    matchCount: 12,
    reviewedCount: 5,
    verdicts: { falsePositive: 0, truePositive: 0, unclear: 0 },
    exemptions: [],
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
    ...overrides,
  };
}

function renderRule() {
  const { hook } = memoryLocation({ path: '/automod/kw-one' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/automod/:ruleId" component={AutomodRulePage} />
    </Router>,
  );
}

describe('AutomodRulePage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the status fields from GET /api/automod/rules/:ruleId', async () => {
    stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    expect(await screen.findByRole('heading', { level: 1, name: 'kw-one' })).toBeTruthy();
    const status = screen
      .getByRole('heading', { level: 2, name: 'Status' })
      .closest('section') as HTMLElement;
    expect(within(status).getByText('Keyword filter')).toBeTruthy();
    expect(within(status).getByText('(keyword_filter)')).toBeTruthy();
    expect(within(status).getByText('12')).toBeTruthy();
    expect(within(status).getByText('5')).toBeTruthy();
    expect(within(status).getByLabelText('Enabled')).toHaveProperty('checked', true);
    expect(
      within(status).getByText('A disabled rule is skipped even when automod is on.'),
    ).toBeTruthy();
  });

  it('shows no staged-rollout control (ADR 0121)', async () => {
    stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Status' });
    for (const label of ['Test', 'Observe', 'Enforce']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.queryByRole('heading', { level: 2, name: 'Mode' })).toBeNull();
    expect(screen.queryByText(/Dry run/)).toBeNull();
    expect(screen.queryByText(/Stage|Sign-off|Observed since/)).toBeNull();
  });

  it.each([
    [true, false],
    [false, true],
  ])('toggling Enabled (from %s) posts { enabled: %s } and reloads', async (from, to) => {
    const mock = stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail({ enabled: from }) },
      { method: 'POST', url: '/api/automod/rules/kw-one/enabled', body: { ok: true } },
    ]);
    renderRule();
    const box = await screen.findByLabelText('Enabled');
    await act(async () => {
      fireEvent.click(box);
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/rules/kw-one/enabled',
    );
    expect(post).toBeTruthy();
    expect((post![1] as RequestInit).method).toBe('POST');
    expect(bodyOf(post!)).toEqual({ enabled: to });
    const reads = mock.mock.calls.filter((c) => (c[0] as string) === '/api/automod/rules/kw-one');
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('config save with invalid JSON never fetches', async () => {
    const mock = stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Configuration' });
    fireEvent.change(screen.getByLabelText('Configuration'), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByText('Not valid JSON')).toBeTruthy();
    // Only the detail GET (and the pickers' list loads) may have fired -
    // never a config write.
    expect(mock.mock.calls.filter((c) => (c[0] as string).includes('/config'))).toHaveLength(0);
  });

  it('config save posts { config } parsed from the textarea', async () => {
    const mock = stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail() },
      { method: 'PUT', url: '/api/automod/rules/kw-one/config', body: { ok: true } },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Configuration' });
    fireEvent.change(screen.getByLabelText('Configuration'), {
      target: { value: '{"minLength":20}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Replaces this rule's configuration.");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save configuration' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/rules/kw-one/config',
    );
    expect(put).toBeTruthy();
    expect((put![1] as RequestInit).method).toBe('PUT');
    expect(bodyOf(put!)).toEqual({ config: { minLength: 20 } });
    expect(screen.getByRole('status').textContent).toContain('Configuration saved');
  });

  it('exemption remove calls DELETE with the right path', async () => {
    const mock = stubFetch([
      {
        url: '/api/automod/rules/kw-one',
        body: detail({ exemptions: [{ exemptType: 'role', exemptId: '111' }] }),
      },
      {
        method: 'DELETE',
        url: '/api/automod/rules/kw-one/exemptions/role/111',
        body: { ok: true, outcome: 'removed' },
      },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Exemptions' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    const call = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/rules/kw-one/exemptions/role/111',
    );
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe('DELETE');
  });

  it('renders the error state naming the rule when it does not exist', async () => {
    stubFetch([]);
    renderRule();
    expect(await screen.findByText(/Could not load rule kw-one/)).toBeTruthy();
  });
});
