// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

type PointerCaptureElement = Element & {
  hasPointerCapture?: (pointerId: number) => boolean;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
};

const DomElement = Element as typeof Element & { prototype: PointerCaptureElement };
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.setPointerCapture)
  DomElement.prototype.setPointerCapture = () => undefined;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
import userEvent from '@testing-library/user-event';
import { DEFAULT_ROUTER_RULES, routeRun } from '@bananasaurs/core';
import type { SetupChainRow } from '../api/assistant.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULK_KEYS_URL, MODEL_CHECK_URL, RECOMMENDED_CHAIN_URL } from '../api/assistant.js';
import { TUNING_URL, tuningKeyUrl } from '../api/tuning.js';
import { SessionProvider } from '../app/session.js';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { AssistantChainPools } from './assistant-chain-pools.js';
import { AssistantKeyStatusRows, remainingToday } from './assistant-key-status-rows.js';
import { AssistantKeysPaste } from './assistant-keys-paste.js';
import { AssistantModelCheck } from './assistant-model-check.js';
import { AssistantRecommendedSetup } from './assistant-recommended-setup.js';
import { AssistantRoutingSettings, tryRoute } from './assistant-routing-settings.js';

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

  it('Try the router shows the attachment and quote reasons the server uses', async () => {
    stubFetch([{ url: TUNING_URL, body: TUNING }]);
    renderWithSession(<AssistantRoutingSettings />);
    await screen.findByText('remind');
    fireEvent.change(screen.getByLabelText(/message to try/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText(/is a reply or quote/i));
    fireEvent.click(screen.getByRole('button', { name: /try the router/i }));
    expect(await screen.findByText(/standard tier · has-quote/i)).toBeDefined();
    fireEvent.click(screen.getByLabelText(/has attachments/i));
    fireEvent.click(screen.getByRole('button', { name: /try the router/i }));
    expect(await screen.findByText(/standard tier · has-attachments/i)).toBeDefined();
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
    renderWithSession(
      <AssistantModelCheck position={0} model="gemini-3.6-flash" keyLabel="Main key" />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /check entry 1: gemini-3.6-flash on main key/i }),
    );
    expect(await screen.findByText('greeting-light')).toBeDefined();
    expect(screen.getByText(/answer-without-tools/)).toBeDefined();
    expect(screen.getByText(/call-tool/)).toBeDefined();
  });

  it('check-models shows the budget refusal in plain words', async () => {
    stubFetch([
      { method: 'POST', url: MODEL_CHECK_URL, body: { ok: false, error: 'budget-exhausted' } },
    ]);
    renderWithSession(
      <AssistantModelCheck position={1} model="gemini-3.6-flash" keyLabel="Main key" />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /check entry 2: gemini-3.6-flash on main key/i }),
    );
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
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /pool for row 1/i }));
    await user.click(await screen.findByRole('option', { name: 'Whole provider' }));
    await user.click(screen.getByRole('combobox', { name: /tier for row 1/i }));
    await user.click(await screen.findByRole('option', { name: 'Light' }));
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

  it('checks on a multi-entry chain are told apart by entry number and model', () => {
    stubFetch([]);
    renderWithSession(
      <>
        <AssistantModelCheck position={0} model="gemini-3.6-flash" keyLabel="Main key" />
        <AssistantModelCheck position={1} model="gemini-3.6-pro" keyLabel="Spare key" />
      </>,
    );
    expect(
      screen.getByRole('button', { name: 'Check entry 1: gemini-3.6-flash on Main key' }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Check entry 2: gemini-3.6-pro on Spare key' }),
    ).toBeDefined();
    expect(screen.getByText(/entry 2 \(gemini-3\.6-pro on spare key\)/i)).toBeDefined();
  });

  it('chain pools resync drafts when only pool or tier changes in the chain prop', async () => {
    const fetchMock = stubFetch([
      { method: 'PUT', url: '/api/assistant/model-chain', body: { ok: true, count: 1 } },
    ]);
    const base: SetupChainRow = {
      position: 0,
      keyId: 'k1',
      keyLabel: 'gemini 1',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      status: 'ready',
      rpmLimit: 5,
      rpdLimit: 20,
      pool: 'key',
      tier: 'standard',
    };
    const tree = (row: SetupChainRow) => (
      <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
        <AssistantChainPools chain={[row]} onChanged={() => undefined} />
      </SessionProvider>
    );
    const { rerender } = render(tree(base));
    expect(screen.getByRole('combobox', { name: /pool for row 1/i }).textContent).toContain(
      'One key',
    );
    rerender(tree({ ...base, pool: 'provider', tier: 'light' }));
    expect(screen.getByRole('combobox', { name: /pool for row 1/i }).textContent).toContain(
      'Whole provider',
    );
    expect(screen.getByRole('combobox', { name: /tier for row 1/i }).textContent).toContain(
      'Light',
    );
    fireEvent.click(screen.getByRole('button', { name: /save pools and tiers/i }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      entries: [{ pool: 'provider', tier: 'light' }],
    });
  });

  it('routing number fields keep intermediate digits and save once, on blur', async () => {
    const fetchMock = stubFetch([
      { url: TUNING_URL, body: TUNING },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.routerMaxChars'),
        body: { setting: TUNING.settings[1] },
      },
    ]);
    renderWithSession(<AssistantRoutingSettings />);
    await screen.findByText('remind');
    const field = screen.getByLabelText(/longest light message/i);
    fireEvent.change(field, { target: { value: '4' } });
    expect(field).toHaveProperty('value', '4');
    fireEvent.change(field, { target: { value: '80' } });
    expect(field).toHaveProperty('value', '80');
    const puts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts()).toHaveLength(0);
    fireEvent.change(field, { target: { value: '120' } });
    fireEvent.blur(field);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    expect(bodyOf(puts()[0] as unknown[])).toEqual({ value: 120 });
  });

  it('routing number fields save on Enter and revert an out-of-range value on blur', async () => {
    const fetchMock = stubFetch([
      { url: TUNING_URL, body: TUNING },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.routerMaxChars'),
        body: { setting: TUNING.settings[1] },
      },
    ]);
    renderWithSession(<AssistantRoutingSettings />);
    await screen.findByText('remind');
    const field = screen.getByLabelText(/longest light message/i);
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.blur(field);
    expect(field).toHaveProperty('value', '80');
    const puts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts()).toHaveLength(0);
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    expect(bodyOf(puts()[0] as unknown[])).toEqual({ value: 90 });
  });
});

const VALUES = {
  enabled: true,
  maxChars: 80,
  keywords: DEFAULT_ROUTER_RULES.fullModelKeywords,
  greetings: DEFAULT_ROUTER_RULES.greetingPatterns,
  longThread: 4,
  escalate: true,
  summaryTier: 'light' as const,
  digestTier: 'light' as const,
};

describe('tryRoute order and limits', () => {
  it('a greeting that is also a keyword stays a greeting', () => {
    const v = { ...VALUES, keywords: ['hi'], greetings: ['hi'] };
    expect(tryRoute('hi', v)).toEqual({ tier: 'light', reason: 'greeting' });
  });

  it('a greeting longer than maxChars is still a greeting (greeting before length)', () => {
    const v = { ...VALUES, maxChars: 10, greetings: ['good morning to you all'] };
    expect(tryRoute('good morning to you all', v).reason).toBe('greeting');
  });

  it('a long message with a keyword is long-message (length before keyword)', () => {
    expect(tryRoute(`remind ${'x'.repeat(80)}`, VALUES).reason).toBe('long-message');
  });

  it('a keyword wins over a long thread', () => {
    expect(tryRoute('remind me', VALUES, 9).reason).toBe('full-model-keyword');
  });

  it('exactly maxChars stays light, maxChars + 1 is long', () => {
    expect(tryRoute('x'.repeat(80), VALUES)).toEqual({
      tier: 'light',
      reason: 'short-and-simple',
    });
    expect(tryRoute('x'.repeat(81), VALUES)).toEqual({ tier: 'standard', reason: 'long-message' });
  });

  it('long thread is strictly more than longThread turns', () => {
    expect(tryRoute('ok', VALUES, 4).reason).toBe('short-and-simple');
    expect(tryRoute('ok', VALUES, 5).reason).toBe('long-thread');
  });
});

describe('tryRoute parity with the core router', () => {
  // The mirror has no attachment or quote input, so core's has-attachments and
  // has-quote reasons cannot be shown in the try-box; those inputs stay false here.
  const rules = DEFAULT_ROUTER_RULES;
  const cases: { name: string; text: string; turns: number; enabled: boolean }[] = [
    { name: 'greeting', text: 'Hello!', turns: 0, enabled: true },
    { name: 'emoji', text: '👍 🎉', turns: 0, enabled: true },
    { name: 'long', text: 'y'.repeat(81), turns: 0, enabled: true },
    { name: 'at limit', text: 'y'.repeat(80), turns: 0, enabled: true },
    { name: 'keyword', text: 'please remind me', turns: 0, enabled: true },
    { name: 'long thread', text: 'ok then', turns: 5, enabled: true },
    { name: 'thread at limit', text: 'ok then', turns: 4, enabled: true },
    { name: 'simple', text: 'ok then', turns: 0, enabled: true },
    { name: 'router off', text: 'hi', turns: 0, enabled: false },
  ];
  it.each(cases)('$name gives the same tier and reason as routeRun', (c) => {
    const core = routeRun(
      {
        text: c.text,
        hasAttachments: false,
        hasQuoteOrReply: false,
        earlierTurns: c.turns,
      },
      { ...rules, enabled: c.enabled },
    );
    expect(tryRoute(c.text, { ...VALUES, enabled: c.enabled }, c.turns)).toEqual(core);
  });
});

describe('remainingToday', () => {
  const row = (rpdLimit: number, today: number): SetupChainRow => ({
    position: 0,
    keyId: 'k1',
    keyLabel: 'gemini 1',
    provider: 'gemini',
    model: 'm',
    status: 'ready',
    rpmLimit: 5,
    rpdLimit,
    usage: { lastMinute: 0, today },
  });
  it("takes the tightest limit across a key's rows, in either order", () => {
    expect(remainingToday('k1', [row(20, 6), row(10, 0)])).toBe(10);
    expect(remainingToday('k1', [row(10, 0), row(20, 6)])).toBe(10);
  });
});
