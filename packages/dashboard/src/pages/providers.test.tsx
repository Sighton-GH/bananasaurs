// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ThemeProvider } from '../app/theme.js';
import { Shell } from '../app/Shell.js';
import {
  ASSISTANT_KEYS_URL,
  ASSISTANT_PROVIDERS_URL,
  GITHUB_TOKEN_URL,
  MODEL_CHAIN_TEST_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
  PROVIDER_URL,
  assistantKeyUrl,
} from '../api/assistant.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ProvidersPage } from './providers.js';

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

const stubPage = (setup: unknown, assistant: unknown = assistantBody()) =>
  stubFetch([
    { url: ASSISTANT_PROVIDERS_URL, body: setup },
    { url: '/api/assistant', body: assistant },
    { url: '/api/providers/eligibility', body: { warnings: [] } },
  ]);

const inputOf = (element: HTMLElement): HTMLInputElement => {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an <input>');
  return element;
};

const selectOf = (element: HTMLElement): HTMLSelectElement => {
  if (!(element instanceof HTMLSelectElement)) throw new Error('expected a <select>');
  return element;
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ProvidersPage sections', () => {
  it('renders the six sections in order', async () => {
    stubPage(setupBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { level: 1, name: 'AI setup' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
    const wanted = [
      'Setup checklist',
      'Model order',
      'API keys',
      'Providers',
      'Web search',
      'GitHub token (optional)',
    ];
    let from = -1;
    for (const title of wanted) {
      const at = headings.indexOf(title, from + 1);
      expect(at).toBeGreaterThan(from);
      from = at;
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

describe('ProvidersPage setup checklist', () => {
  const item = (name: string): HTMLElement => {
    const row = screen.getByText(name).closest('li');
    if (!(row instanceof HTMLElement)) throw new Error(`no checklist row for ${name}`);
    return row;
  };

  it('marks everything to do on a fresh install', async () => {
    stubPage(setupBody({ keys: [], chain: [] }), assistantBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Setup checklist' });
    for (const name of [
      'Add a provider key',
      'Record the terms',
      'Set the model order',
      'Build the behaviour prompt',
      'Add resources',
      'Answer a test question',
    ]) {
      expect(item(name).textContent).toContain('To do');
    }
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
    await screen.findByRole('heading', { name: 'Setup checklist' });
    for (const name of [
      'Add a provider key',
      'Record the terms',
      'Set the model order',
      'Build the behaviour prompt',
      'Add resources',
      'Answer a test question',
    ]) {
      expect(item(name).textContent).toContain('Done');
    }
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
      { method: 'POST', url: ASSISTANT_KEYS_URL, body: { keyId: 'key_new' } },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'API keys' });
    fireEvent.change(selectOf(screen.getByLabelText('Service')), { target: { value: 'gemini' } });
    fireEvent.change(inputOf(screen.getByLabelText('Label')), { target: { value: 'Spare' } });
    fireEvent.change(inputOf(screen.getByLabelText('API key')), {
      target: { value: 'sk-spare-key' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Free' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
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
      { method: 'PATCH', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
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
      { method: 'PATCH', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
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
      { method: 'DELETE', url: assistantKeyUrl('key_a'), body: { ok: true } },
    ]);
    renderWithSession(<ProvidersPage />);
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

  it('allows the same model on two keys', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: twoRows() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
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
      { method: 'POST', url: PROVIDER_MODELS_URL, body: MODELS },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    expect(await screen.findByRole('combobox', { name: 'Model for row 1' })).toBeTruthy();
    expect(inputOf(screen.getByLabelText('Model for row 2')).value).toBe('some-open-model');
  });
});

describe('ProvidersPage GitHub token', () => {
  it('states the unauthenticated limit, saves and clears the token', async () => {
    const mock = stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { method: 'PUT', url: GITHUB_TOKEN_URL, body: { ok: true, tokenConfigured: true } },
    ]);
    renderWithSession(<ProvidersPage />);
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

  const SEARCH_KEYS_URL = '/api/assistant/search-keys';
  const searchKeyUrl = (keyId: string) => `${SEARCH_KEYS_URL}/${encodeURIComponent(keyId)}`;
  const searchKeyMoveUrl = (keyId: string) => `${searchKeyUrl(keyId)}/move`;

  const searchKeysBody = (overrides: Record<string, unknown> = {}) => ({
    enabled: false,
    source: 'brave',
    keys: [],
    ...overrides,
  });

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
    const card = await webCard();
    expect(await within(card).findByText('No Tavily keys yet.')).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Label'), { target: { value: 'Spare' } });
    const keyInput = within(card).getByLabelText('Key') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    fireEvent.change(keyInput, { target: { value: 'tvly-secret' } });
    expect((within(card).getByLabelText('Monthly limit') as HTMLInputElement).value).toBe('1000');
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
    expect((within(card).getByLabelText('Key') as HTMLInputElement).value).toBe('');
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
    const card = await webCard();
    await within(card).findByText('First key');
    expect(
      (within(card).getByRole('button', { name: 'Move First key up' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
    ]);
    renderWithSession(<ProvidersPage />);
    const card = await webCard();
    expect(
      within(card).getByText('Only the server owner can change web search.'),
    ).toBeTruthy();
    expect(
      (within(card).getByRole('radio', { name: 'Tavily' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(card).getByRole('radio', { name: 'Brave Search' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(mock.mock.calls.some((c) => String(c[0]).includes('/api/assistant/search-keys'))).toBe(
      false,
    );
  });
});

describe('ProvidersPage row test refusal', () => {
  it('renders a refused test through the server answer', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody() },
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
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
    const alert = screen.getByRole('alert');
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
});
