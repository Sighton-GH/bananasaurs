// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { modeScopeSentence, type DryRunReport, type RuleDetail } from '../api/automod.js';
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
    mode: 'observe',
    enabled: true,
    config: '{}',
    configObject: {},
    cutoverState: 'observing',
    observeStartedAt: NOW - 3 * DAY_MS,
    legacyRuleRef: null,
    countsAsViolation: true,
    maxFalsePositiveRate: 0,
    minReviewedMatches: 20,
    enforceSignedOffBy: 'owner',
    enforceSignedOffAt: NOW - DAY_MS,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 3 * DAY_MS,
    matchCount: 12,
    reviewedCount: 5,
    exemptions: [],
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
    eligibility: { ok: true },
    ...overrides,
  };
}

function report(overrides: Partial<DryRunReport> = {}): DryRunReport {
  return {
    ruleId: 'kw-one',
    kind: 'keyword_filter',
    usable: true,
    failure: undefined,
    threw: 0,
    corpusSize: 10,
    total: 8,
    matched: 3,
    falsePositives: 1,
    falseNegatives: 2,
    results: [
      {
        fixtureId: 'f-agreed',
        label: 'should_match',
        matched: true,
        match: undefined,
        agreement: 'agreed',
        outcome: 'ok',
      },
      {
        fixtureId: 'f-disagreed',
        label: 'should_not_match',
        matched: true,
        match: undefined,
        agreement: 'disagreed',
        outcome: 'ok',
      },
    ],
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

  it('renders every status field from GET /api/automod/rules/:ruleId', async () => {
    stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    expect(await screen.findByRole('heading', { level: 1, name: 'kw-one' })).toBeTruthy();
    const status = screen
      .getByRole('heading', { level: 2, name: 'Status' })
      .closest('section') as HTMLElement;
    expect(within(status).getByText('keyword_filter')).toBeTruthy();
    expect(within(status).getByText('observe')).toBeTruthy();
    expect(within(status).getByText('observing')).toBeTruthy();
    expect(
      within(status).getByText(`${new Date(NOW - 3 * DAY_MS).toLocaleDateString()} (3 days)`),
    ).toBeTruthy();
    expect(within(status).getByText('12')).toBeTruthy();
    expect(within(status).getByText('5')).toBeTruthy();
    expect(
      within(status).getByText(`owner at ${new Date(NOW - DAY_MS).toLocaleString()}`),
    ).toBeTruthy();
    expect(within(status).getByText('Enforcement is offerable.')).toBeTruthy();
  });

  it.each([
    [
      'cutover-state',
      { reason: 'cutover-state', state: 'observing' },
      'Not offerable: cutover state is observing.',
    ],
    [
      'low-volume-unsigned',
      { reason: 'low-volume-unsigned', reviewed: 5, required: 20 },
      'Not offerable: 5 of 20 matches reviewed and no sign-off.',
    ],
    [
      'false-positive',
      { reason: 'false-positive', falsePositives: 2, reviewed: 25 },
      'Not offerable: 2 false-positive or unclear verdicts among 25 reviewed.',
    ],
    [
      'rate-too-high',
      { reason: 'rate-too-high', rate: 0.06, threshold: 0.05 },
      'Not offerable: false-positive rate 0.06 exceeds 0.05.',
    ],
  ])('renders the eligibility sentence for the %s refusal', async (_name, refusal, sentence) => {
    stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail({ eligibility: { ok: false, refusal } }) },
    ]);
    renderRule();
    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it('states the test-mode consequence for observing + test before confirming', async () => {
    stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Mode' });
    fireEvent.click(screen.getByLabelText('test'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply mode' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      'Switches to test mode: the rule keeps matching and recording fixtures but stops deleting; its cutover state stays observing and its clock keeps running, so the window will elapse with a gap in its evidence.',
    );
  });

  it('applying mode posts exactly { mode: "test" } and toasts', async () => {
    const mock = stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail() },
      { method: 'POST', url: '/api/automod/rules/kw-one/mode', body: { ok: true } },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Mode' });
    fireEvent.click(screen.getByLabelText('test'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply mode' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply mode' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/automod/rules/kw-one/mode');
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({ mode: 'test' });
    expect(screen.getByRole('status').textContent).toContain('Mode applied');
  });

  it('a 409 shows the refusal in the status region', async () => {
    stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail() },
      {
        method: 'POST',
        url: '/api/automod/rules/kw-one/mode',
        status: 409,
        body: {
          error: 'not-eligible',
          refusal: { reason: 'cutover-state', state: 'observing' },
        },
      },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Mode' });
    fireEvent.click(screen.getByLabelText('test'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply mode' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply mode' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not offerable: cutover state is observing.');
  });

  it('config save with invalid JSON never fetches', async () => {
    const mock = stubFetch([{ url: '/api/automod/rules/kw-one', body: detail() }]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Configuration' });
    fireEvent.change(screen.getByLabelText('Configuration'), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByText('Not valid JSON')).toBeTruthy();
    expect(mock.mock.calls).toHaveLength(1);
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

  it('dry run posts and renders the counts with disagreed first', async () => {
    const mock = stubFetch([
      { url: '/api/automod/rules/kw-one', body: detail() },
      { method: 'POST', url: '/api/automod/rules/kw-one/dry-run', body: report() },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Dry run' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run against fixtures' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/automod/rules/kw-one/dry-run',
    );
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({});
    const dry = screen
      .getByRole('heading', { level: 2, name: 'Dry run' })
      .closest('section') as HTMLElement;
    expect(await within(dry).findByText('Corpus size')).toBeTruthy();
    const counts = within(dry).getByText('Corpus size').closest('dl') as HTMLElement;
    for (const label of [
      'Corpus size',
      'Evaluated',
      'Matched',
      'False positives',
      'False negatives',
      'Threw',
    ]) {
      expect(within(counts).getByText(label)).toBeTruthy();
    }
    expect(counts.textContent).toContain('10');
    expect(counts.textContent).toContain('8');
    const table = within(dry).getByRole('table', { name: 'Dry-run results' });
    const text = table.textContent ?? '';
    expect(text).toContain('f-disagreed');
    expect(text.indexOf('f-disagreed')).toBeLessThan(text.indexOf('f-agreed'));
  });

  it('renders the error state naming the rule when it does not exist', async () => {
    stubFetch([]);
    renderRule();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('rule kw-one');
  });

  it.each([
    ['not_started', { mode: 'observe' }, "Starts this rule's observe window"],
    ['rolled_back', { mode: 'observe' }, "Starts this rule's observe window"],
    ['observing', { mode: 'test' }, 'clock keeps running'],
    ['cutover', { mode: 'test' }, 'Rolls this rule back'],
    ['ready', { mode: 'enforce' }, 'cutover'],
    ['observing', { mode: 'observe' }, 'stays observing'],
    ['observing', { enabled: false }, 'Disables the rule'],
    ['observing', { enabled: true }, 'Enables the rule in its current mode'],
  ])(
    'modeScopeSentence for %s with %j mentions "%s"',
    (cutoverState, request, substring) => {
      const sentence = modeScopeSentence(
        { cutoverState, mode: 'test', enabled: true },
        request,
        NOW,
      );
      expect(sentence).toContain(substring as string);
    },
  );

  it('modeScopeSentence covers enabled alongside mode', () => {
    const sentence = modeScopeSentence(
      { cutoverState: 'not_started', mode: 'test', enabled: true },
      { mode: 'observe', enabled: false },
      NOW,
    );
    expect(sentence).toContain("Starts this rule's observe window");
    expect(sentence).toContain('matching nothing');
  });

  it('disables the enforce radio while enforcement is not offerable, and enables it when it is', async () => {
    stubFetch([
      {
        url: '/api/automod/rules/kw-one',
        body: detail({ eligibility: { ok: false, refusal: { reason: 'cutover-state', state: 'observing' } } }),
      },
    ]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Mode' });
    expect((screen.getByLabelText('enforce') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([{ url: '/api/automod/rules/kw-one', body: detail({ eligibility: { ok: true } }) }]);
    renderRule();
    await screen.findByRole('heading', { level: 2, name: 'Mode' });
    expect((screen.getByLabelText('enforce') as HTMLInputElement).disabled).toBe(false);
  });
});
