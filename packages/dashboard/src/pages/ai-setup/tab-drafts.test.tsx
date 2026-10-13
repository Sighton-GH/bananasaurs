// @vitest-environment jsdom
// Regression tests for the P5 unit 3 source-review P2: switching AI setup
// tabs must not destroy unsaved drafts or reissue mount-time requests.
// Adapted from the independent reviewer's bug-witness reproducer with the 7
// bug expectations inverted (preservation / exactly one call); the
// query/hash/Back control is unchanged.
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { ProvidersPage } from './index.js';

const setup = {
  providers: [{ provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 }],
  keys: [
    {
      keyId: 'key_a',
      provider: 'gemini',
      label: 'Main key',
      costClass: 'free',
      enabled: true,
      readable: true,
    },
  ],
  chain: [
    {
      position: 0,
      keyId: 'key_a',
      keyLabel: 'Main key',
      provider: 'gemini',
      model: 'gemini-original',
      status: 'ready',
    },
  ],
  webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
  github: { tokenConfigured: false },
};

function stub() {
  return stubFetch([
    { url: '/api/assistant/providers', body: setup },
    {
      url: '/api/assistant',
      body: {
        behaviours: [],
        resources: [],
        reminders: [],
        skills: [],
        activity: [],
        aiStatus: { provider: 'gemini', model: 'gemini-original', enabled: true },
        providerTerms: null,
        viewerIsOwner: true,
      },
    },
    { url: '/api/providers/eligibility', body: { warnings: [] } },
    { url: '/api/assistant/search-keys', body: { enabled: false, source: 'brave', keys: [] } },
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    { url: '/api/assistant/provider/models', method: 'POST', body: { models: [] } },
  ]);
}

async function tab(name: string) {
  const el = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/providers');
});

for (const [name, label] of [
  ['Keys', 'Label'],
  ['GitHub', 'GitHub token'],
  ['Model order', 'RPM limit for row 1'],
  ['Terms', 'Quote the sentence from the terms that says so'],
  ['Web search', 'Label'],
] as const) {
  it(`keeps the unsaved ${name} draft across a tab switch`, async () => {
    window.history.replaceState(null, '', '/providers');
    stub();
    renderWithSession(<ProvidersPage />);
    await tab(name);
    const input = await screen.findByLabelText(label);
    fireEvent.change(input, { target: { value: '123' } });
    expect((input as HTMLInputElement).value).toBe('123');
    await tab(name === 'GitHub' ? 'Keys' : 'GitHub');
    await tab(name);
    expect((await screen.findByLabelText<HTMLInputElement>(label)).value).toBe('123');
  });
}

it('does not reissue the model discovery POST or health GET on a tab-only revisit', async () => {
  window.history.replaceState(null, '', '/providers');
  const fetch = stub();
  renderWithSession(<ProvidersPage />);
  await screen.findByLabelText('RPM limit for row 1');
  const count = (url: string) => fetch.mock.calls.filter((c) => c[0] === url).length;
  await waitFor(() => expect(count('/api/assistant/model-health?window=24h')).toBe(1));
  expect(count('/api/assistant/provider/models')).toBe(1);
  // The Keys tab's key-status rows read the same health URL once on their
  // first mount; a later tab-only revisit must add no request at all.
  await tab('Keys');
  await waitFor(() => expect(count('/api/assistant/model-health?window=24h')).toBe(2));
  await tab('Model order');
  await screen.findByLabelText('RPM limit for row 1');
  await tab('Keys');
  await tab('Model order');
  await screen.findByLabelText('RPM limit for row 1');
  expect(count('/api/assistant/model-health?window=24h')).toBe(2);
  expect(count('/api/assistant/provider/models')).toBe(1);
  expect(count('/api/assistant/providers')).toBe(1);
});

it('does not reissue the search-key GET on a tab-only revisit', async () => {
  window.history.replaceState(null, '', '/providers');
  const fetch = stub();
  renderWithSession(<ProvidersPage />);
  const count = () => fetch.mock.calls.filter((c) => c[0] === '/api/assistant/search-keys').length;
  await tab('Web search');
  await screen.findByLabelText('Label');
  expect(count()).toBe(1);
  await tab('GitHub');
  await tab('Web search');
  await screen.findByLabelText('Label');
  expect(count()).toBe(1);
});

it('links every visited trigger to a focusable panel, reciprocally labelled', async () => {
  window.history.replaceState(null, '', '/providers');
  stub();
  renderWithSession(<ProvidersPage />);
  for (const name of ['Model order', 'Keys', 'Web search', 'GitHub', 'Terms']) await tab(name);
  const triggers = screen.getAllByRole('tab');
  expect(triggers).toHaveLength(5);
  const panelOf = (id: string | null): HTMLElement => {
    if (id === null) throw new Error('trigger has no aria-controls');
    const panel = document.getElementById(id);
    if (panel === null) throw new Error(`no panel with id ${id}`);
    return panel;
  };
  let hiddenPanels = 0;
  for (const trigger of triggers) {
    const panel = panelOf(trigger.getAttribute('aria-controls'));
    const selected = trigger.getAttribute('aria-selected') === 'true';
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(trigger.id);
    // Focusable like the kit when active; out of keyboard order when inactive.
    expect(panel.getAttribute('tabindex')).toBe(selected ? '0' : '-1');
    expect(panel.hasAttribute('hidden')).toBe(!selected);
    if (panel.hasAttribute('hidden')) hiddenPanels += 1;
  }
  // Every visited-but-inactive panel stays mounted yet hidden (out of the
  // accessibility tree and keyboard order); exactly one is active.
  expect(hiddenPanels).toBe(4);
});

it('control: tab changes preserve unrelated query, hash and real Back', async () => {
  window.history.replaceState(null, '', '/providers?keep=one&keep=two#anchor');
  stub();
  renderWithSession(<ProvidersPage />);
  await tab('Keys');
  expect(window.location.search).toBe('?keep=one&keep=two&tab=keys');
  expect(window.location.hash).toBe('#anchor');
  await tab('GitHub');
  window.history.back();
  await waitFor(() => expect(window.location.search).toBe('?keep=one&keep=two&tab=keys'));
  expect(window.location.hash).toBe('#anchor');
});
