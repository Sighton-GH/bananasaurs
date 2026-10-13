// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type PointerCaptureElement = Element & {
  hasPointerCapture?: (pointerId: number) => boolean;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
};

const DomElement = Element as typeof Element & { prototype: PointerCaptureElement };
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.setPointerCapture) DomElement.prototype.setPointerCapture = () => undefined;
if (!DomElement.prototype.releasePointerCapture) DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ThemeProvider } from '../../app/theme.js';
import { Shell } from '../../app/Shell.js';
import {
  ASSISTANT_KEYS_URL,
  ASSISTANT_PROVIDERS_URL,
  GITHUB_TOKEN_URL,
  MODEL_CHAIN_TEST_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
  PROVIDER_URL,
  assistantKeyUrl,
} from '../../api/assistant.js';
import { bodyOf, renderWithSession, stubFetch } from '../../test-support.js';
import { ProvidersPage } from './index.js';

const MODELS = {
  models: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
  ],
};

const setupBody = (overrides: Record<string, unknown> = {}) => ({
  providers: [
    { provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
    { provider: 'openrouter', eligibility: 'unverified', supportsTools: true, keyCount: 0 },
    { provider: 'nvidia-nim', eligibility: 'unverified', supportsTools: true, keyCount: 0 },
  ],
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
      model: 'gemini-2.5-flash',
      status: 'ready',
    },
  ],
  webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
  github: { tokenConfigured: false },
  ...overrides,
});

const assistantBody = (overrides: Record<string, unknown> = {}) => ({
  behaviours: [],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  aiStatus: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'free',
    secretSource: 'file',
  },
  setup: { answering: false, steps: [] },
  providerTerms: null,
  viewerIsOwner: true,
  ...overrides,
});

const SEARCH_KEYS_URL = '/api/assistant/search-keys';

const searchKeysBody = (overrides: Record<string, unknown> = {}) => ({
  enabled: false,
  source: 'brave',
  keys: [],
  ...overrides,
});

const stubPage = (setup: unknown, assistant: unknown = assistantBody()) =>
  stubFetch([
    { url: ASSISTANT_PROVIDERS_URL, body: setup },
    { url: '/api/assistant', body: assistant },
    { url: '/api/providers/eligibility', body: { warnings: [] } },
    { url: SEARCH_KEYS_URL, body: searchKeysBody() },
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
  ]);

const inputOf = (element: HTMLElement): HTMLInputElement => {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an <input>');
  return element;
};

const buttonOf = (element: HTMLElement): HTMLButtonElement => {
  if (!(element instanceof HTMLButtonElement)) throw new Error('expected a <button>');
  return element;
};

/** Radix tabs activate on mousedown, not click. */
const openTab = async (name: string) => {
  const tab = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
// Tab selection lives in the URL; reset it between tests.
afterEach(() => window.history.replaceState(null, '', '/providers'));

describe('ProvidersPage sections', () => {
  it('renders the five tabs in order, each opening its sections', async () => {
    stubPage(setupBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 1, name: 'AI setup' });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent ?? '');
    expect(tabs).toEqual(['Model order', 'Keys', 'Web search', 'GitHub', 'Terms']);
    // Selector change (P5 3b): the six stacked sections now live behind tabs.
    const wanted: Record<string, string[]> = {
      'Model order': ['Model order'],
      Keys: ['API keys', 'Providers'],
      'Web search': ['Web search'],
      GitHub: ['GitHub token (optional)'],
      Terms: ['Terms record'],
    };
    for (const [tab, headings] of Object.entries(wanted)) {
      await openTab(tab);
      for (const title of headings) {
        await screen.findByRole('heading', { level: 2, name: title });
      }
    }
  });

  it('keeps /providers working as an alias of the AI setup page', async () => {
    stubFetch([
      {
        url: '/api/health',
        body: {
          guildId: '1540816150026518620',
          guildName: 'Bananasaurs dev',
          gateway: { connected: true, pingMs: 42, guildCount: 1 },
          safety: { killswitch: false, dryRun: false, breakerOpen: false },
          jobCounts: {},
          oldestDueJobAtMs: undefined,
        },
      },
      { url: '/api/log-routes', body: { routes: [] } },
      { url: '/api/panels', body: [] },
      { url: '/api/audit?limit=50', body: [] },
      { url: '/api/automod/rules', body: { rules: [] } },
      {
        url: '/api/automod/review?limit=50',
        body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
      },
      { url: '/api/assistant/conversation-retention', body: { days: 182 } },
      {
        url: '/api/assistant/conversations?sort=last-activity&order=desc&limit=50',
        body: { conversations: [] },
      },
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    const { hook } = memoryLocation({ path: '/providers' });
    renderWithSession(
      <ThemeProvider>
        <Router hook={hook}>
          <Shell />
        </Router>
      </ThemeProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'AI setup' })).toBeTruthy();
  });
});

describe('ProvidersPage status summary', () => {
  it('marks everything to do on a fresh install', async () => {
    stubPage(setupBody({ keys: [], chain: [] }), assistantBody());
    renderWithSession(<ProvidersPage />);
    // Selector change (P5 3b): the setup checklist is now the status summary.
    await screen.findByRole('link', { name: 'Models: none ready' });
    await screen.findByRole('link', { name: 'Keys: 0 saved' });
    await screen.findByRole('link', { name: 'Terms: 0 to check' });
    // A fresh install lands on the keys tab: adding a key is the first step.
    await screen.findByRole('heading', { level: 2, name: 'API keys' });
  });

  it('marks each step done from the setup data and the assistant counts', async () => {
    stubPage(
      setupBody(),
      assistantBody({
        behaviours: [{ id: 'club' }],
        resources: [{ id: 'handbook' }],
        activity: [{ id: 'run-1' }],
      }),
    );
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('link', { name: 'Models: 1 ready' });
    await screen.findByRole('link', { name: 'Keys: 1 saved' });
    await screen.findByRole('link', { name: 'Web search: Off' });
    await screen.findByRole('link', { name: 'Terms: 0 to check' });
  });
});

describe('ProvidersPage provider cards', () => {
  it('shows a status pill, key counts and the may-train warning', async () => {
    stubPage(
      setupBody({
        providers: [
          { provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
          { provider: 'openrouter', eligibility: 'may-train', supportsTools: true, keyCount: 2 },
          { provider: 'nvidia-nim', eligibility: 'unverified', supportsTools: true, keyCount: 0 },
        ],
        keys: [
          {
            keyId: 'key_a',
            provider: 'gemini',
            label: 'Main key',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
          {
            keyId: 'key_b',
            provider: 'openrouter',
            label: 'Spare',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
          {
            keyId: 'key_c',
            provider: 'openrouter',
            label: 'Backup',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    const section = (await screen.findByRole('heading', { name: 'Providers' })).closest('section');
    if (!(section instanceof HTMLElement)) throw new Error('no Providers section');
    const inSection = within(section);
    expect(inSection.getByText('1 key')).toBeTruthy();
    expect(inSection.getByText('2 keys')).toBeTruthy();
    expect(inSection.getByText('0 keys')).toBeTruthy();
    expect(
      inSection.getByText(/may train on your data\. Member questions and server excerpts/),
    ).toBeTruthy();
  });
});

describe('ProvidersPage API keys', () => {
  it('explains shared allowances behind a help circle', async () => {
    stubPage(setupBody());
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    await screen.findByRole('heading', { name: 'API keys' });
    fireEvent.click(screen.getByRole('button', { name: 'Help: API key allowances' }));
    expect(
      screen.getByText(
        'Keys from the same provider account share that account’s allowance — add a key from a different account if you want a real backup.',
      ),
    ).toBeTruthy();
  });

  it('adds a key and sends only the fields', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'POST', url: ASSISTANT_KEYS_URL, body: { keyId: 'key_new' } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    const section = (await screen.findByRole('heading', { name: 'API keys' })).closest('section');
    if (!(section instanceof HTMLElement)) throw new Error('no API keys section');
    const inSection = within(section);
    const user = userEvent.setup();
    await user.click(inSection.getByRole('combobox', { name: 'Service' }));
    await user.click(await screen.findByRole('option', { name: 'Gemini' }));
    fireEvent.change(inputOf(inSection.getByLabelText('Label')), { target: { value: 'Spare' } });
    fireEvent.change(inputOf(inSection.getByLabelText('API key')), {
      target: { value: 'sk-spare-key' },
    });
    fireEvent.click(inSection.getByRole('radio', { name: 'Free' }));
    await act(async () => {
      fireEvent.click(inSection.getByRole('button', { name: 'Add key' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === ASSISTANT_KEYS_URL && c[1]?.method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({
      provider: 'gemini',
      label: 'Spare',
      apiKey: 'sk-spare-key',
      costClass: 'free',
    });
  });

  it('edits a key label without touching the key', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PATCH', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Main key' }));
    fireEvent.change(screen.getByDisplayValue('Main key'), { target: { value: 'Renamed' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    });
    const patch = mock.mock.calls.find(
      (c) => (c[0] as string) === assistantKeyUrl('key_a') && c[1]?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(bodyOf(patch!)).toEqual({ label: 'Renamed' });
  });

  it('disables and re-enables a key', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PATCH', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Main key' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable key' }));
    });
    const patch = mock.mock.calls.find(
      (c) => (c[0] as string) === assistantKeyUrl('key_a') && c[1]?.method === 'PATCH',
    );
    expect(bodyOf(patch!)).toEqual({ enabled: false });
  });

  it('a PATCH that hits reauth-required opens the re-auth dialog and retries like a PUT', async () => {
    let patchAttempts = 0;
    const calls: string[] = [];
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url === ASSISTANT_PROVIDERS_URL)
        return new Response(JSON.stringify(setupBody()), { status: 200 });
      if (method === 'GET' && url === '/api/assistant')
        return new Response(JSON.stringify(assistantBody()), { status: 200 });
      if (method === 'GET' && url === '/api/providers/eligibility')
        return new Response(JSON.stringify({ warnings: [] }), { status: 200 });
      if (method === 'GET' && url === SEARCH_KEYS_URL)
        return new Response(JSON.stringify(searchKeysBody()), { status: 200 });
      if (method === 'PATCH' && url === assistantKeyUrl('key_a')) {
        patchAttempts += 1;
        return patchAttempts === 1
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/reauth') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ error: 'unstubbed' }), { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Main key' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable key' }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    fireEvent.change(dialog.querySelector('input[type=password]')!, {
      target: { value: 'hunter22hunter22' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(patchAttempts).toBe(2);
    expect(calls).toContain('POST /api/reauth');
  });

  it('warns that deleting a key removes its model order rows, then deletes', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'DELETE', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Main key' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('also removes its rows from the model order');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete key' }));
    });
    const del = mock.mock.calls.find(
      (c) => (c[0] as string) === assistantKeyUrl('key_a') && c[1]?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
  });
});

describe('ProvidersPage model order', () => {
  const twoRows = () =>
    setupBody({
      keys: [
        {
          keyId: 'key_a',
          provider: 'gemini',
          label: 'Main key',
          costClass: 'free',
          enabled: true,
          readable: true,
        },
        {
          keyId: 'key_b',
          provider: 'openrouter',
          label: 'Spare key',
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
          model: 'gemini-2.5-flash',
          status: 'ready',
        },
        {
          position: 1,
          keyId: 'key_b',
          keyLabel: 'Spare key',
          provider: 'openrouter',
          model: 'some-open-model',
          status: 'ready',
        },
      ],
    });

  it('reorders rows and saves { entries: [{ keyId, model }] }', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: twoRows() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 2 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    fireEvent.click(screen.getByRole('button', { name: 'Move gemini-2.5-flash on Main key down' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(bodyOf(put!)).toEqual({
      entries: [
        { keyId: 'key_b', model: 'some-open-model', rpmLimit: null, rpdLimit: null },
        { keyId: 'key_a', model: 'gemini-2.5-flash', rpmLimit: null, rpdLimit: null },
      ],
    });
  });

  it('keeps each row pool and tier when the order is saved', async () => {
    const body = twoRows();
    const chain = (body as { chain: Record<string, unknown>[] }).chain;
    chain[0] = { ...chain[0], pool: 'provider', tier: 'light' };
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 2 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT',
    );
    expect(bodyOf(put!)).toEqual({
      entries: [
        {
          keyId: 'key_a',
          model: 'gemini-2.5-flash',
          rpmLimit: null,
          rpdLimit: null,
          pool: 'provider',
          tier: 'light',
        },
        { keyId: 'key_b', model: 'some-open-model', rpmLimit: null, rpdLimit: null },
      ],
    });
  });

  it('allows the same model on two keys', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: twoRows() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 2 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    fireEvent.change(inputOf(screen.getByLabelText('Model for row 2')), {
      target: { value: 'gemini-2.5-flash' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT',
    );
    expect(bodyOf(put!)).toEqual({
      entries: [
        { keyId: 'key_a', model: 'gemini-2.5-flash', rpmLimit: null, rpdLimit: null },
        { keyId: 'key_b', model: 'gemini-2.5-flash', rpmLimit: null, rpdLimit: null },
      ],
    });
    expect(screen.queryByText(/different model/)).toBeNull();
  });

  it('shows Ready for a usable row and Needs attention with the reason for a bad one', async () => {
    stubPage(
      setupBody({
        chain: [
          {
            position: 0,
            keyId: 'key_a',
            keyLabel: 'Main key',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            status: 'ready',
          },
          {
            position: 1,
            keyId: 'key_a',
            keyLabel: 'Main key',
            provider: 'gemini',
            model: 'old-model',
            status: 'ineligible',
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    const section = (await screen.findByRole('heading', { name: 'Model order' })).closest(
      'section',
    );
    if (!(section instanceof HTMLElement)) throw new Error('no Model order section');
    const inSection = within(section);
    expect(inSection.getByText('Ready')).toBeTruthy();
    expect(inSection.getByText('Needs attention')).toBeTruthy();
    expect(
      inSection.getByText("This service's terms do not allow answering member questions."),
    ).toBeTruthy();
  });

  it('shows the allowance reset line when the ledger spent the key', async () => {
    stubPage(
      setupBody({
        keys: [
          {
            keyId: 'key_a',
            provider: 'gemini',
            label: 'Main key',
            costClass: 'free',
            enabled: true,
            readable: true,
            allowanceResetsAt: 1_700_000_000_000,
          },
        ],
        chain: [
          {
            position: 0,
            keyId: 'key_a',
            keyLabel: 'Main key',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            status: 'allowance-used',
            allowanceResetsAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    const section = (await screen.findByRole('heading', { name: 'Model order' })).closest(
      'section',
    );
    if (!(section instanceof HTMLElement)) throw new Error('no Model order section');
    expect(within(section).getByText(/Free allowance used — resets /)).toBeTruthy();
  });

  it('tests one row and shows the reply', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'POST',
        url: MODEL_CHAIN_TEST_URL,
        body: { ok: true, latencyMs: 12, reply: 'ready' },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test gemini-2.5-flash on Main key' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === MODEL_CHAIN_TEST_URL && c[1]?.method === 'POST',
    );
    expect(bodyOf(post!)).toEqual({ position: 0 });
    expect(await screen.findByText(/answered “ready”/)).toBeTruthy();
  });

  it('offers the Gemini model list for Gemini keys and a typed field for others', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: twoRows() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'POST', url: PROVIDER_MODELS_URL, body: MODELS },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    expect(await screen.findByRole('combobox', { name: 'Model for row 1' })).toBeTruthy();
    expect(inputOf(screen.getByLabelText('Model for row 2')).value).toBe('some-open-model');
  });

  it('warns on an unlisted OpenRouter row and chips a listed one', async () => {
    stubPage(
      setupBody({
        keys: [
          {
            keyId: 'key_a',
            provider: 'openrouter',
            label: 'Spare key',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
          {
            keyId: 'key_b',
            provider: 'openrouter',
            label: 'Other key',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
        ],
        chain: [
          {
            position: 0,
            keyId: 'key_a',
            keyLabel: 'Spare key',
            provider: 'openrouter',
            model: 'gone-model',
            status: 'ready',
            listing: { listed: false, image: false, file: false, tools: false, reasoning: false },
          },
          {
            position: 1,
            keyId: 'key_b',
            keyLabel: 'Other key',
            provider: 'openrouter',
            model: 'live-model',
            status: 'ready',
            listing: { listed: true, image: true, file: false, tools: true, reasoning: false },
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    const section = (await screen.findByRole('heading', { name: 'Model order' })).closest(
      'section',
    );
    if (!(section instanceof HTMLElement)) throw new Error('no Model order section');
    const inSection = within(section);
    expect(inSection.getByText(/This model is no longer listed/)).toBeTruthy();
    expect(inSection.getByText('Reads images')).toBeTruthy();
  });
});

describe('ProvidersPage GitHub token', () => {
  it('states the unauthenticated limit, saves and clears the token', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: GITHUB_TOKEN_URL, body: { ok: true, tokenConfigured: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('GitHub');
    await screen.findByRole('heading', { name: 'GitHub token (optional)' });
    expect(
      screen.getByText(
        'Without a token GitHub allows 60 requests an hour, so organisations refresh once a day and only README files are read.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'To include private repositories, create a fine-grained token with Contents: Read-only access to the repositories you choose. Club members can then ask about those repositories, and their text is sent to your AI providers.',
      ),
    ).toBeTruthy();
    fireEvent.change(inputOf(screen.getByLabelText('GitHub token')), {
      target: { value: 'ghp_secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    });
    const puts = mock.mock.calls.filter(
      (c) => (c[0] as string) === GITHUB_TOKEN_URL && c[1]?.method === 'PUT',
    );
    expect(bodyOf(puts[0]!)).toEqual({ token: 'ghp_secret' });

    cleanup();
    const mock2 = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody({ github: { tokenConfigured: true } }) },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: GITHUB_TOKEN_URL, body: { ok: true, tokenConfigured: false } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('button', { name: 'Clear token' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear token' }));
    });
    const clear = mock2.mock.calls.find(
      (c) => (c[0] as string) === GITHUB_TOKEN_URL && c[1]?.method === 'PUT',
    );
    expect(bodyOf(clear!)).toEqual({ token: null });
  });
});

describe('ProvidersPage terms and web search', () => {
  it('lets an owner record the terms with the four required fields', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'PUT',
        url: '/api/providers/gemini/terms',
        body: {
          provider: 'gemini',
          trainsOnInput: 'no',
          evidenceUrl: 'https://example.test/ai-terms#training',
          evidenceClause: 'We do not use customer data to train our models.',
          productionUseAllowed: true,
          reviewedAt: 1000,
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Terms');
    await screen.findByRole('button', { name: 'Save terms record' });
    fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    fireEvent.change(screen.getByLabelText(/Quote the sentence/), {
      target: { value: 'We do not use customer data to train our models.' },
    });
    fireEvent.change(screen.getByLabelText(/Link to that part/), {
      target: { value: 'https://example.test/ai-terms#training' },
    });
    fireEvent.click(screen.getByLabelText('The terms allow use for answering member questions'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save terms record' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/providers/gemini/terms' && c[1]?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(bodyOf(put!)).toEqual({
      trainsOnInput: 'no',
      evidenceClause: 'We do not use customer data to train our models.',
      evidenceUrl: 'https://example.test/ai-terms#training',
      productionUseAllowed: true,
    });
    expect(screen.getByText('Terms record saved')).toBeTruthy();
  });

  it('shows a bad terms submission inline without saving', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'PUT',
        url: '/api/providers/gemini/terms',
        status: 400,
        body: {
          error: 'invalid-terms',
          title: 'Those terms are not valid',
          message: 'Quote too short.',
          hint: 'Quote at least 10 characters and link a page starting with https://.',
          fields: [{ path: 'evidenceClause', problem: 'too_small' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Terms');
    await screen.findByRole('button', { name: 'Save terms record' });
    fireEvent.change(screen.getByLabelText(/Quote the sentence/), {
      target: { value: 'Too short' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save terms record' }));
    });
    expect(await screen.findByText('Those terms are not valid')).toBeTruthy();
    expect(screen.getByText('Quote too short.')).toBeTruthy();
    expect(screen.getByText('Too small.')).toBeTruthy();
    expect(screen.queryByText('Terms record saved')).toBeNull();
  });

  it('renders a 400 terms refusal with the server title, hint, request id and field problem', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'PUT',
        url: '/api/providers/gemini/terms',
        status: 400,
        body: {
          error: 'bad-request',
          title: 'The request was not valid',
          message: 'One or more fields were missing or had the wrong format.',
          hint: 'Fix the highlighted fields and try again.',
          fields: [{ path: 'evidenceClause', problem: 'too_big' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Terms');
    await screen.findByRole('button', { name: 'Save terms record' });
    fireEvent.change(screen.getByLabelText(/Quote the sentence/), {
      target: { value: 'A very long quoted sentence that the server refuses.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save terms record' }));
    });
    expect(await screen.findByText('The request was not valid')).toBeTruthy();
    const notice = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes('The request was not valid'),
    )!;
    expect(notice.textContent).toContain('Fix the highlighted fields and try again.');
    expect(notice.textContent).toContain('req-0a1b2c3d');
    expect(notice.textContent).toContain('bad-request · HTTP 400 · request req-0a1b2c3d');
    expect(screen.getByText('Too large.')).toBeTruthy();
    // The code survives only inside the `code · HTTP n · request id` meta line.
    expect(screen.getAllByText(/bad-request/)).toHaveLength(1);
    expect(screen.queryByText('Terms record saved')).toBeNull();
  });

  const searchKeyUrl = (keyId: string) => `${SEARCH_KEYS_URL}/${encodeURIComponent(keyId)}`;
  const searchKeyMoveUrl = (keyId: string) => `${searchKeyUrl(keyId)}/move`;

  const ownerAssistantWithSearch = (overrides: Record<string, unknown> = {}) =>
    assistantBody({
      aiStatus: {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        enabled: true,
        modelConfigured: true,
        keyConfigured: true,
        keyReadable: true,
        costClass: 'free',
        secretSource: 'file',
        webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
      },
      ...overrides,
    });

  const webCard = async (): Promise<HTMLElement> => {
    const heading = await screen.findByRole('heading', { name: 'Web search' });
    const card = heading.closest('section');
    if (!(card instanceof HTMLElement)) throw new Error('no Web search section');
    return card;
  };

  it('shows both source options and the Tavily retention sentence', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    expect(within(card).getByRole('radio', { name: 'Brave Search' })).toBeTruthy();
    expect(within(card).getByRole('radio', { name: 'Tavily' })).toBeTruthy();
    expect(
      within(card).getByText(
        /Tavily may keep search queries and use them to improve its services, including training AI/,
      ),
    ).toBeTruthy();
    expect(
      within(card).getByText(
        /Several keys are for a spare or a paid key\. Using several free accounts to get more searches breaks Brave’s and Tavily’s terms/,
      ),
    ).toBeTruthy();
  });

  it('saving after choosing Tavily sends searchSource without searchApiKey', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: PROVIDER_URL, body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    fireEvent.click(within(card).getByRole('radio', { name: 'Tavily' }));
    fireEvent.click(within(card).getByLabelText('Let the assistant search the web'));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Save web search' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === PROVIDER_URL && c[1]?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    const body = bodyOf(put!) as Record<string, unknown>;
    expect(body).toEqual({
      provider: 'gemini',
      enabled: true,
      searchEnabled: true,
      searchSource: 'tavily',
    });
    expect('searchApiKey' in body).toBe(false);
  });

  it('saves Parallel, shows its training disclosure and restores source-specific defaults', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: PROVIDER_URL, body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    fireEvent.click(within(card).getByRole('radio', { name: 'Parallel' }));
    expect(within(card).getByLabelText<HTMLInputElement>('Monthly limit').value).toBe('4500');
    expect(
      within(card).getByText(/Parallel may use search queries to train its models\./),
    ).toBeTruthy();
    expect(card.textContent).toContain('Parallel may use search queries to train its models.');
    fireEvent.click(within(card).getByRole('radio', { name: 'Brave Search' }));
    expect(within(card).getByLabelText<HTMLInputElement>('Monthly limit').value).toBe('1000');
    fireEvent.click(within(card).getByRole('radio', { name: 'Parallel' }));
    fireEvent.click(within(card).getByRole('radio', { name: 'Tavily' }));
    expect(within(card).getByLabelText<HTMLInputElement>('Monthly limit').value).toBe('1000');
    fireEvent.change(within(card).getByLabelText('Monthly limit'), { target: { value: '2000' } });
    fireEvent.click(within(card).getByRole('radio', { name: 'Parallel' }));
    expect(within(card).getByLabelText<HTMLInputElement>('Monthly limit').value).toBe('2000');
    fireEvent.click(within(card).getByLabelText('Let the assistant search the web'));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Save web search' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === PROVIDER_URL && c[1]?.method === 'PUT',
    );
    expect(bodyOf(put!) as Record<string, unknown>).toEqual({
      provider: 'gemini',
      enabled: true,
      searchEnabled: true,
      searchSource: 'parallel',
    });
  });

  it('pre-fills 4500 when the saved source is Parallel', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      {
        url: '/api/assistant',
        body: ownerAssistantWithSearch({
          aiStatus: {
            provider: 'gemini',
            enabled: true,
            webSearch: { enabled: true, source: 'parallel' },
          },
        }),
      },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    expect(within(card).getByLabelText<HTMLInputElement>('Monthly limit').value).toBe('4500');
  });

  it('lists only the selected source keys with usage and paused state', async () => {
    const pausedAt = 1_700_000_000_000;
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        url: SEARCH_KEYS_URL,
        body: searchKeysBody({
          keys: [
            {
              keyId: 'search_brave_1',
              source: 'brave',
              label: 'Brave main',
              enabled: true,
              position: 0,
              monthlyLimit: 1000,
              dailyLimit: 20,
              readable: true,
              usage: { last24h: 3, last31d: 12, availableAt: pausedAt },
            },
            {
              keyId: 'search_tavily_1',
              source: 'tavily',
              label: 'Tavily main',
              enabled: true,
              position: 0,
              monthlyLimit: 1000,
              dailyLimit: null,
              readable: true,
              usage: { last24h: 1, last31d: 5 },
            },
          ],
        }),
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    expect(await within(card).findByText('Brave main')).toBeTruthy();
    expect(within(card).queryByText('Tavily main')).toBeNull();
    expect(within(card).getByText('12 / 1000 searches in the last 31 days')).toBeTruthy();
    expect(within(card).getByText('3 / 20 today')).toBeTruthy();
    expect(
      within(card).getByText(`Paused until ${new Date(pausedAt).toLocaleString()}`),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('radio', { name: 'Tavily' }));
    expect(await within(card).findByText('Tavily main')).toBeTruthy();
    expect(within(card).queryByText('Brave main')).toBeNull();
    expect(within(card).getByText('5 / 1000 searches in the last 31 days')).toBeTruthy();
  });

  it('adding a key posts source, label, key and monthly limit, then clears the key field', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      {
        url: '/api/assistant',
        body: ownerAssistantWithSearch({
          aiStatus: {
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            enabled: true,
            modelConfigured: true,
            keyConfigured: true,
            keyReadable: true,
            costClass: 'free',
            secretSource: 'file',
            webSearch: { keyConfigured: false, enabled: false, source: 'tavily' },
          },
        }),
      },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody({ source: 'tavily', keys: [] }) },
      { method: 'POST', url: SEARCH_KEYS_URL, body: { keyId: 'search_new' } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    expect(await within(card).findByText('No Tavily keys yet.')).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Label'), { target: { value: 'Spare' } });
    const keyInput = inputOf(within(card).getByLabelText('Key'));
    expect(keyInput.type).toBe('password');
    fireEvent.change(keyInput, { target: { value: 'tvly-secret' } });
    expect(inputOf(within(card).getByLabelText('Monthly limit')).value).toBe('1000');
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Add key' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === SEARCH_KEYS_URL && c[1]?.method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(bodyOf(post!)).toEqual({
      source: 'tavily',
      label: 'Spare',
      apiKey: 'tvly-secret',
      monthlyLimit: 1000,
    });
    // Saving reloads the page data, which replaces the card's DOM node, so
    // re-query it before asserting the write-only key field was cleared.
    const freshCard = await webCard();
    expect(inputOf(within(freshCard).getByLabelText('Key')).value).toBe('');
  });

  it('a blank monthly limit posts null and zero shows an inline error without posting', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'POST', url: SEARCH_KEYS_URL, body: { keyId: 'search_new' } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    await within(card).findByText('No Brave keys yet.');
    fireEvent.change(within(card).getByLabelText('Label'), { target: { value: 'Spare' } });
    fireEvent.change(within(card).getByLabelText('Key'), { target: { value: 'brave-secret' } });
    fireEvent.change(within(card).getByLabelText('Monthly limit'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Add key' }));
    });
    const posts = mock.mock.calls.filter(
      (c) => (c[0] as string) === SEARCH_KEYS_URL && c[1]?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({
      source: 'brave',
      label: 'Spare',
      apiKey: 'brave-secret',
      monthlyLimit: null,
    });

    cleanup();
    const mock2 = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'POST', url: SEARCH_KEYS_URL, body: { keyId: 'search_new' } },
    ]);
    renderWithSession(<ProvidersPage />);
    const card2 = await webCard();
    await within(card2).findByText('No Brave keys yet.');
    fireEvent.change(within(card2).getByLabelText('Label'), { target: { value: 'Spare' } });
    fireEvent.change(within(card2).getByLabelText('Key'), { target: { value: 'brave-secret' } });
    fireEvent.change(within(card2).getByLabelText('Monthly limit'), { target: { value: '0' } });
    await act(async () => {
      fireEvent.click(within(card2).getByRole('button', { name: 'Add key' }));
    });
    expect(
      await within(card2).findByText(
        'Limits must be whole numbers from 1 to 1,000,000. Leave a limit blank for no limit.',
      ),
    ).toBeTruthy();
    expect(
      mock2.mock.calls.filter(
        (c) => (c[0] as string) === SEARCH_KEYS_URL && c[1]?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('editing a key daily limit PATCHes only that field', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        url: SEARCH_KEYS_URL,
        body: searchKeysBody({
          keys: [
            {
              keyId: 'search_brave_1',
              source: 'brave',
              label: 'Brave main',
              enabled: true,
              position: 0,
              monthlyLimit: 1000,
              dailyLimit: 20,
              readable: true,
              usage: { last24h: 3, last31d: 12 },
            },
          ],
        }),
      },
      { method: 'PATCH', url: searchKeyUrl('search_brave_1'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    await within(card).findByText('Brave main');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit Brave main' }));
    const row = within(card).getByText('Brave main').closest('li')!;
    fireEvent.change(within(row).getByLabelText('Daily limit'), { target: { value: '25' } });
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Save key' }));
    });
    const patch = mock.mock.calls.find(
      (c) => (c[0] as string) === searchKeyUrl('search_brave_1') && c[1]?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(bodyOf(patch!)).toEqual({ dailyLimit: 25 });
  });

  it('move up posts the direction and the first row cannot move up', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        url: SEARCH_KEYS_URL,
        body: searchKeysBody({
          keys: [
            {
              keyId: 'search_brave_1',
              source: 'brave',
              label: 'First key',
              enabled: true,
              position: 0,
              monthlyLimit: 1000,
              dailyLimit: null,
              readable: true,
              usage: { last24h: 0, last31d: 1 },
            },
            {
              keyId: 'search_brave_2',
              source: 'brave',
              label: 'Second key',
              enabled: true,
              position: 1,
              monthlyLimit: 1000,
              dailyLimit: null,
              readable: true,
              usage: { last24h: 0, last31d: 2 },
            },
          ],
        }),
      },
      { method: 'POST', url: searchKeyMoveUrl('search_brave_2'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    await within(card).findByText('First key');
    expect(buttonOf(within(card).getByRole('button', { name: 'Move First key up' })).disabled).toBe(
      true,
    );
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Move Second key up' }));
    });
    const move = mock.mock.calls.find(
      (c) => (c[0] as string) === searchKeyMoveUrl('search_brave_2') && c[1]?.method === 'POST',
    );
    expect(move).toBeTruthy();
    expect(bodyOf(move!)).toEqual({ direction: 'up' });
  });

  it('remove asks for confirmation then deletes', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: ownerAssistantWithSearch() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        url: SEARCH_KEYS_URL,
        body: searchKeysBody({
          keys: [
            {
              keyId: 'search_brave_1',
              source: 'brave',
              label: 'Brave main',
              enabled: true,
              position: 0,
              monthlyLimit: 1000,
              dailyLimit: null,
              readable: true,
              usage: { last24h: 0, last31d: 0 },
            },
          ],
        }),
      },
      { method: 'DELETE', url: searchKeyUrl('search_brave_1'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    await within(card).findByText('Brave main');
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Brave main' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    });
    const del = mock.mock.calls.find(
      (c) => (c[0] as string) === searchKeyUrl('search_brave_1') && c[1]?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
  });

  it('a non-owner sees the card read-only and no key list request is made', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      {
        url: '/api/assistant',
        body: assistantBody({
          aiStatus: {
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            enabled: true,
            modelConfigured: true,
            keyConfigured: true,
            keyReadable: true,
            costClass: 'free',
            secretSource: 'file',
            webSearch: { keyConfigured: true, enabled: true, source: 'tavily' },
          },
          viewerIsOwner: false,
        }),
      },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
    ]);
    renderWithSession(<ProvidersPage />);
    await openTab('Web search');
    const card = await webCard();
    expect(within(card).getByText('Only the server owner can change web search.')).toBeTruthy();
    expect((within(card).getByRole('radio', { name: 'Tavily' }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByRole('radio', { name: 'Brave Search' }) as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    expect(
      mock.mock.calls.some((c) => (c[0] as string).includes('/api/assistant/search-keys')),
    ).toBe(false);
  });
});

describe('ProvidersPage row test refusal', () => {
  it('renders a refused test through the server answer', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'POST',
        url: MODEL_CHAIN_TEST_URL,
        status: 400,
        body: {
          error: 'bad-request',
          title: 'The test could not run',
          message: 'The test request was not valid.',
          hint: 'Check the row and try again.',
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test gemini-2.5-flash on Main key' }));
    });
    expect(await screen.findByText('The test could not run')).toBeTruthy();
    expect(screen.getByText('The test request was not valid.')).toBeTruthy();
  });
});

describe('Task 10 (h): AI setup Test renders a classified failure', () => {
  it('shows the failure title and hint', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'POST',
        url: MODEL_CHAIN_TEST_URL,
        body: {
          ok: false,
          latencyMs: 5,
          error: 'Could not connect to the AI provider',
          failure: {
            code: 'provider-connect-timeout',
            title: 'Could not connect to the AI provider',
            explanation: 'The connection timed out.',
            hint: 'Check the host VPN.',
            host: 'api.example.test',
            httpStatus: 504,
            netCode: 'ETIMEDOUT',
          },
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test gemini-2.5-flash on Main key' }));
    });
    expect(await screen.findByText('Could not connect to the AI provider')).toBeTruthy();
    expect(screen.getByText('The connection timed out.')).toBeTruthy();
    // Two role="alert" elements render here: this inline classified failure and an
    // unrelated danger toast (an unstubbed POST 404) in the toast region. The
    // assertions below are all about the inline notice, so select it explicitly.
    const alert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent?.includes('What to do: Check the host VPN.'));
    if (alert === undefined) throw new Error('classified failure inline alert not found');
    expect(alert.textContent).toContain('What to do: Check the host VPN.');
    expect(alert.textContent).toContain('api.example.test');
    expect(alert.textContent).toContain('HTTP 504');
    expect(alert.textContent).toContain('ETIMEDOUT');
  });
});

describe('per-entry RPM/RPD limits (ADR 0081)', () => {
  const limitedRow = (overrides: Record<string, unknown> = {}) => ({
    position: 0,
    keyId: 'key_a',
    keyLabel: 'Main key',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    status: 'ready',
    rpmLimit: 15,
    rpdLimit: null,
    usage: { lastMinute: 12, today: 180 },
    ...overrides,
  });

  it('shows the saved limits in the inputs and the usage line', async () => {
    stubPage(setupBody({ chain: [limitedRow()] }));
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    expect(inputOf(screen.getByLabelText('RPM limit for row 1')).value).toBe('15');
    const rpd = inputOf(screen.getByLabelText('RPD limit for row 1'));
    expect(rpd.value).toBe('');
    expect(rpd.getAttribute('placeholder')).toBe('no limit');
    expect(screen.getByText(/RPM 12 \/ 15 · today 180/)).toBeTruthy();
  });

  it('names when the entry frees up once it is at its limit', async () => {
    stubPage(
      setupBody({
        chain: [
          limitedRow({
            rpdLimit: 1000,
            usage: { lastMinute: 12, today: 180, availableAt: 1_700_000_000_000 },
          }),
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    expect(screen.getByText(/frees up/)).toBeTruthy();
  });

  it('sends the edited limits with the order', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody({ chain: [limitedRow()] }) },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 1 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    fireEvent.change(inputOf(screen.getByLabelText('RPD limit for row 1')), {
      target: { value: '20' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(bodyOf(put!)).toEqual({
      entries: [{ keyId: 'key_a', model: 'gemini-2.5-flash', rpmLimit: 15, rpdLimit: 20 }],
    });
  });

  it('shows a server field error under the RPM input', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      {
        method: 'PUT',
        url: MODEL_CHAIN_URL,
        status: 400,
        body: {
          error: 'bad-request',
          title: 'The request was not valid',
          message: 'One or more fields were missing or had the wrong format.',
          hint: 'Fix the highlighted fields and try again.',
          fields: [{ path: 'entries.0.rpmLimit', problem: 'too_small' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    const rpm = screen.getByLabelText('RPM limit for row 1');
    expect(rpm.getAttribute('aria-invalid')).toBe('true');
    expect(await screen.findByText('Too small.')).toBeTruthy();
  });

  it('refuses a zero limit before sending', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 1 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    fireEvent.change(inputOf(screen.getByLabelText('RPM limit for row 1')), {
      target: { value: '0' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    expect(
      await screen.findByText(
        'Limits must be whole numbers of 1 or more. Leave a limit blank for no limit.',
      ),
    ).toBeTruthy();
    expect(
      mock.mock.calls.filter((c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT'),
    ).toHaveLength(0);
  });

  // `abc` is not used here: the RPM input is type="number", so jsdom drops
  // non-numeric text to an empty value (which means "no limit" and would send).
  it.each(['1.5', '-3', '1e2'])('refuses a %s limit before sending', async (value) => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 1 } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    fireEvent.change(inputOf(screen.getByLabelText('RPM limit for row 1')), {
      target: { value },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    expect(
      await screen.findByText(
        'Limits must be whole numbers of 1 or more. Leave a limit blank for no limit.',
      ),
    ).toBeTruthy();
    expect(
      mock.mock.calls.filter((c) => (c[0] as string) === MODEL_CHAIN_URL && c[1]?.method === 'PUT'),
    ).toHaveLength(0);
  });
  it('mounts the Slice 6 components: paste box and Try the router', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    expect(screen.getByRole('button', { name: /try the router/i })).toBeTruthy();
    await openTab('Keys');
    expect(await screen.findByLabelText(/paste keys/i)).toBeTruthy();
  });
});

describe('ProvidersPage tabs and summary (P5 3b)', () => {
  const warningsBody = {
    warnings: [
      {
        provider: 'openrouter',
        reason: 'unverified',
        trainsOnInput: 'unknown',
        reviewedAt: 0,
      },
      {
        provider: 'gemini',
        reason: 'stale',
        trainsOnInput: 'no',
        reviewedAt: 1000,
      },
    ],
  };
  const stubTabbedPage = (setup: unknown, assistant: unknown = assistantBody()) =>
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setup },
      { url: '/api/assistant', body: assistant },
      { url: '/api/providers/eligibility', body: warningsBody },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);

  it('defaults to the model order tab when a key is saved', async () => {
    stubTabbedPage(setupBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 1, name: 'AI setup' });
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    expect(screen.queryByRole('heading', { level: 2, name: 'API keys' })).toBeNull();
  });

  it('defaults to the keys tab when no key is saved', async () => {
    stubTabbedPage(setupBody({ keys: [], chain: [] }));
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 2, name: 'API keys' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Model order' })).toBeNull();
  });

  it('opens the tab named in ?tab= and ignores an invalid value', async () => {
    stubTabbedPage(setupBody());
    window.history.replaceState(null, '', '/providers?tab=web-search');
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 2, name: 'Web search' });
    cleanup();
    vi.unstubAllGlobals();
    stubTabbedPage(setupBody());
    window.history.replaceState(null, '', '/providers?tab=bogus');
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    window.history.replaceState(null, '', '/providers');
  });

  it('switches tabs through the URL, keeps unrelated query params, and Back returns', async () => {
    stubTabbedPage(setupBody());
    window.history.replaceState(null, '', '/providers?from=overview');
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    await openTab('Keys');
    await screen.findByRole('heading', { level: 2, name: 'API keys' });
    expect(window.location.search).toContain('tab=keys');
    expect(window.location.search).toContain('from=overview');
    act(() => {
      window.history.back();
    });
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    expect(window.location.search).not.toContain('tab=keys');
    window.history.replaceState(null, '', '/providers');
  });

  it('shows summary badges computed from actual data, each linking to its tab', async () => {
    stubTabbedPage(setupBody());
    renderWithSession(<ProvidersPage />);
    const models = await screen.findByRole('link', { name: /Models: 1 ready/ });
    expect(models.getAttribute('href')).toContain('tab=model-order');
    const keys = screen.getByRole('link', { name: /Keys: 1 saved/ });
    expect(keys.getAttribute('href')).toContain('tab=keys');
    const web = screen.getByRole('link', { name: /Web search: Off/ });
    expect(web.getAttribute('href')).toContain('tab=web-search');
    const terms = screen.getByRole('link', { name: /Terms: 2 to check/ });
    expect(terms.getAttribute('href')).toContain('tab=terms');
  });

  it('says None ready when no chain row is ready', async () => {
    stubTabbedPage(
      setupBody({
        chain: [
          {
            position: 0,
            keyId: 'key_a',
            keyLabel: 'Main key',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            status: 'no-key',
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('link', { name: /Models: none ready/i });
  });

  it('never guesses web search or terms state when those resources fail', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', status: 500, body: { error: 'boom' } },
      { url: '/api/providers/eligibility', status: 500, body: { error: 'boom' } },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    expect(screen.queryByRole('link', { name: /Web search: Off/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Terms: 0 to check/ })).toBeNull();
  });

  it('keeps the may-train warning visible outside the tabs', async () => {
    stubFetch([
      {
        url: ASSISTANT_PROVIDERS_URL,
        body: setupBody({
          providers: [
            { provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
            { provider: 'openrouter', eligibility: 'may-train', supportsTools: true, keyCount: 2 },
            { provider: 'nvidia-nim', eligibility: 'unverified', supportsTools: true, keyCount: 0 },
          ],
        }),
      },
      { url: '/api/assistant', body: assistantBody() },
      {
        url: '/api/providers/eligibility',
        body: {
          warnings: [
            { provider: 'openrouter', reason: 'not-no', trainsOnInput: 'yes', reviewedAt: 1000 },
          ],
        },
      },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    renderWithSession(<ProvidersPage />);
    // Default tab is model order; the terms-to-check warning still shows.
    await screen.findByRole('heading', { level: 2, name: 'Model order' });
    await screen.findByText(/may train on your data/);
  });

  it('puts the terms record and the service terms to check in the Terms tab', async () => {
    stubFetch([
      {
        url: ASSISTANT_PROVIDERS_URL,
        body: setupBody({
          providers: [
            { provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
            { provider: 'openrouter', eligibility: 'may-train', supportsTools: true, keyCount: 2 },
            { provider: 'nvidia-nim', eligibility: 'unverified', supportsTools: true, keyCount: 0 },
          ],
        }),
      },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: warningsBody },
      { url: SEARCH_KEYS_URL, body: searchKeysBody() },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 1, name: 'AI setup' });
    await openTab('Terms');
    await screen.findByRole('heading', { name: 'Service terms to check' });
    await screen.findAllByRole('heading', { name: 'Terms record' });
    const reviewButtons = screen.getAllByRole('button', { name: 'I checked these terms today' });
    expect(reviewButtons.length).toBe(1);
  });
});
