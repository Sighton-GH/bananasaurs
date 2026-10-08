// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ASSISTANT_PROVIDERS_URL, ASSISTANT_URL, SEARCH_KEYS_URL } from '../api/assistant.js';
import { formatRate, formatUsd } from '../api/model-health.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantHistoryDetailPage } from './assistant-history-detail.js';
import { AssistantHistoryPage } from './assistant-history.js';
import { ProvidersPage } from './providers.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('formatUsd', () => {
  it('uses four decimals under $1, two at or above, and $0 for zero', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(3.456)).toBe('$3.46');
  });
});

describe('formatRate', () => {
  it('rounds to whole percent, or an em dash for null', () => {
    expect(formatRate(0.9666)).toBe('97%');
    expect(formatRate(null)).toBe('—');
  });
});

const HEALTH_URL = '/api/assistant/model-health?window=24h';

const setupBody = {
  providers: [
    { provider: 'openrouter', eligibility: 'eligible', supportsTools: true, keyCount: 1 },
  ],
  keys: [
    {
      keyId: 'key-1',
      provider: 'openrouter',
      label: 'Main key',
      costClass: 'paid',
      enabled: true,
      readable: true,
    },
  ],
  chain: [
    {
      position: 0,
      keyId: 'key-1',
      keyLabel: 'Main key',
      provider: 'openrouter',
      model: 'stealth/space-bunny-alpha',
      status: 'ready',
    },
  ],
  webSearch: { keyConfigured: false, enabled: false, source: 'brave' },
  github: { tokenConfigured: false },
};

const assistantBody = {
  behaviours: [],
  resources: [],
  reminders: [],
  skills: [],
  activity: [],
  aiStatus: {
    provider: 'openrouter',
    model: 'stealth/space-bunny-alpha',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'paid',
    secretSource: 'file',
  },
  setup: { answering: false, steps: [] },
  providerTerms: null,
  viewerIsOwner: true,
};

describe('ProvidersPage model health', () => {
  it('shows the matching row health and the persistent badge', async () => {
    stubFetch([
      { url: ASSISTANT_PROVIDERS_URL, body: setupBody },
      { url: ASSISTANT_URL, body: assistantBody },
      { url: '/api/providers/eligibility', body: { warnings: [] } },
      { url: SEARCH_KEYS_URL, body: { enabled: false, source: 'brave', keys: [] } },
      {
        url: HEALTH_URL,
        body: {
          window: '24h',
          models: [
            {
              model: 'stealth/space-bunny-alpha',
              keyId: 'key-1',
              calls: 30,
              ok: 29,
              successRate: 29 / 30,
              p50Ms: 120,
              p95Ms: 450,
              tokens: 100,
              costUsd: 0.0012,
              failuresByCode: { 'provider-bad-model': 1 },
              lastError: {
                at: Date.now() - 12 * 60_000,
                code: 'provider-bad-model',
                providerMessage: 'no such model',
              },
              lastOkAt: Date.now() - 60_000,
              persistent: { code: 'provider-bad-model', since: Date.now() - 30 * 60_000, count: 5 },
            },
          ],
        },
      },
    ]);
    renderWithSession(<ProvidersPage />);
    expect(await screen.findByText('97%', { exact: false })).toBeTruthy();
    expect(await screen.findByText('Persistent failure')).toBeTruthy();
    expect(await screen.findByText('$0.0012', { exact: false })).toBeTruthy();
  });
});

const DETAIL = {
  trace: {
    traceId: 'trace-1',
    at: 1_790_000_000_000,
    userId: '100000000000000001',
    channelId: '333333333333333333',
    behaviourId: 'club',
    command: 'ask',
    source: 'mention',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    question: 'When is the next club meeting?',
    answer: 'Thursday at 6 pm.',
    outcome: 'answered',
    durationMs: 1200,
    attempts: [
      {
        provider: 'openrouter',
        model: 'stealth/space-bunny-alpha',
        outcome: 'ok',
        ms: 900,
        costUsd: 0.0003,
      },
    ],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10, costUsd: 0.0012 },
    sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
    included: {
      toolsOffered: [],
      snippetChunkIds: [],
      quote: false,
      historyTurns: 0,
    },
    toolCalls: [],
    guard: { removed: [] },
    timeline: [{ label: 'posted', atMs: 1200 }],
    discordMessageIds: ['900000000000000002'],
    sources: [],
    flags: [],
  },
  member: { username: 'bryan', displayName: 'Bryan' },
};

describe('AssistantHistoryDetailPage cost', () => {
  it('shows the run cost and each attempt cost', async () => {
    stubFetch([{ url: '/api/assistant/traces/trace-1', body: DETAIL }]);
    const { hook } = memoryLocation({ path: '/assistant/history/trace-1' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/history/:traceId" component={AssistantHistoryDetailPage} />
      </Router>,
    );
    expect(await screen.findByText('$0.0012', { exact: false })).toBeTruthy();
    expect(await screen.findByText('$0.0003', { exact: false })).toBeTruthy();
  });
});

const HISTORY_ROW = {
  traceId: 'trace-new',
  at: 1_790_000_002_000,
  userId: '100000000000000001',
  channelId: '333333333333333333',
  behaviourId: 'club',
  outcome: 'answered',
  durationMs: 1200,
  model: 'gemini-2.5-flash',
  totalTokens: 130,
  member: { username: 'bryan', displayName: 'Bryan' },
};

const HISTORY_OLDER = { behaviours: [], skills: [], activity: [] };

const historyStubs = (overrides: {
  traces?: unknown;
  usageDays?: unknown[];
  healthModels?: unknown[] | undefined;
  healthStatus?: number;
}) => {
  const routes: { url: string; status?: number; body: unknown }[] = [
    { url: '/api/assistant/runs?active=1&limit=50', body: { runs: [] } },
    { url: '/api/assistant/usage?days=14', body: { days: overrides.usageDays ?? [] } },
    {
      url: HEALTH_URL,
      ...(overrides.healthStatus === undefined ? {} : { status: overrides.healthStatus }),
      body:
        overrides.healthStatus === undefined
          ? { window: '24h', models: overrides.healthModels ?? [] }
          : { error: 'boom' },
    },
    { url: '/api/assistant/traces?limit=50', body: overrides.traces ?? { traces: [] } },
    { url: '/api/assistant', body: HISTORY_OLDER },
  ];
  return stubFetch(routes);
};

const HEALTHY_HISTORY_MODEL = {
  model: 'stealth/space-bunny-alpha',
  keyId: 'key-1',
  calls: 30,
  ok: 29,
  successRate: 29 / 30,
  p50Ms: 120,
  p95Ms: 450,
  tokens: 100,
  costUsd: 0.0012,
  failuresByCode: { 'provider-bad-model': 1 },
  lastError: { at: Date.now() - 12 * 60_000, code: 'provider-bad-model' },
  lastOkAt: Date.now() - 60_000,
};

describe('AssistantHistoryPage model health', () => {
  it('shows one line per model with key, calls, rate, p95 and last error', async () => {
    historyStubs({
      traces: { traces: [HISTORY_ROW] },
      usageDays: [],
      healthModels: [HEALTHY_HISTORY_MODEL],
    });
    renderWithSession(<AssistantHistoryPage />);
    expect(await screen.findByText('Model health (24h)')).toBeTruthy();
    expect(await screen.findByText('stealth/space-bunny-alpha')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toContain('key-1');
    expect(body).toContain('30 calls');
    expect(body).toContain('97%');
    expect(body).toContain('p95 450 ms');
    expect(body).toContain('last error provider-bad-model');
  });

  it('shows the empty message when no model called in the last 24 hours', async () => {
    historyStubs({ traces: { traces: [HISTORY_ROW] }, usageDays: [], healthModels: [] });
    renderWithSession(<AssistantHistoryPage />);
    expect(await screen.findByText('Model health (24h)')).toBeTruthy();
    expect(await screen.findByText('No model calls in the last 24 hours.')).toBeTruthy();
  });

  it('still renders the trace list when the health request fails', async () => {
    historyStubs({
      traces: { traces: [HISTORY_ROW] },
      usageDays: [],
      healthModels: [],
      healthStatus: 500,
    });
    renderWithSession(<AssistantHistoryPage />);
    expect(await screen.findByText('gemini-2.5-flash')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Assistant history' })).toBeTruthy();
    expect(screen.queryByText('Model health (24h)')).toBeNull();
  });

  it('adds failure codes and per-model tokens to the day tooltip', async () => {
    historyStubs({
      traces: { traces: [HISTORY_ROW] },
      usageDays: [
        {
          day: '2026-09-20',
          answers: 3,
          failures: 1,
          fallbacks: 0,
          tokens: 400,
          failuresByCode: { 'provider-bad-model': 1 },
          tokensByModel: { 'stealth/space-bunny-alpha': 400 },
        },
      ],
      healthModels: [],
    });
    renderWithSession(<AssistantHistoryPage />);
    const bar = await screen.findByRole('img', {
      name: '2026-09-20: 3 answers, 1 failures',
    });
    const title = bar.getAttribute('title') ?? '';
    expect(title).toContain('Failures: provider-bad-model ×1');
    expect(title).toContain('Tokens: stealth/space-bunny-alpha 400');
  });

  it('renders pre-0129 usage days without the breakdown lines', async () => {
    historyStubs({
      traces: { traces: [HISTORY_ROW] },
      usageDays: [{ day: '2026-09-20', answers: 3, failures: 1, fallbacks: 1, tokens: 400 }],
      healthModels: [],
    });
    renderWithSession(<AssistantHistoryPage />);
    const bar = await screen.findByRole('img', {
      name: '2026-09-20: 3 answers, 1 failures',
    });
    const title = bar.getAttribute('title') ?? '';
    expect(title).toContain('2026-09-20: 3 answers, 1 failures');
    expect(title).not.toContain('Failures:');
    expect(title).not.toContain('Tokens:');
  });
});
