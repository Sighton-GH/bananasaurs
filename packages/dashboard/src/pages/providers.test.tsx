// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ProvidersPage } from './providers.js';

const TERMS_DETAIL = 'Record what training the terms allow.';
const COST_DETAIL = 'Confirm whether the model is free to use.';
const CONNECT_DETAIL = 'Add the provider key on the host to connect.';

const SAVED_STATUS = {
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  enabled: true,
  modelConfigured: true,
  keyConfigured: true,
  keyReadable: true,
  costClass: 'free',
  secretSource: 'file',
};

const assistantBody = (overrides: Record<string, unknown> = {}) => ({
  behaviours: [],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  aiStatus: SAVED_STATUS,
  setup: {
    answering: false,
    steps: [
      { id: 'connect', state: 'done', detail: 'Connected.' },
      { id: 'terms', state: 'todo', detail: TERMS_DETAIL },
      { id: 'cost', state: 'todo', detail: COST_DETAIL },
      { id: 'who', state: 'todo', detail: 'Choose who may use it.' },
      { id: 'skills', state: 'todo', detail: 'Choose what it can do.' },
      { id: 'on', state: 'todo', detail: 'Switch it on.' },
    ],
  },
  providerTerms: null,
  viewerIsOwner: true,
  ...overrides,
});

const WARNINGS = {
  warnings: [
    { provider: 'nim-free', reason: 'stale', trainsOnInput: 'no', reviewedAt: 0 },
    { provider: 'sketchy-ai', reason: 'not-no', trainsOnInput: 'unknown', reviewedAt: 0 },
  ],
};

const stubPage = (assistant: unknown, warnings: unknown = { warnings: [] }) =>
  stubFetch([
    { url: '/api/assistant', body: assistant },
    { url: '/api/providers/eligibility', body: warnings },
  ]);

const missingSecretAssistant = () =>
  assistantBody({
    aiStatus: {
      provider: 'gemini',
      enabled: false,
      modelConfigured: false,
      keyConfigured: false,
      keyReadable: false,
      costClass: 'unknown',
      secretSource: 'missing',
    },
    setup: {
      answering: false,
      steps: [
        { id: 'connect', state: 'blocked', detail: CONNECT_DETAIL },
        { id: 'terms', state: 'todo', detail: TERMS_DETAIL },
        { id: 'cost', state: 'todo', detail: COST_DETAIL },
        { id: 'who', state: 'todo', detail: 'Choose who may use it.' },
        { id: 'skills', state: 'todo', detail: 'Choose what it can do.' },
        { id: 'on', state: 'todo', detail: 'Switch it on.' },
      ],
    },
  });

const inputOf = (element: HTMLElement): HTMLInputElement => {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an <input>');
  return element;
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ProvidersPage', () => {
  it('lists the eligibility warnings with reasons and training flags', async () => {
    stubPage(assistantBody(), WARNINGS);
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('nim-free')).toBeTruthy();
    expect(screen.getByText(/terms review is old/)).toBeTruthy();
    expect(screen.getByText(/service has not confirmed/)).toBeTruthy();
    expect(screen.getByText('Not confirmed')).toBeTruthy();
  });

  it('prefills the form from the saved AI status', async () => {
    stubPage(assistantBody());
    renderWithSession(<ProvidersPage />);
    expect(inputOf(await screen.findByRole('radio', { name: /Google Gemini/ })).checked).toBe(true);
    expect(inputOf(screen.getByLabelText('Model')).value).toBe('gemini-2.5-flash');
    const key = inputOf(screen.getByLabelText('API key'));
    expect(key.value).toBe('');
    expect(key.getAttribute('placeholder')).toBe('Saved. Leave blank to keep it');
    expect(inputOf(screen.getByLabelText('Use this service for member questions')).checked).toBe(
      true,
    );
    expect(inputOf(screen.getByRole('radio', { name: "Yes, it's free" })).checked).toBe(true);
  });

  it('saves without resending an untouched key and keeps the model', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        method: 'PUT',
        url: '/api/assistant/provider',
        body: { ...SAVED_STATUS, modelConfigured: true, keyConfigured: true },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('radio', { name: /Google Gemini/ });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save AI setup' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/provider' && c[1]?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(bodyOf(put!)).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      enabled: true,
      costClass: 'free',
    });
    expect(screen.getByText('AI setup saved')).toBeTruthy();
    expect(inputOf(screen.getByLabelText('API key')).value).toBe('');
  });

  it('switching service clears the model and cost and changes the key placeholder', async () => {
    stubPage(assistantBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('radio', { name: /Google Gemini/ });
    expect(inputOf(screen.getByLabelText('API key')).getAttribute('placeholder')).toBe(
      'Saved. Leave blank to keep it',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'OpenRouter' }));
    expect(inputOf(screen.getByLabelText('Model')).value).toBe('');
    expect(inputOf(screen.getByRole('radio', { name: 'Not sure' })).checked).toBe(true);
    expect(inputOf(screen.getByLabelText('API key')).getAttribute('placeholder')).toBe(
      'Paste the API key for OpenRouter',
    );
    expect(
      screen.getByText('Switching service clears the saved key, model and cost answer.'),
    ).toBeTruthy();
  });

  it('lists other providers under Service terms to check', async () => {
    stubPage(assistantBody(), WARNINGS);
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Service terms to check')).toBeTruthy();
    expect(screen.queryByText('Other services')).toBeNull();
  });

  it('hides the terms form behind Update the terms record when a record exists', async () => {
    stubPage(
      assistantBody({
        providerTerms: {
          provider: 'gemini',
          trainsOnInput: 'no',
          evidenceUrl: 'https://example.test/ai-terms#training',
          evidenceClause: 'We do not use customer data to train our models.',
          productionUseAllowed: true,
          reviewedAt: 1000,
        },
      }),
    );
    renderWithSession(<ProvidersPage />);
    expect(
      await screen.findByText('We do not use customer data to train our models.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save terms record' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update the terms record' }));
    expect(screen.getByRole('button', { name: 'Save terms record' })).toBeTruthy();
  });

  it('hides the terms form again after a successful save', async () => {
    stubFetch([
      {
        url: '/api/assistant',
        body: assistantBody({
          providerTerms: {
            provider: 'gemini',
            trainsOnInput: 'no',
            evidenceUrl: 'https://example.test/ai-terms#training',
            evidenceClause: 'We do not use customer data to train our models.',
            productionUseAllowed: true,
            reviewedAt: 1000,
          },
        }),
      },
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
          reviewedAt: 2000,
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update the terms record' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save terms record' }));
    });
    expect(screen.getByText('Terms record saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save terms record' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update the terms record' })).toBeTruthy();
  });

  it('disables cost for a non-owner and omits it from the save', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: assistantBody({ viewerIsOwner: false }) },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { method: 'PUT', url: '/api/assistant/provider', body: SAVED_STATUS },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('radio', { name: /Google Gemini/ });
    expect(inputOf(screen.getByRole('radio', { name: "Yes, it's free" })).disabled).toBe(true);
    expect(screen.getByText('Only the server owner can change this.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save AI setup' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/provider' && c[1]?.method === 'PUT',
    );
    expect(bodyOf(put!)).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      enabled: true,
    });
  });

  it('disables the key input and shows the connect detail when no secret store exists', async () => {
    stubPage(missingSecretAssistant());
    renderWithSession(<ProvidersPage />);
    const key = inputOf(await screen.findByLabelText('API key'));
    expect(key.disabled).toBe(true);
    expect(key.getAttribute('placeholder')).toBeNull();
    const hintId = key.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(CONNECT_DETAIL);
  });

  it('disables saving and explains why when no secret store exists', async () => {
    const mock = stubPage(missingSecretAssistant());
    renderWithSession(<ProvidersPage />);
    const save = await screen.findByRole('button', { name: 'Save AI setup' });
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(true);
    expect(save.closest('div')?.textContent).toContain(CONNECT_DETAIL);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0);
  });

  it('warns when the saved key cannot be read on this host', async () => {
    stubPage(
      assistantBody({
        aiStatus: { ...SAVED_STATUS, keyConfigured: true, keyReadable: false },
      }),
    );
    renderWithSession(<ProvidersPage />);
    expect(
      await screen.findByText("The saved key can't be read on this host. Paste it again."),
    ).toBeTruthy();
  });

  it('has no test-connection button', async () => {
    stubPage(assistantBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('button', { name: 'Save AI setup' });
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull();
  });

  it('lets an owner record the terms with the four required fields', async () => {
    const mock = stubFetch([
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
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        method: 'PUT',
        url: '/api/providers/gemini/terms',
        status: 400,
        body: { error: 'invalid-terms', message: 'Quote too short.' },
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
    expect(
      screen.getByText(
        'Check the quote (at least 10 characters) and that the link starts with https://.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Terms record saved')).toBeNull();
  });

  it('shows a non-validation terms failure inline without the field hints', async () => {
    stubFetch([
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        method: 'PUT',
        url: '/api/providers/gemini/terms',
        status: 409,
        body: { error: 'terms-conflict', message: 'Record changed underneath.' },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('button', { name: 'Save terms record' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save terms record' }));
    });
    expect(screen.getByText('The terms record was not saved. Try again.')).toBeTruthy();
    expect(
      screen.queryByText(
        'Check the quote (at least 10 characters) and that the link starts with https://.',
      ),
    ).toBeNull();
    expect(screen.queryByText('Terms record saved')).toBeNull();
  });

  it('tells a non-owner that only the owner records the terms', async () => {
    stubPage(assistantBody({ viewerIsOwner: false }));
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Only the server owner can record the terms.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save terms record' })).toBeNull();
  });

  it('shows the first unfinished setup step until the assistant is answering', async () => {
    stubPage(assistantBody());
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Not answering yet')).toBeTruthy();
    expect(screen.getByText(TERMS_DETAIL)).toBeTruthy();
  });

  it('shows the answering state once setup is complete', async () => {
    stubPage(
      assistantBody({
        setup: {
          answering: true,
          steps: [
            { id: 'connect', state: 'done', detail: 'Connected.' },
            { id: 'terms', state: 'done', detail: 'Terms recorded.' },
            { id: 'cost', state: 'done', detail: 'Cost confirmed.' },
            { id: 'who', state: 'todo', detail: 'Choose who may use it.' },
            { id: 'skills', state: 'todo', detail: 'Choose what it can do.' },
            { id: 'on', state: 'todo', detail: 'Switch it on.' },
          ],
        },
      }),
    );
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Answering')).toBeTruthy();
    expect(screen.getByText('The assistant can answer members.')).toBeTruthy();
  });

  it('keeps a terms warning visible beside Answering and never treats it as unfinished', async () => {
    const warning = 'It may train on your data.';
    const body = (answering: boolean) =>
      assistantBody({
        setup: {
          answering,
          steps: [
            { id: 'connect', state: 'done', detail: 'Connected.' },
            { id: 'terms', state: 'warning', detail: warning },
            { id: 'cost', state: answering ? 'done' : 'todo', detail: 'Confirm the cost.' },
            { id: 'who', state: 'done', detail: 'Roles chosen.' },
            { id: 'skills', state: 'done', detail: 'Skills granted.' },
            { id: 'on', state: 'done', detail: 'On.' },
          ],
        },
      });
    stubPage(body(true));
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Answering')).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    cleanup();
    stubPage(body(false));
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Not answering yet')).toBeTruthy();
    expect(screen.getByText('Confirm the cost.')).toBeTruthy();
  });

  it('points at the Assistant page when only later steps remain', async () => {
    stubPage(
      assistantBody({
        setup: {
          answering: false,
          steps: [
            { id: 'connect', state: 'done', detail: 'Connected.' },
            { id: 'terms', state: 'done', detail: 'Terms recorded.' },
            { id: 'cost', state: 'done', detail: 'Cost confirmed.' },
            { id: 'who', state: 'todo', detail: 'Choose who may use it.' },
            { id: 'skills', state: 'todo', detail: 'Choose what it can do.' },
            { id: 'on', state: 'todo', detail: 'Switch it on.' },
          ],
        },
      }),
    );
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('Not answering yet')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Assistant page' });
    expect(link.getAttribute('href')).toBe('/assistant');
  });

  it('mark reviewed states that only the review date changes, posts and reloads', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: assistantBody() },
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

  it('claims nothing about training data when there are no warnings', async () => {
    stubPage(assistantBody());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('button', { name: 'Save AI setup' });
    expect(screen.queryByText(/will not use your server's data/)).toBeNull();
    expect(screen.queryByText('Other services')).toBeNull();
  });
});

describe('ProvidersPage: backup model and web search (ADR 0066)', () => {
  const putBody = (mock: ReturnType<typeof stubFetch>) =>
    bodyOf(
      mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/assistant/provider' && c[1]?.method === 'PUT',
      )!,
    ) as Record<string, unknown>;

  it('saves a backup model, and clears it with an empty field', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { method: 'PUT', url: '/api/assistant/provider', body: SAVED_STATUS },
    ]);
    renderWithSession(<ProvidersPage />);
    const field = await screen.findByLabelText('Backup model (optional)');
    fireEvent.change(field, { target: { value: ' gemini-2.5-flash-lite ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save AI setup' }));
    });
    expect(putBody(mock).fallbackModel).toBe('gemini-2.5-flash-lite');

    cleanup();
    const mock2 = stubFetch([
      {
        url: '/api/assistant',
        body: assistantBody({ aiStatus: { ...SAVED_STATUS, fallbackModel: 'old-lite' } }),
      },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { method: 'PUT', url: '/api/assistant/provider', body: SAVED_STATUS },
    ]);
    renderWithSession(<ProvidersPage />);
    const saved = await screen.findByLabelText('Backup model (optional)');
    expect(saved).toHaveProperty('value', 'old-lite');
    fireEvent.change(saved, { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save AI setup' }));
    });
    expect(putBody(mock2).fallbackModel).toBeNull();
  });

  it('lets the owner save a Brave key and turn web search on, keeping the key write-only', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: assistantBody() },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      {
        method: 'PUT',
        url: '/api/assistant/provider',
        body: { ...SAVED_STATUS, webSearch: { keyConfigured: true, enabled: true } },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    const card = (await screen.findByRole('heading', { name: 'Web search' })).closest('section')!;
    fireEvent.change(within(card).getByLabelText('Brave Search API key'), {
      target: { value: 'brave-raw-key' },
    });
    fireEvent.click(within(card).getByLabelText('Let the assistant search the web'));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Save web search' }));
    });
    expect(putBody(mock)).toEqual({
      provider: 'gemini',
      enabled: true,
      searchApiKey: 'brave-raw-key',
      searchEnabled: true,
    });
    const after = (await screen.findByRole('heading', { name: 'Web search' })).closest('section')!;
    expect(within(after).getByLabelText('Brave Search API key')).toHaveProperty('value', '');
    expect(within(after).getByText(/Powered by Brave Search/)).toBeTruthy();
  });

  it('shows web search read-only to a non-owner', async () => {
    stubPage(assistantBody({ viewerIsOwner: false }));
    renderWithSession(<ProvidersPage />);
    const card = (await screen.findByRole('heading', { name: 'Web search' })).closest('section')!;
    expect(within(card).getByText('Only the server owner can change web search.')).toBeTruthy();
    expect(within(card).getByLabelText('Let the assistant search the web')).toHaveProperty(
      'disabled',
      true,
    );
  });
});
