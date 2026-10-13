// @vitest-environment jsdom
// R2 regression tests for finding N03: at 360px / 200% (180 CSS px) the
// /providers?tab=model-order rows overflowed the viewport - the Gemini model
// select forced a 10rem minimum width and OrderedList rows always laid out
// horizontally. These tests pin the opt-in stacked row structure, the
// constrained key/model cells, reorder identity through the page, and draft
// preservation. Pixel verification belongs to the native recheck, not JSDOM.
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
import { ASSISTANT_PROVIDERS_URL, PROVIDER_MODELS_URL } from '../../api/assistant.js';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { ProvidersPage } from './index.js';

const LONG_KEY_LABEL =
  'A very long key label that used to push the select well past the narrow viewport edge';
const LONG_MODEL = 'gemini-2.5-flash-with-an-extra-long-model-identifier-suffix';

const MODELS = {
  models: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
    { id: LONG_MODEL, name: 'Long Gemini model' },
  ],
};

const geminiSetup = (overrides: Record<string, unknown> = {}) => ({
  providers: [{ provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 }],
  keys: [
    {
      keyId: 'key_a',
      provider: 'gemini',
      label: LONG_KEY_LABEL,
      costClass: 'free',
      enabled: true,
      readable: true,
    },
  ],
  chain: [
    {
      position: 0,
      keyId: 'key_a',
      keyLabel: LONG_KEY_LABEL,
      provider: 'gemini',
      model: LONG_MODEL,
      status: 'ready',
    },
  ],
  webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
  github: { tokenConfigured: false },
  ...overrides,
});

const localSetup = () =>
  geminiSetup({
    providers: [
      { provider: 'openrouter', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
    ],
    keys: [
      {
        keyId: 'key_b',
        provider: 'openrouter',
        label: LONG_KEY_LABEL,
        costClass: 'paid',
        enabled: true,
        readable: true,
      },
    ],
    chain: [
      {
        position: 0,
        keyId: 'key_b',
        keyLabel: LONG_KEY_LABEL,
        provider: 'openrouter',
        model: 'some-local-model-with-a-long-name',
        status: 'ready',
      },
    ],
  });

const assistantBody = () => ({
  behaviours: [],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  aiStatus: { provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
  providerTerms: null,
  viewerIsOwner: true,
});

const stubPage = (setup: unknown) =>
  stubFetch([
    { url: ASSISTANT_PROVIDERS_URL, body: setup },
    { url: '/api/assistant', body: assistantBody() },
    { url: '/api/providers/eligibility', body: { warnings: [] } },
    { url: '/api/assistant/search-keys', body: { enabled: false, source: 'brave', keys: [] } },
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    { method: 'POST', url: PROVIDER_MODELS_URL, body: MODELS },
  ]);

/** Radix tabs activate on mousedown, not click. */
const openTab = async (name: string) => {
  const tab = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => window.history.replaceState(null, '', '/providers'));

describe('Model order narrow layout (R2 / N03)', () => {
  it('stacks the ordered rows opt-in: controls wrap, content spans full width', async () => {
    stubPage(geminiSetup());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    const list = screen.getByRole('list', { name: 'Model order' });
    const row = list.querySelector('li');
    expect(row?.className).toContain('flex-wrap');
    const content = screen.getByLabelText('Key for row 1').closest('li > div');
    expect(content?.className).toContain('w-full');
    expect(content?.className).toContain('min-w-0');
  });

  it('constrains long key labels and long Gemini model names instead of a 10rem minimum', async () => {
    stubPage(geminiSetup());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    const keySelect = screen.getByLabelText('Key for row 1');
    expect(keySelect.closest('label')?.className).toContain('max-w-full');
    const keyLabel = keySelect.closest('label');
    expect(keyLabel?.className).toContain('min-w-0');
    expect(keyLabel?.className).toContain('w-64');
    expect(keyLabel?.className).toContain('flex-none');
    expect(keySelect.className).toContain('w-full');
    const modelSelect = await screen.findByRole('combobox', { name: 'Model for row 1' });
    expect(modelSelect.className).toContain('w-full');
    const modelLabel = modelSelect.closest('label');
    expect(modelLabel?.className).toContain('basis-64');
    expect(modelLabel?.className).toContain('min-w-[min(16rem,100%)]');
    expect(modelLabel?.className).toContain('max-w-full');
    expect(modelLabel?.className).not.toContain('min-w-40');
    // The long saved model stays selectable even before it appears in the list.
    expect(modelSelect.textContent).toContain(LONG_MODEL);
  });

  it('keeps the typed model field for non-Gemini providers on a constrained row', async () => {
    stubPage(localSetup());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    const input = screen.getByLabelText('Model for row 1');
    expect(input.tagName).toBe('INPUT');
    expect((input as HTMLInputElement).value).toBe('some-local-model-with-a-long-name');
    const fieldRoot = input.closest('label')?.parentElement;
    const wrapper = fieldRoot?.parentElement;
    expect(wrapper?.className).toContain('basis-64');
    expect(wrapper?.className).toContain('min-w-[min(16rem,100%)]');
    expect(wrapper?.className).toContain('max-w-full');
    expect(wrapper?.className).toContain('flex-1');
  });

  it('keeps reorder identity and disabled edges inside the page', async () => {
    stubPage(
      geminiSetup({
        chain: [
          {
            position: 0,
            keyId: 'key_a',
            keyLabel: LONG_KEY_LABEL,
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            status: 'ready',
          },
          {
            position: 1,
            keyId: 'key_a',
            keyLabel: LONG_KEY_LABEL,
            provider: 'gemini',
            model: 'gemini-2.5-flash-lite',
            status: 'ready',
          },
        ],
      }),
    );
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    const up = screen.getByRole('button', { name: /Move gemini-2.5-flash on .* up/ });
    expect(up instanceof HTMLButtonElement && up.disabled).toBe(true);
    const down = screen.getByRole('button', { name: /Move gemini-2.5-flash-lite on .* down/ });
    expect(down instanceof HTMLButtonElement && down.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Move gemini-2.5-flash-lite on .* up/ }));
    const buttons = screen.getAllByRole('button', { name: /Move .* up/ });
    expect(buttons[0]?.getAttribute('aria-label')).toContain('gemini-2.5-flash-lite');
  });

  it('keeps the unsaved model-select draft across a tab switch', async () => {
    stubPage(geminiSetup());
    renderWithSession(<ProvidersPage />);
    await screen.findByRole('heading', { name: 'Model order' });
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: 'Model for row 1' });
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: /Gemini 2.5 Flash-Lite/ }));
    expect(select.querySelector('[data-radix-select-value]')?.textContent).toContain('Gemini 2.5 Flash-Lite');
    await openTab('Keys');
    await openTab('Model order');
    const back = await screen.findByRole('combobox', { name: 'Model for row 1' });
    expect(back.querySelector('[data-radix-select-value]')?.textContent).toContain('Gemini 2.5 Flash-Lite');
  });
});
