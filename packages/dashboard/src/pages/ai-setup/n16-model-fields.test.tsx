// @vitest-environment jsdom
// Structural and request contracts only. Native pixels/zoom/option menus are a separate gate.
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
import {
  ASSISTANT_PROVIDERS_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
} from '../../api/assistant.js';
import { bodyOf, renderWithSession, stubFetch } from '../../test-support.js';
import { ProvidersPage } from './index.js';

const LONG_KEY = 'Engineering club production account with a deliberately long readable key label';
const GEMINI_MODEL = 'gemini-2.5-flash';
const ROUTER_MODEL = 'openai/gpt-4.1-with-a-long-model-identifier';
const setup = {
  providers: [
    { provider: 'gemini', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
    { provider: 'openrouter', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
  ],
  keys: [
    {
      keyId: 'gemini_key',
      provider: 'gemini',
      label: LONG_KEY,
      costClass: 'free',
      enabled: true,
      readable: true,
    },
    {
      keyId: 'router_key',
      provider: 'openrouter',
      label: LONG_KEY,
      costClass: 'paid',
      enabled: true,
      readable: true,
    },
  ],
  chain: [
    {
      position: 0,
      keyId: 'gemini_key',
      keyLabel: LONG_KEY,
      provider: 'gemini',
      model: GEMINI_MODEL,
      rpmLimit: 12,
      rpdLimit: 123,
      status: 'ready',
    },
    {
      position: 1,
      keyId: 'router_key',
      keyLabel: LONG_KEY,
      provider: 'openrouter',
      model: ROUTER_MODEL,
      rpmLimit: null,
      rpdLimit: null,
      status: 'ready',
    },
  ],
  webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
  github: { tokenConfigured: false },
};

const stubPage = () =>
  stubFetch([
    { url: ASSISTANT_PROVIDERS_URL, body: setup },
    {
      url: '/api/assistant',
      body: {
        behaviours: [],
        resources: [],
        reminders: [],
        skills: [],
        activity: [],
        aiStatus: { provider: 'gemini', model: GEMINI_MODEL, enabled: true },
        providerTerms: null,
        viewerIsOwner: true,
      },
    },
    { url: '/api/providers/eligibility', body: { warnings: [] } },
    { url: '/api/assistant/search-keys', body: { enabled: false, source: 'brave', keys: [] } },
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    {
      method: 'POST',
      url: PROVIDER_MODELS_URL,
      body: {
        models: [
          { id: GEMINI_MODEL, name: 'Gemini 2.5 Flash' },
          { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
        ],
      },
    },
    { method: 'PUT', url: MODEL_CHAIN_URL, body: { ok: true, count: 2 } },
  ]);
const openTab = async (name: string) => {
  const tab = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => window.history.replaceState(null, '', '/providers'));

describe('N16 fitting model fields', () => {
  it('keeps both provider types and the three model/limit fields labeled in a wrapping row', async () => {
    const fetch = stubPage();
    renderWithSession(<ProvidersPage />);
    const gemini = await screen.findByRole('combobox', { name: 'Model for row 1' });
    expect(gemini.querySelector('[data-radix-select-value]')?.textContent).toContain('Gemini 2.5 Flash');
    const router = screen.getByRole('textbox', { name: 'Model for row 2' });
    expect((router as HTMLInputElement).value).toBe(ROUTER_MODEL);
    for (const row of [1, 2]) {
      const key = screen.getByRole('combobox', { name: `Key for row ${row}` });
      const fields = key.closest('label')?.parentElement;
      expect(fields?.classList.contains('flex-wrap')).toBe(true);
      for (const limit of ['RPM', 'RPD']) {
        const control = screen.getByRole('spinbutton', { name: `${limit} limit for row ${row}` });
        expect(fields?.contains(control)).toBe(true);
        expect(control.closest('label')?.textContent).toContain(limit);
        expect(control.closest('label')?.parentElement?.parentElement?.className).toContain(
          'max-w-full',
        );
        expect(control.closest('label')?.parentElement?.parentElement?.className).toContain(
          'shrink-0',
        );
      }
    }
    expect(fetch.mock.calls.filter((call) => call[0] === MODEL_CHAIN_URL)).toHaveLength(0);
  });

  it('preserves key/model/limit drafts across tabs, validates limits and saves exact identities', async () => {
    const fetch = stubPage();
    renderWithSession(<ProvidersPage />);
    const user = userEvent.setup();
    const gemini = await screen.findByRole('combobox', { name: 'Model for row 1' });
    await user.click(gemini);
    await user.click(await screen.findByRole('option', { name: /Gemini 2.5 Flash-Lite/ }));
    fireEvent.change(screen.getByLabelText('Model for row 2'), {
      target: { value: ` ${ROUTER_MODEL}-draft ` },
    });
    fireEvent.change(screen.getByLabelText('RPM limit for row 1'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('RPD limit for row 2'), { target: { value: '321' } });
    await openTab('Keys');
    await openTab('Model order');
    expect(screen.getByRole('combobox', { name: 'Key for row 1' })).toHaveTextContent(LONG_KEY);
    expect(screen.getByRole('combobox', { name: 'Key for row 2' })).toHaveTextContent(LONG_KEY);
    expect(screen.getByRole('combobox', { name: 'Model for row 1' })).toHaveTextContent(
      'Gemini 2.5 Flash-Lite',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Model for row 2').value).toBe(
      ` ${ROUTER_MODEL}-draft `,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Limits must be whole numbers of 1 or more. Leave a limit blank for no limit.',
    );
    expect(fetch.mock.calls.filter((call) => call[0] === MODEL_CHAIN_URL)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('RPM limit for row 1'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    await waitFor(() =>
      expect(fetch.mock.calls.filter((call) => call[0] === MODEL_CHAIN_URL)).toHaveLength(1),
    );
    const call = fetch.mock.calls.find((call) => call[0] === MODEL_CHAIN_URL);
    expect(call?.[1]?.method).toBe('PUT');
    expect(call?.[1]?.headers).toMatchObject({ 'x-bananasaurs-csrf': 'csrf-test' });
    expect(bodyOf(call ?? [])).toEqual({
      entries: [
        { keyId: 'gemini_key', model: 'gemini-2.5-flash-lite', rpmLimit: 15, rpdLimit: 123 },
        { keyId: 'router_key', model: `${ROUTER_MODEL}-draft`, rpmLimit: null, rpdLimit: 321 },
      ],
    });
  });
});
