// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULK_KEYS_URL, MODEL_CHECK_URL, RECOMMENDED_CHAIN_URL } from '../api/assistant.js';
import { TUNING_URL, tuningKeyUrl } from '../api/tuning.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantChainPools } from './assistant-chain-pools.js';
import { AssistantKeyStatusRows } from './assistant-key-status-rows.js';
import { AssistantKeysPaste } from './assistant-keys-paste.js';
import { AssistantModelCheck } from './assistant-model-check.js';
import { AssistantRecommendedSetup } from './assistant-recommended-setup.js';
import { AssistantRoutingSettings } from './assistant-routing-settings.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setting = (key: string, label: string, value: unknown, display = 'count') => ({
  key,
  group: 'Assistant context',
  label,
  help: 'help',
  display,
  value,
  defaultValue: value,
  isDefault: true,
});
const TUNING = {
  settings: [
    setting('assistant.routerEnabled', 'Complexity routing on/off', 1),
    setting('assistant.routerMaxChars', 'Router: longest light message', 80),
    setting(
      'assistant.routerFullModelKeywords',
      'Router: full-model keywords',
      ['remind', 'plan'],
      'text',
    ),
    setting(
      'assistant.routerGreetingPatterns',
      'Router: greeting patterns',
      ['hi', 'hello'],
      'text',
    ),
    setting('assistant.routerLongThreadTurns', 'Router: long-thread turns', 4),
    setting('assistant.routerEscalateOnTool', 'Router: escalate on tool use', 1),
    setting('assistant.routerSummaryTier', 'Tier for conversation summaries', 'light', 'text'),
    setting('assistant.routerDailyDigestTier', 'Tier for the daily digest', 'light', 'text'),
  ],
};

describe('Slice 6 dashboard (ADR 0143/0144)', () => {
  it('paste box saves many keys, reports added versus duplicates, never echoes keys', async () => {
    const fetchMock = stubFetch([
      { method: 'POST', url: BULK_KEYS_URL, body: { added: 1, duplicates: 1 } },
    ]);
    renderWithSession(<AssistantKeysPaste />);
    fireEvent.change(screen.getByLabelText(/paste/i), {
      target: { value: 'AIza-test-one\nAIza-test-two' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save keys/i }));
    expect(await screen.findByText(/1 added, 1 already saved/i)).toBeDefined();
    expect(bodyOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      provider: 'gemini',
      keysText: 'AIza-test-one\nAIza-test-two',
    });
    expect(document.body.textContent).not.toContain('AIza-test');
  });

  it('routing settings render chip lists and Try the router', async () => {
    stubFetch([{ url: TUNING_URL, body: TUNING }]);
    renderWithSession(<AssistantRoutingSettings />);
    expect(screen.getByText(/full-model keywords/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /try the router/i })).toBeDefined();
    expect(await screen.findByText('remind')).toBeDefined();
  });

  it('chips save as a string array, never comma-separated text', async () => {
    const fetchMock = stubFetch([
      { url: TUNING_URL, body: TUNING },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.routerFullModelKeywords'),
        body: { setting: TUNING.settings[2] },
      },
    ]);
    renderWithSession(<AssistantRoutingSettings />);
    await screen.findByText('remind');
    fireEvent.change(screen.getByLabelText(/add full-model keyword/i), {
      target: { value: 'budget' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add keyword/i }));
    await vi.waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT');
      expect(put).toBeDefined();
      expect(bodyOf(put as unknown[])).toEqual({ value: ['remind', 'plan', 'budget'] });
    });
  });

  it('Try the router shows tier and reason locally', async () => {
    stubFetch([{ url: TUNING_URL, body: TUNING }]);
    renderWithSession(<AssistantRoutingSettings />);
    await screen.findByText('remind');
    fireEvent.change(screen.getByLabelText(/message to try/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /try the router/i }));
    expect(await screen.findByText(/light tier · greeting/i)).toBeDefined();
    fireEvent.change(screen.getByLabelText(/message to try/i), { target: { value: 'remind me' } });
    fireEvent.click(screen.getByRole('button', { name: /try the router/i }));
    expect(await screen.findByText(/standard tier · full-model-keyword/i)).toBeDefined();
  });

  it('check-models shows the expected-versus-first-action scorecard', async () => {
    stubFetch([
      {
        method: 'POST',
        url: MODEL_CHECK_URL,
        body: {
          ok: true,
          results: [
            {
              id: 'greeting-light',
              expectedFirstAction: 'answer-without-tools',
              firstAction: 'call-tool',
              matches: false,
            },
          ],
          budget: { reserved: 3, spent: 3 },
        },
      },
    ]);
    renderWithSession(<AssistantModelCheck position={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /check this entry/i }));
    expect(await screen.findByText('greeting-light')).toBeDefined();
    expect(screen.getByText(/answer-without-tools/)).toBeDefined();
    expect(screen.getByText(/call-tool/)).toBeDefined();
  });

  it('check-models shows the budget refusal in plain words', async () => {
    stubFetch([
      { method: 'POST', url: MODEL_CHECK_URL, body: { ok: false, error: 'budget-exhausted' } },
    ]);
    renderWithSession(<AssistantModelCheck position={1} />);
    fireEvent.click(screen.getByRole('button', { name: /check this entry/i }));
    expect(
      await screen.findByText(/out of test budget — try again after the reset/i),
    ).toBeDefined();
  });

  it('recommended setup posts and maps no-gemini-key to plain words', async () => {
    stubFetch([
      { method: 'POST', url: RECOMMENDED_CHAIN_URL, status: 400, body: { error: 'no-gemini-key' } },
    ]);
    renderWithSession(<AssistantRecommendedSetup />);
    fireEvent.click(screen.getByRole('button', { name: /use the recommended gemini setup/i }));
    expect(await screen.findByText(/add a gemini key first/i)).toBeDefined();
  });

  it('status rows show remaining today, cooling time and the may-train note', async () => {
    stubFetch([
      {
        url: '/api/assistant/model-health?window=24h',
        body: {
          window: '24h',
          models: [{ keyId: 'k1', model: 'gemini-3.8-flash', coolingUntil: 4102444800000 }],
        },
      },
    ]);
    renderWithSession(
      <AssistantKeyStatusRows
        keys={[
          {
            keyId: 'k1',
            provider: 'gemini',
            label: 'gemini 1',
            costClass: 'free',
            enabled: true,
            readable: true,
          },
        ]}
        chain={[
          {
            position: 0,
            keyId: 'k1',
            keyLabel: 'gemini 1',
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            status: 'ready',
            rpmLimit: 5,
            rpdLimit: 20,
            usage: { lastMinute: 0, today: 6 },
          },
        ]}
      />,
    );
    expect(screen.getByText(/14 left today/i)).toBeDefined();
    expect(screen.getByText(/may use what you send to improve its models/i)).toBeDefined();
    expect(await screen.findByText(/cooling until/i)).toBeDefined();
  });

  it('chain pools save pool and tier on the extended chain body', async () => {
    const fetchMock = stubFetch([
      { method: 'PUT', url: '/api/assistant/model-chain', body: { ok: true, count: 1 } },
    ]);
    renderWithSession(
      <AssistantChainPools
        chain={[
          {
            position: 0,
            keyId: 'k1',
            keyLabel: 'gemini 1',
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            status: 'ready',
            rpmLimit: 5,
            rpdLimit: 20,
          },
        ]}
        onChanged={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText(/pool for row 1/i), { target: { value: 'provider' } });
    fireEvent.change(screen.getByLabelText(/tier for row 1/i), { target: { value: 'light' } });
    fireEvent.click(screen.getByRole('button', { name: /save pools and tiers/i }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0] as unknown[])).toEqual({
      entries: [
        {
          keyId: 'k1',
          model: 'gemini-3.8-flash',
          rpmLimit: 5,
          rpdLimit: 20,
          pool: 'provider',
          tier: 'light',
        },
      ],
    });
  });
});
