import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseConfig,
  parseGuildId,
  ProviderError,
  type ChannelAccess,
  type GenerateTextRequest,
  type GenerateTextResponse,
  type RunEvent,
  type TextProvider,
} from '@bananasaurs/core';
import {
  archiveRepo,
  assistantKeyCooldownsRepo,
  assistantProvidersRepo,
  assistantRepo,
  computeDocId,
  conversationRepo,
  eligibilityRepo,
  guildRepo,
  instanceSettingsRepo,
  jobRepo,
  modelCallsRepo,
  resourceCacheRepo,
  runRepo,
  traceRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { resolveModelChain, ENV_KEY_ID, type ChainEntry } from './model-chain.js';
import { ChainFailedError } from './chain-failed-error.js';
import { LocalLimitError } from './local-limit.js';
import { QuotaLedger } from './quota-ledger.js';
import { createAssistantService } from './service.js';
import { sanitizeMentionsForProvider } from './mentions.js';
import type { AssistantServiceTestPorts } from './service.js';
import type { AssistantTraceDetail } from './commands.js';

describe('sanitizeMentionsForProvider', () => {
  it('flattens role, user and channel mentions to readable tokens', () => {
    expect(
      sanitizeMentionsForProvider(
        'what did <@456789012345678901> say in <#345678901234567890> about <@&567890123456789012>?',
      ),
    ).toBe('what did @user say in #channel about @role?');
  });

  it('leaves ordinary prose and short numbers untouched', () => {
    expect(sanitizeMentionsForProvider('meet at 7, bring 12345 cones')).toBe(
      'meet at 7, bring 12345 cones',
    );
  });
});

/**
 * Task 6b fix round 2 (carried from Task 6's review): entries from
 * `resolveModelChain` use `ChainEntry.mayTrain` for the training warning; the
 * independent eligibility check stays only for the `testPorts.provider` path.
 */
describe('Task 6b fix round 2: ChainEntry.mayTrain training warning', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  it('a chain entry with mayTrain: true warns without a second eligibility read', async () => {
    const instance = t.scopes.instance();
    eligibilityRepo.recordEligibilityClaim(instance, {
      provider: 'gemini',
      trainsOnInput: 'yes',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'May train on input.',
      productionUseAllowed: true,
      now: NOW,
    });
    const keyId = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'Gemini',
      apiKeyEnc: 'sealed',
      now: NOW,
    });
    assistantProvidersRepo.setModelChain(instance, [{ keyId, model: 'm' }], NOW);

    const generateText = vi.fn(async () => ({ text: 'ok', model: 'm' }));
    const fakeProvider: TextProvider = {
      id: 'gemini',
      capabilities: new Set(['text']),
      generateText,
    };
    const eligibility = vi.fn((_provider: 'gemini' | 'openrouter' | 'nvidia-nim') => ({
      provider: 'gemini',
      trainsOnInput: 'yes' as const,
      evidenceUrl: 'https://example.com/terms',
      productionUseAllowed: true,
      reviewedAt: NOW,
    }));
    const entries = resolveModelChain({
      instance,
      config,
      openKey: () => 'raw-test-key',
      eligibility,
      makeProvider: () => fakeProvider,
    });
    expect(entries).toMatchObject([{ mayTrain: true, skip: undefined }]);
    const eligibilityCallsAfterChain = eligibility.mock.calls.length;
    expect(eligibilityCallsAfterChain).toBeGreaterThan(0);

    const warn = vi.fn();
    const findEligibilitySpy = vi.spyOn(eligibilityRepo, 'findEligibility');
    try {
      const service = createAssistantService(
        t.scopes.forGuild(GUILD),
        instance,
        config,
        () => NOW,
        {},
        undefined,
        { warn, info: vi.fn() },
        undefined,
        () => entries,
      );
      const result = await service.invoke({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MEMBER,
        callerRoleIds: [CLUB_ROLE],
        behaviour: direct,
        command: 'ask',
        input: { question: 'when is the meeting?' },
        source: 'slash-command',
        invocationId: 'int-maytrain-chain',
      });
      expect(result.ok).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: GUILD, reason: 'provider-may-train' }),
        'assistant provider may train on server content',
      );
      // The chain entry already carried the warning flag: no second
      // eligibility read, neither through the injected function nor the repo.
      expect(eligibility.mock.calls.length).toBe(eligibilityCallsAfterChain);
      expect(findEligibilitySpy).not.toHaveBeenCalled();
    } finally {
      findEligibilitySpy.mockRestore();
    }
  });

  it('the testPorts.provider path still checks eligibility itself and refuses an ineligible provider', async () => {
    const instance = t.scopes.instance();
    eligibilityRepo.recordEligibilityClaim(instance, {
      provider: 'fixture',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'Not for production.',
      productionUseAllowed: false,
      now: NOW,
    });
    const network = vi.fn(async () => ({ text: 'must not run', model: 'fixture-model' }));
    const warn = vi.fn();
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      instance,
      config,
      () => NOW,
      {
        provider: { id: 'fixture', capabilities: new Set(['text']), generateText: network },
      },
      undefined,
      { warn, info: vi.fn() },
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'ordinary question' },
      source: 'slash-command',
      invocationId: 'int-ineligible-test-provider',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.content).toContain('terms');
    expect(network).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Task 12: the service runs the whole chain through the tool loop and maps
 * a failed loop back to today's member-facing texts.
 */
describe('Task 12: service maps a failed tool loop to today\u2019s texts', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  const ask = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    callerRoleIds: [CLUB_ROLE],
    behaviour: direct,
    command: 'ask' as const,
    input: { question: 'when is the meeting?' },
    source: 'slash-command' as const,
    invocationId: 'int-loop-map',
  };

  const fakeProvider = (
    responses: (GenerateTextResponse | Error)[],
    capabilities: readonly ('text' | 'tools')[] = ['text', 'tools'],
  ): { provider: TextProvider; calls: () => number } => {
    const queue = [...responses];
    let n = 0;
    return {
      provider: {
        id: 'fake',
        capabilities: new Set(capabilities),
        generateText: async () => {
          n += 1;
          const next = queue.shift();
          if (next === undefined) throw new Error('no scripted response');
          if (next instanceof Error) throw next;
          return next;
        },
      },
      calls: () => n,
    };
  };

  const usable = (provider: TextProvider, over: Partial<ChainEntry> = {}): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
    ...over,
  });

  const skipped = (skip: ChainEntry['skip'], model = 'model-a'): ChainEntry => ({
    providerId: 'gemini',
    model,
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider: undefined,
    skip,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const serviceWith = (
    chain: () => readonly ChainEntry[],
  ): ReturnType<typeof createAssistantService> =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      chain,
    );

  it('every entry busy throws retryable so the job retries into BUSY_REPLY', async () => {
    const { provider, calls } = fakeProvider([new ProviderError('rate-limit', 'HTTP 429', true)]);
    const service = serviceWith(() => [usable(provider)]);
    const thrown = await service.invoke(ask).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ChainFailedError);
    const chain = thrown as ChainFailedError;
    expect(chain).toMatchObject({ kind: 'rate-limit', retryable: true });
    expect(chain.attempts).toHaveLength(1);
    expect(chain.detail?.sections.length).toBeGreaterThan(0);
    expect(calls()).toBe(1);
  });

  it('a 404 bad model throws a ChainFailedError carrying attempts and detail', async () => {
    const { provider } = fakeProvider([
      new ProviderError('invalid-request', 'No endpoints found for bad-model', false, {
        status: 404,
      }),
    ]);
    const service = serviceWith(() => [usable(provider, { model: 'bad-model' })]);
    const thrown = await service.invoke(ask).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ChainFailedError);
    const chain = thrown as ChainFailedError;
    expect(chain.attempts).toHaveLength(1);
    expect(chain.attempts[0]).toMatchObject({ model: 'bad-model', outcome: 'error' });
    expect(chain.detail?.sections.length).toBeGreaterThan(0);
  });

  it('a non-daily quota error keeps its kind instead of becoming invalid-request', async () => {
    const { provider, calls } = fakeProvider([
      new ProviderError('quota', 'credit exhausted', false),
    ]);
    const service = serviceWith(() => [usable(provider)]);
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'quota',
      retryable: false,
    });
    expect(calls()).toBe(1);
  });

  it('every entry skipped for terms is the terms refusal with a denied row', async () => {
    const service = serviceWith(() => [skipped('ineligible'), skipped('unverified')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      content:
        "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
    });
    expect(assistantRepo.listSkillActivity(t.scopes.forGuild(GUILD), 10)[0]).toMatchObject({
      outcome: 'denied',
    });
  });

  it('every entry skipped for keys is the failed outcome', async () => {
    const service = serviceWith(() => [skipped('no-key'), skipped('disabled')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      content: 'The free AI provider is not configured, so no content was sent outside the server.',
    });
  });

  it('every entry skipped for terms is the refused outcome', async () => {
    const service = serviceWith(() => [skipped('ineligible'), skipped('unverified')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
  });

  it('a caller outside the role gate is the refused outcome', async () => {
    const { provider } = fakeProvider([{ text: 'must not run', model: 'm' }]);
    const service = serviceWith(() => [usable(provider)]);
    const result = await service.invoke({
      ...ask,
      callerRoleIds: [],
      invocationId: 'int-role-gate',
    });
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
  });

  it('a denied skill scope is the refused outcome', async () => {
    const { provider, calls } = fakeProvider([{ text: 'must not run', model: 'm' }]);
    const service = serviceWith(() => [usable(provider)]);
    const result = await service.invoke({
      ...ask,
      command: 'remind',
      input: { question: 'remind me later' },
      invocationId: 'int-skill-scope',
    });
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(calls()).toBe(0);
  });

  it('IT-routing without ticket config is the refused outcome', async () => {
    const { provider } = fakeProvider([{ text: 'ESCALATE: reset the lab password', model: 'm' }]);
    const service = serviceWith(() => [usable(provider)]);
    const result = await service.invoke({
      ...ask,
      behaviour: { ...direct, surface: 'it-services' as const },
      invocationId: 'int-it-routing',
    });
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
  });

  it('a guard failure answers the fixed text with the failed outcome', async () => {
    const toolShaped = '{"name":"search_sources","args":{"query":"x"}}';
    const shaped = fakeProvider([
      { text: toolShaped, model: 'm' },
      { text: toolShaped, model: 'm' },
    ]);
    const service = serviceWith(() => [usable(shaped.provider)]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      content: "I couldn't finish that answer — please try again.",
    });
    expect(shaped.calls()).toBe(2);
  });

  it('a daily cap throws daily-free with the reset so the job answers the reset reply', async () => {
    const resetAt = NOW + 3_600_000;
    const { provider } = fakeProvider([
      new ProviderError('quota', 'free-models-per-day limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      }),
    ]);
    const service = serviceWith(() => [usable(provider, { model: 'm:free' })]);
    const thrown = await service.invoke(ask).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ChainFailedError);
    const chain = thrown as ChainFailedError;
    expect(chain).toMatchObject({
      kind: 'quota',
      quotaScope: 'daily-free',
      resetAt,
      retryable: false,
    });
    expect(chain.attempts.length).toBeGreaterThanOrEqual(1);
    expect(chain.detail?.sections.length).toBeGreaterThan(0);
  });

  it('a spent allowance is skipped without a provider call on the next request', async () => {
    const resetAt = NOW + 3_600_000;
    const capped = fakeProvider([
      new ProviderError('quota', 'free-models-per-day limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      }),
    ]);
    const later = fakeProvider([{ text: 'must not run', model: 'm:free' }]);
    let secondRequest = false;
    const service = serviceWith(() => [
      usable((secondRequest ? later : capped).provider, { model: 'm:free' }),
    ]);
    await expect(service.invoke({ ...ask, invocationId: 'int-cap-1' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    secondRequest = true;
    await expect(service.invoke({ ...ask, invocationId: 'int-cap-2' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    expect(later.calls()).toBe(0);
  });

  it('a ledger passed as an option is shared: one service spending it skips the other', async () => {
    const resetAt = NOW + 3_600_000;
    const shared = new QuotaLedger();
    const entry = (provider: TextProvider): ChainEntry => usable(provider, { model: 'm:free' });
    const first = fakeProvider([
      new ProviderError('quota', 'free-models-per-day limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      }),
    ]);
    const second = fakeProvider([{ text: 'must not run', model: 'm:free' }]);
    const serviceA = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [entry(first.provider)],
      shared,
    );
    const serviceB = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [entry(second.provider)],
      shared,
    );
    await expect(serviceA.invoke({ ...ask, invocationId: 'int-shared-1' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    await expect(serviceB.invoke({ ...ask, invocationId: 'int-shared-2' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    expect(second.calls()).toBe(0);
    // ADR 0143: once the service passes the instance scope (S6-T13), the
    // persistent cooldown table — not the in-memory ledger — is the
    // authority, so the shared skip above lands there with the provider's
    // reset carried over. The ledger stays for callers without one.
    expect(shared.exhaustedUntil('key_a', NOW)).toBe(undefined);
    const cooldown = assistantKeyCooldownsRepo.getCooldown(
      t.scopes.instance(),
      'key_a',
      'm:free',
      NOW,
    );
    expect(cooldown).toMatchObject({ reason: 'daily-quota', until: resetAt });
  });

  it('appends the Brave attribution when web results reached the model', async () => {
    eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
      provider: 'fake',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'For production.',
      productionUseAllowed: true,
      now: NOW,
    });
    const web = fakeProvider([
      { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
      { text: 'Store them half charged.', model: 'm' },
    ]);
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {
        provider: web.provider,
        webSearch: async () => ({
          results: [{ title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' }],
          source: 'brave' as const,
        }),
      },
    );
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: true,
      content: 'Store them half charged.\n\n-# Powered by Brave Search',
    });
  });

  it('omits the Brave attribution when web results came from Tavily', async () => {
    eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
      provider: 'fake',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'For production.',
      productionUseAllowed: true,
      now: NOW,
    });
    const web = fakeProvider([
      { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
      { text: 'Store them half charged.', model: 'm' },
    ]);
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {
        provider: web.provider,
        webSearch: async () => ({
          results: [{ title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' }],
          source: 'tavily' as const,
        }),
      },
    );
    const result = await service.invoke(ask);
    expect(result).toMatchObject({ ok: true, content: 'Store them half charged.' });
  });

  it('warns once when the answer used Tavily results, never for Brave', async () => {
    eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
      provider: 'fake',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'For production.',
      productionUseAllowed: true,
      now: NOW,
    });
    const invokeWithSource = async (source: 'brave' | 'tavily', invocationId: string) => {
      const web = fakeProvider([
        { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
        { text: 'Store them half charged.', model: 'm' },
      ]);
      const warn = vi.fn();
      const service = createAssistantService(
        t.scopes.forGuild(GUILD),
        t.scopes.instance(),
        config,
        () => NOW,
        {
          provider: web.provider,
          webSearch: async () => ({
            results: [{ title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' }],
            source,
          }),
        },
        undefined,
        { warn, info: vi.fn() },
      );
      const result = await service.invoke({ ...ask, invocationId });
      expect(result).toMatchObject({ ok: true });
      return warn;
    };
    const tavilyWarn = await invokeWithSource('tavily', 'int-search-may-train-tavily');
    expect(tavilyWarn).toHaveBeenCalledTimes(1);
    expect(tavilyWarn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD, reason: 'search-provider-may-train' }),
      'web search provider may train on queries',
    );
    const braveWarn = await invokeWithSource('brave', 'int-search-may-train-brave');
    expect(braveWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'search-provider-may-train' }),
      expect.anything(),
    );
  });

  it('uses the webSearch constructor parameter when no test port is given', async () => {
    eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
      provider: 'fake',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'For production.',
      productionUseAllowed: true,
      now: NOW,
    });
    const web = fakeProvider([
      { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
      { text: 'Store them half charged.', model: 'm' },
    ]);
    const run = vi.fn(async () => ({
      results: [{ title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' }],
      source: 'brave' as const,
    }));
    const webSearch = vi.fn(() => run);
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      { provider: web.provider },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      webSearch,
    );
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: true,
      content: 'Store them half charged.\n\n-# Powered by Brave Search',
    });
    expect(webSearch).toHaveBeenCalledWith(GUILD);
    expect(run).toHaveBeenCalledWith('lipo');
  });

  it('a chain entry at its RPM limit throws LocalLimitError and the provider stays at one call', async () => {
    const scripted = fakeProvider([{ text: 'First answer.', model: 'model-a' }]);
    const service = serviceWith(() => [usable(scripted.provider, { rpmLimit: 1 })]);
    await expect(service.invoke({ ...ask, invocationId: 'int-rpm-1' })).resolves.toMatchObject({
      ok: true,
    });
    const thrown = await service
      .invoke({ ...ask, invocationId: 'int-rpm-2' })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(LocalLimitError);
    const limit = thrown as LocalLimitError;
    expect(limit).toMatchObject({ code: 'local-rpm-limit', availableAt: NOW + 60_000 });
    expect(limit.attempts?.length).toBeGreaterThanOrEqual(1);
    expect(limit.detail?.sections.length).toBeGreaterThan(0);
    await expect(service.invoke({ ...ask, invocationId: 'int-rpm-3' })).rejects.toMatchObject({
      code: 'local-rpm-limit',
      availableAt: NOW + 60_000,
    });
    expect(scripted.calls()).toBe(1);
  });

  it('an .env-seed entry is never limited and inserts no ledger row', async () => {
    const scripted = fakeProvider([
      { text: 'First.', model: 'model-a' },
      { text: 'Second.', model: 'model-a' },
    ]);
    const service = serviceWith(() => [
      usable(scripted.provider, { keyId: ENV_KEY_ID, rpmLimit: 1, rpdLimit: 1 }),
    ]);
    await expect(service.invoke({ ...ask, invocationId: 'int-env-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.invoke({ ...ask, invocationId: 'int-env-2' })).resolves.toMatchObject({
      ok: true,
    });
    expect(scripted.calls()).toBe(2);
    expect(
      modelCallsRepo.modelUsage(t.scopes.instance(), {
        keyId: ENV_KEY_ID,
        model: 'model-a',
        now: NOW,
        dayStart: 0,
      }).today,
    ).toBe(0);
  });
});

describe('Task 16: cache catalogue, pre-retrieved evidence, no live fetch', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: ['handbook'],
    enabled: true,
  };

  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const seedCache = (url: string, resourceId: string, texts: readonly string[]) => {
    const scope = t.scopes.forGuild(GUILD);
    const docId = computeDocId(url);
    resourceCacheRepo.upsertDocument(scope, {
      resourceId,
      docId,
      url,
      path: '/guide',
      title: resourceId,
      contentHash: `hash-${resourceId}`,
      fetchedAt: NOW - 3_600_000,
      bytes: 100,
      status: 'ok',
    });
    resourceCacheRepo.replaceChunks(
      scope,
      docId,
      resourceId,
      texts.map((text, i) => ({
        ordinal: i,
        headingPath: `Guide › Part ${String(i)}`,
        lineStart: i + 1,
        lineEnd: i + 1,
        text,
      })),
    );
    return docId;
  };

  it('never calls the live fetcher and prompts with a catalogue, preferred first, within 60 lines', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    assistantRepo.putResource(scope, {
      id: 'rules',
      guildId: GUILD,
      title: 'Rules',
      url: 'https://example.com/rules',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    seedCache('https://example.com/handbook', 'handbook', ['battery care guide for the club']);
    const fetchResource = vi.fn(async () => {
      throw new Error('live fetch must not happen');
    });
    let systemInstruction = '';
    let userText = '';
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        systemInstruction = req.systemInstruction ?? '';
        userText = req.messages.map((m) => m.text ?? '').join('\n');
        return { text: 'ok', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      scope,
      t.scopes.instance(),
      config,
      () => NOW,
      { fetchResource },
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-cache-1',
    });
    expect(result.ok).toBe(true);
    expect(fetchResource).not.toHaveBeenCalled();
    expect(systemInstruction).toContain('CLUB SOURCES');
    const handbookAt = systemInstruction.indexOf('handbook · Handbook');
    const rulesAt = systemInstruction.indexOf('rules · Rules');
    expect(handbookAt).toBeGreaterThanOrEqual(0);
    expect(rulesAt).toBeGreaterThan(handbookAt);
    const catalogueLines = systemInstruction
      .split('\n')
      .filter((l) => l.includes(' · ') && l.includes('updated'));
    expect(catalogueLines.length).toBeLessThanOrEqual(60);
    expect(userText).toContain('chunk=');
  });

  it('keeps a disabled resource out of the catalogue and the pre-retrieved snippets', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    assistantRepo.putResource(scope, {
      id: 'off',
      guildId: GUILD,
      title: 'Old',
      url: 'https://example.com/old',
      kind: 'website',
      enabled: false,
      reviewedAt: new Date(NOW).toISOString(),
    });
    seedCache('https://example.com/handbook', 'handbook', ['battery care guide for the club']);
    seedCache('https://example.com/old', 'off', ['battery care archived minutes']);
    let systemInstruction = '';
    let userText = '';
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        systemInstruction = req.systemInstruction ?? '';
        userText = req.messages.map((m) => m.text ?? '').join('\n');
        return { text: 'ok', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      scope,
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-cache-off',
    });
    expect(result.ok).toBe(true);
    expect(systemInstruction).toContain('handbook · Handbook');
    expect(systemInstruction).not.toContain('off · Old');
    expect(userText).not.toContain('archived minutes');
  });

  it('pre-retrieves at most four snippets and opens them in round 2 from initial handles', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    const docId = seedCache('https://example.com/handbook', 'handbook', [
      'battery care guide part zero',
      'battery care guide part one',
      'battery care guide part two',
      'battery care guide part three',
      'battery care guide part four',
      'battery care guide part five',
    ]);
    const chunk0 = `c_${docId}_0`;
    const requests: { systemInstruction: string; messagesText: string }[] = [];
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        round += 1;
        requests.push({
          systemInstruction: req.systemInstruction ?? '',
          messagesText: req.messages.map((m) => m.text ?? '').join('\n'),
        });
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'search_sources', args: {} }],
          };
        if (round === 2)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'read_chunk', args: { chunkId: chunk0 } }],
          };
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      scope,
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-cache-2',
    });
    expect(result.ok).toBe(true);
    const evidenceChunks = (requests[0]?.messagesText.match(/chunk=/g) ?? []).length;
    expect(evidenceChunks).toBeLessThanOrEqual(4);
    expect(evidenceChunks).toBeGreaterThan(0);
    expect(result.trace?.tools).toMatchObject([
      { name: 'search_sources', ok: true },
      { name: 'read_chunk', ok: true },
    ]);
  });
});

/**
 * Task 14: the service sends the job-built conversation history to the
 * provider, appends the quoted envelope to the user text (never the system
 * instruction), and returns the trace detail the job persists.
 */
describe('Task 14: conversation history, quoted envelope and trace detail', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const capturing = () => {
    const requests: { systemInstruction: string; messages: { role: string; text: string }[] }[] =
      [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async (req) => {
        requests.push({
          systemInstruction: req.systemInstruction ?? '',
          messages: req.messages.map((message) => ({ role: message.role, text: message.text })),
        });
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    return { requests, service };
  };

  const ask = (over: Record<string, unknown> = {}) => ({
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    callerRoleIds: [CLUB_ROLE],
    behaviour: direct,
    command: 'ask' as const,
    input: { question: 'second question' },
    source: 'slash-command' as const,
    invocationId: 'int-history-1',
    ...over,
  });

  it('sends the conversation history before the current user text', async () => {
    const { requests, service } = capturing();
    const history = [
      { role: 'user' as const, text: 'Ama: first question' },
      { role: 'assistant' as const, text: 'first answer' },
    ];
    const result = await service.invoke(ask({ history }));
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const messages = requests[0]?.messages ?? [];
    expect(messages[0]).toEqual({ role: 'user', text: 'Ama: first question' });
    expect(messages[1]).toEqual({ role: 'assistant', text: 'first answer' });
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.text).toContain('second question');
  });

  it('appends the quoted envelope to the user text, never the system instruction', async () => {
    const { requests, service } = capturing();
    const quoteEnvelope =
      '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]';
    const result = await service.invoke(ask({ quoteEnvelope, askerName: 'Ama' }));
    expect(result.ok).toBe(true);
    const first = requests[0];
    const lastText = first?.messages.at(-1)?.text ?? '';
    expect(lastText).toContain(quoteEnvelope);
    expect(lastText.indexOf(quoteEnvelope)).toBeLessThan(
      lastText.indexOf('[CURRENT MESSAGE from="Ama"]'),
    );
    expect(first?.systemInstruction).not.toContain('UNTRUSTED QUOTED MESSAGE');
    expect(first?.systemInstruction).not.toContain('the hall opens at seven');
  });

  it('ends the user message with the current-message block and the answer line', async () => {
    const { requests, service } = capturing();
    const result = await service.invoke(ask({ askerName: 'Ama' }));
    expect(result.ok).toBe(true);
    const lastText = requests[0]?.messages.at(-1)?.text ?? '';
    expect(lastText).toContain('[CURRENT MESSAGE from="Ama"]\nsecond question\n[/CURRENT MESSAGE]');
    expect(lastText.endsWith("[/CURRENT MESSAGE]\n\nAnswer Ama's current message.")).toBe(true);
  });

  it('places pre-retrieved evidence before the current-message block', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    const url = 'https://example.com/handbook';
    const docId = computeDocId(url);
    resourceCacheRepo.upsertDocument(scope, {
      resourceId: 'handbook',
      docId,
      url,
      path: '/guide',
      title: 'handbook',
      contentHash: 'hash-handbook',
      fetchedAt: NOW - 3_600_000,
      bytes: 100,
      status: 'ok',
    });
    resourceCacheRepo.replaceChunks(scope, docId, 'handbook', [
      {
        ordinal: 0,
        headingPath: 'Guide',
        lineStart: 1,
        lineEnd: 1,
        text: 'battery care guide for the club',
      },
    ]);
    const { requests, service } = capturing();
    const result = await service.invoke(
      ask({ input: { question: 'battery care' }, askerName: 'Ama' }),
    );
    expect(result.ok).toBe(true);
    const lastText = requests[0]?.messages.at(-1)?.text ?? '';
    expect(lastText).toContain('chunk=');
    expect(lastText.indexOf('chunk=')).toBeLessThan(
      lastText.indexOf('[CURRENT MESSAGE from="Ama"]'),
    );
  });

  it('stores the user message as a user-message trace section with the exact text', async () => {
    const { requests, service } = capturing();
    const result = await service.invoke(ask({ askerName: 'Ama' }));
    expect(result.ok).toBe(true);
    const lastText = requests[0]?.messages.at(-1)?.text ?? '';
    const sections = result.detail?.sections ?? [];
    const userMessage = sections.find((section) => section.name === 'user-message');
    expect(userMessage?.text).toBe(lastText);
    expect(sections.at(-1)?.name).toBe('user-message');
  });

  it('keeps the quoted message out of the traced user message', async () => {
    const { requests, service } = capturing();
    const quoted = 'the hall opens at seven';
    const result = await service.invoke(
      ask({
        quoteEnvelope: `[UNTRUSTED QUOTED MESSAGE author="Alex"]\n${quoted}\n[/UNTRUSTED QUOTED MESSAGE]`,
      }),
    );
    expect(result.ok).toBe(true);
    // The provider still gets the quote...
    const lastText = requests[0]?.messages.at(-1)?.text ?? '';
    expect(lastText).toContain(quoted);
    // ...but the trace keeps a placeholder instead.
    const sections = result.detail?.sections ?? [];
    const userMessage = sections.find((section) => section.name === 'user-message');
    expect(userMessage?.text).not.toContain(quoted);
    expect(userMessage?.text).toContain('[quoted message: not kept in the trace]');
  });

  it('returns trace detail with capability sections plus history when history was sent (ADR 0136)', async () => {
    const { service } = capturing();
    const history = [{ role: 'user' as const, text: 'first question' }];
    const result = await service.invoke(ask({ history }));
    expect(result.ok).toBe(true);
    const sections = result.detail?.sections.map((section) => section.name) ?? [];
    expect(sections).toEqual(
      expect.arrayContaining([
        'behaviour-prompt',
        'safety-suffix',
        'server-card',
        'resources',
        'capabilities',
        'history',
      ]),
    );
    expect(result.detail?.history).toEqual(history);
    expect(result.detail?.attempts.length).toBeGreaterThan(0);
  });

  it('omits the history section when no history was sent', async () => {
    const { service } = capturing();
    const result = await service.invoke(ask());
    expect(result.ok).toBe(true);
    const sections = result.detail?.sections.map((section) => section.name) ?? [];
    expect(sections).not.toContain('history');
    expect(sections.at(-1)).toBe('user-message');
  });

  it('labels try-it history user turns', async () => {
    const seen: { role: string; text: string }[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async (req) => {
        seen.push(req.messages.map((message) => ({ role: message.role, text: message.text })));
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [usable(provider)],
    );
    const first = await service.tryIt({
      behaviourId: 'direct',
      question: 'first question',
      accountUsername: 'owner-name',
    });
    await service.tryIt({
      behaviourId: 'direct',
      question: 'second question',
      conversationId: first.conversationId,
      accountUsername: 'owner-name',
    });
    const secondMessages = seen[1] ?? [];
    const historyUser = secondMessages.filter((message) => message.role === 'user').slice(0, -1);
    expect(historyUser.length).toBeGreaterThan(0);
    expect(historyUser[0]?.text).toMatch(/^\[owner-name, .+\] first question$/);
  });
});

/**
 * Task 20: dashboard Try-it runs the same pipeline with `source:
 * 'dashboard-test'` and no Discord posts, and answers end with a short
 * sources line.
 */
describe('Task 20: tryIt, sources line and friendly failures', () => {
  const GUILD = parseGuildId('234567890123456789');
  const BOT = '123456789012345678';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: BOT,
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  const answering = (text: string): TextProvider => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: async () => ({ text, model: 'model-a' }),
  });

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const serviceWith = (provider: TextProvider, ports: AssistantServiceTestPorts = {}) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      ports,
      undefined,
      undefined,
      { memberChannels: vi.fn(async () => []) },
      () => [usable(provider)],
    );

  const seedResource = (id: string, title: string, texts: readonly string[]) => {
    const scope = t.scopes.forGuild(GUILD);
    const url = `https://example.com/${id}`;
    assistantRepo.putResource(scope, {
      id,
      guildId: GUILD,
      title,
      url,
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    const docId = computeDocId(url);
    resourceCacheRepo.upsertDocument(scope, {
      resourceId: id,
      docId,
      url,
      path: '/guide',
      title: id,
      contentHash: `hash-${id}`,
      fetchedAt: NOW - 3_600_000,
      bytes: 100,
      status: 'ok',
    });
    resourceCacheRepo.replaceChunks(
      scope,
      docId,
      id,
      texts.map((text, i) => ({
        ordinal: i,
        headingPath: `Guide › Part ${String(i)}`,
        lineStart: i + 1,
        lineEnd: i + 1,
        text,
      })),
    );
    return docId;
  };

  it('answers without the caller-role gate and writes dashboard-test rows', async () => {
    const service = serviceWith(answering('Try-it answer.'));
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'when is the meeting?',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Try-it answer.');
    expect(result.conversationId).toMatch(/^try_/);
    expect(result.traceId).toMatch(/^try_/);
    const scope = t.scopes.forGuild(GUILD);
    expect(conversationRepo.getConversation(scope, result.conversationId)).toMatchObject({
      source: 'dashboard-test',
      startedBy: BOT,
    });
    const trace = traceRepo.getTrace(scope, result.traceId);
    expect(trace).toMatchObject({ source: 'dashboard-test', answer: 'Try-it answer.' });
    expect(trace?.flags).toContain('dashboard-account:owner-name');
    expect(jobRepo.listJobs(scope, { limit: 10 })).toEqual([]);
  });

  it('(M1) a ledger ensureRun failure still answers and stores the trace', async () => {
    const service = serviceWith(answering('Try-it answer.'));
    const spy = vi.spyOn(runRepo, 'ensureRun').mockImplementationOnce(() => {
      throw new Error('ledger down');
    });
    try {
      const result = await service.tryIt({
        behaviourId: 'direct',
        question: 'when is the meeting?',
        accountUsername: 'owner-name',
      });
      expect(result.answer).toBe('Try-it answer.');
      const trace = traceRepo.getTrace(t.scopes.forGuild(GUILD), result.traceId);
      expect(trace).toMatchObject({ answer: 'Try-it answer.' });
    } finally {
      spy.mockRestore();
    }
  });

  it('tryIt with a 404-only chain stores a failed trace with attempts, sections and the runId', async () => {
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        throw new ProviderError(
          'invalid-request',
          'openrouter request failed with HTTP 404 (code 404: No endpoints found for bad-model.)',
          false,
          { status: 404, host: 'openrouter.ai' },
        );
      },
    };
    const service = serviceWith(failing);
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'when is the meeting?',
      accountUsername: 'owner-name',
    });
    const scope = t.scopes.forGuild(GUILD);
    const trace = traceRepo.getTrace(scope, result.traceId);
    expect(trace?.outcome).toBe('failed');
    expect(trace?.attempts).toHaveLength(1);
    expect(trace?.sections.length).toBeGreaterThan(0);
    expect(trace?.error).toMatchObject({ kind: 'invalid-request' });
    const userTurn = conversationRepo
      .listTurns(scope, result.conversationId)
      .find((turn) => turn.role === 'user');
    expect(userTurn).toBeDefined();
    expect(trace?.runId).toBe(userTurn?.turnId);
  });

  it('try-it never carries channel context', async () => {
    const service = serviceWith(answering('Try-it answer.'));
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'when is the meeting?',
      accountUsername: 'owner-name',
    });
    const trace = traceRepo.getTrace(t.scopes.forGuild(GUILD), result.traceId);
    expect(trace?.included?.channelMessages).toBeUndefined();
  });

  it('continues the same conversation when the id is passed back', async () => {
    const service = serviceWith(answering('Another answer.'));
    const first = await service.tryIt({
      behaviourId: 'direct',
      question: 'first question',
      accountUsername: 'owner-name',
    });
    const second = await service.tryIt({
      behaviourId: 'direct',
      question: 'second question',
      conversationId: first.conversationId,
      accountUsername: 'owner-name',
    });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.traceId).not.toBe(first.traceId);
    expect(conversationRepo.listTurns(t.scopes.forGuild(GUILD), first.conversationId)).toHaveLength(
      4,
    );
  });

  it('rejects an unknown or disabled behaviour', async () => {
    const service = serviceWith(answering('unused'));
    await expect(
      service.tryIt({ behaviourId: 'missing', question: 'hi', accountUsername: 'owner-name' }),
    ).rejects.toThrow('unknown-behaviour');
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), { ...direct, enabled: false }, NOW);
    await expect(
      service.tryIt({ behaviourId: 'direct', question: 'hi', accountUsername: 'owner-name' }),
    ).rejects.toThrow('behaviour-disabled');
  });

  it('never reads member memories on the try-it path', async () => {
    assistantRepo.putMemory(
      t.scopes.forGuild(GUILD),
      { id: 'mem-1', section: 'club', content: 'the secret club handshake' },
      NOW,
    );
    let systemInstruction = '';
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async (req) => {
        systemInstruction = req.systemInstruction ?? '';
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = serviceWith(provider);
    await service.tryIt({
      behaviourId: 'direct',
      question: 'what is the handshake?',
      accountUsername: 'owner-name',
    });
    expect(systemInstruction).not.toContain('the secret club handshake');
  });

  it('answers the busy text when every provider is busy', async () => {
    const service = serviceWith({
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        throw new ProviderError('outage', 'all models busy', true);
      },
    });
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'hi',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe(
      'The AI service is busy right now. Try again in a minute. No action was taken.',
    );
    const trace = traceRepo.getTrace(t.scopes.forGuild(GUILD), result.traceId);
    expect(trace?.outcome).toBe('failed');
  });

  it('answers the local-limit text when every entry is at its configured limit', async () => {
    let n = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async () => {
        n += 1;
        return { text: 'First.', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [{ ...usable(provider), rpmLimit: 1 }],
    );
    const first = await service.tryIt({
      behaviourId: 'direct',
      question: 'hi',
      accountUsername: 'owner-name',
    });
    expect(first.answer).toBe('First.');
    const second = await service.tryIt({
      behaviourId: 'direct',
      question: 'hi again',
      accountUsername: 'owner-name',
    });
    expect(second.answer).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 1 minute.',
    );
    expect(n).toBe(1);
  });

  it('answers the configured-refusal text when no provider is usable', async () => {
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [],
    );
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'hi',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe(
      'The free AI provider is not configured, so no content was sent outside the server.',
    );
  });

  it('answers an escalation as text without opening a ticket', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putBehaviour(
      scope,
      {
        ...direct,
        id: 'it',
        surface: 'it-services',
        ticketChannelId: '987654321098765432',
        reviewerRoleIds: ['876543210987654321'],
      },
      NOW,
    );
    const service = serviceWith(answering('ESCALATE: reset the lab password'));
    const result = await service.tryIt({
      behaviourId: 'it',
      question: 'reset it',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('reset the lab password');
    expect(assistantRepo.listTickets(scope)).toEqual([]);
  });

  it('an escalation summary never carries the sources line', async () => {
    seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    const scope = t.scopes.forGuild(GUILD);
    const itBehaviour = {
      ...direct,
      id: 'it',
      surface: 'it-services' as const,
      ticketChannelId: '987654321098765432',
      reviewerRoleIds: ['876543210987654321'],
    };
    assistantRepo.putBehaviour(scope, itBehaviour, NOW);
    const service = serviceWith(answering('ESCALATE: reset the lab password'));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: itBehaviour,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-escalate-sources',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    // The pre-retrieved evidence would append a sources line to a normal
    // answer; the escalation summary must not carry it.
    expect(content).toBe('reset the lab password');
    expect(content).not.toContain('Sources');
    const tickets = assistantRepo.listTickets(scope);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.summary).not.toContain('Sources');
  });

  it('flags an unreadable resource cache and still answers from the model', async () => {
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {
        cacheSearch: () => {
          throw new Error('cache down');
        },
      },
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [usable(answering('Answered without sources.'))],
    );
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'battery care',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Answered without sources.');
    expect(traceRepo.getTrace(t.scopes.forGuild(GUILD), result.traceId)?.flags).toContain(
      'resources-unavailable',
    );
  });

  it('carries resources-unavailable on the Discord-path result', async () => {
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {
        cacheSearch: () => {
          throw new Error('cache down');
        },
      },
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [usable(answering('Answered without sources.'))],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-resources-unavailable-flag',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toBe('Answered without sources.');
    expect(result.flags ?? []).toContain('resources-unavailable');
  });

  it('adds no sources line when nothing was opened', async () => {
    const service = serviceWith(answering('Plain answer.'));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'hi' },
      source: 'slash-command',
      invocationId: 'int-no-sources',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toBe('Plain answer.');
  });

  it('does not list pre-retrieved sources when the answer cites none', async () => {
    seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    const service = serviceWith(answering('Plain answer.'));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-no-cited-sources',
    });
    expect(result.ok === true && result.content).toBe('Plain answer.');
  });

  it('removes a model-written Source line from the posted answer', async () => {
    const service = serviceWith(answering('Answer.\nSource: https://x.test'));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'hi' },
      source: 'slash-command',
      invocationId: 'int-source-line',
    });
    expect(result.ok === true && result.content).toBe('Answer.');
  });

  it('adds a sources line for a chunk the model opened, deduped', async () => {
    const docId = seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    const chunk0 = `c_${docId}_0`;
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        round += 1;
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [
              { name: 'read_chunk', args: { chunkId: chunk0 } },
              { name: 'read_chunk', args: { chunkId: chunk0 } },
            ],
          };
        return { text: 'Here is the care guide. [S1]', model: 'model-a' };
      },
    };
    const service = serviceWith(provider);
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'unrelated words here' },
      source: 'slash-command',
      invocationId: 'int-opened-chunk',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain('\n\n-# Sources: Handbook');
    expect(content).not.toContain(' · ');
  });

  it('adds a sources line with headings for pre-retrieved evidence', async () => {
    seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    seedResource('alpha', 'Alpha', ['alpha care notes for the club']);
    seedResource('beta', 'Beta', ['beta care notes for the club']);
    seedResource('gamma', 'Gamma', ['gamma care notes for the club']);
    const hit = (resourceId: string, snippet: string) => ({
      resourceId,
      chunkId: `c_${resourceId}_0`,
      docId: `d_${resourceId}`,
      headingPath: 'Guide › Part 0',
      snippet,
    });
    const service = serviceWith(answering('Here is the care guide. [S1]'), {
      cacheSearch: () => [
        hit('handbook', 'battery care guide'),
        hit('alpha', 'alpha care notes'),
        hit('beta', 'beta care notes'),
        hit('gamma', 'gamma care notes'),
      ],
    });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-preretrieved',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const line = content.split('\n').find((l) => l.startsWith('-# Sources:')) ?? '';
    expect(line).toBe('-# Sources: Handbook › Guide › Part 0');
    expect(content).not.toContain('Alpha');
    expect(content).not.toContain('Beta');
    expect(content).not.toContain('Gamma');
    expect(content).not.toContain('[S');
  });

  it('clips a 5000-char pre-retrieved heading in the sources line', async () => {
    seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    const longHeading = 'H'.repeat(5_000);
    const service = serviceWith(answering('Here is the care guide. [S1]'), {
      cacheSearch: () => [
        {
          resourceId: 'handbook',
          chunkId: 'c_long_0',
          docId: 'd_long',
          headingPath: longHeading,
          snippet: 'battery care guide',
        },
      ],
    });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-long-heading-sources',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const line = content.split('\n').find((l) => l.startsWith('-# Sources:')) ?? '';
    expect(line).not.toBe('');
    expect(line.length).toBeLessThan(300);
    expect(line).toContain('…');
    expect(content).not.toContain(longHeading);
  });

  it('dedupes sources by URL and never lists more than five', async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'] as const;
    const docIds = ids.map((id, i) =>
      seedResource(id, id[0]!.toUpperCase() + id.slice(1), [`unique care text ${String(i)}`]),
    );
    const chunks = docIds.map((docId) => `c_${docId}_0`);
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        round += 1;
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: chunks.map((chunkId) => ({ name: 'read_chunk', args: { chunkId } })),
          };
        return { text: 'Done. [S1, S2, S3, S4]', model: 'model-a' };
      },
    };
    const service = serviceWith(provider);
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'zzzz no cache match' },
      source: 'slash-command',
      invocationId: 'int-dedupe-cap',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const line = content.split('\n').find((l) => l.startsWith('-# Sources:')) ?? '';
    expect((line.match(/ · /g) ?? []).length).toBe(3);
  });

  it('lists exactly five entries when the answer cites six known sources', async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const;
    const docIds = ids.map((id, i) =>
      seedResource(id, id[0]!.toUpperCase() + id.slice(1), [`unique care text ${String(i)}`]),
    );
    const chunks = docIds.map((docId) => `c_${docId}_0`);
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        round += 1;
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: chunks.map((chunkId) => ({ name: 'read_chunk', args: { chunkId } })),
          };
        return { text: 'Done. [S1, S2, S3, S4, S5, S6]', model: 'model-a' };
      },
    };
    const service = serviceWith(provider);
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'zzzz no cache match' },
      source: 'slash-command',
      invocationId: 'int-six-cited-cap',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const line = content.split('\n').find((l) => l.startsWith('-# Sources:')) ?? '';
    expect((line.match(/ · /g) ?? []).length).toBe(4);
    expect(line).toContain('Epsilon');
    expect(line).not.toContain('Zeta');
    expect(content).not.toContain('[S');
  });

  it('lists only the known source when the answer also cites a web result', async () => {
    seedResource('handbook', 'Handbook', ['battery care guide for the club']);
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        round += 1;
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'web_search', args: { query: 'battery care' } }],
          };
        return { text: 'Both used. [S1, S2]', model: 'model-a' };
      },
    };
    const service = serviceWith(provider, {
      webSearch: async () => ({
        results: [
          { title: 'Web Guide', url: 'https://web.example/guide', description: 'Web care.' },
        ],
        source: 'brave' as const,
      }),
    });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: '567890123456789012',
      userId: '456789012345678901',
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-known-plus-web',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const line = content.split('\n').find((l) => l.startsWith('-# Sources:')) ?? '';
    expect(line).toBe('-# Sources: Handbook › Guide › Part 0');
    expect(content).not.toContain('Web Guide');
    expect(content).not.toContain('[S');
  });
});

describe('Task 7: loop limits from the AI tuning settings', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    // ADR 0081: the service reserves every provider call in the ledger, whose
    // `key_id` references a stored key — so the `key_a` fixture entries and
    // the `key_test` test-provider entries run on real stored keys instead of
    // bare ids.
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  it('passes loopLimits through to the provider request', async () => {
    const seen: { readonly maxOutputTokens?: number | undefined }[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async (request) => {
        seen.push({ maxOutputTokens: request.maxOutputTokens });
        return { text: 'ok', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [
        {
          providerId: 'gemini',
          model: 'model-a',
          keyId: 'key_a',
          keyLabel: 'Key A',
          provider,
          skip: undefined,
          mayTrain: false,
          rpmLimit: null,
          rpdLimit: null,
        },
      ],
      undefined,
      () => ({ rounds: 1, totalCalls: 2, maxOutputTokens: 300 }),
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'hi' },
      source: 'slash-command',
      invocationId: 'int-loop-limits',
    });
    expect(result.ok).toBe(true);
    expect(seen[0]?.maxOutputTokens).toBe(300);
  });
});

describe('Task 10 (b): busy chain throws ChainFailedError', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  const ask = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    callerRoleIds: [CLUB_ROLE],
    behaviour: direct,
    command: 'ask' as const,
    input: { question: 'when is the meeting?' },
    source: 'slash-command' as const,
    invocationId: 'int-chain-failed',
  };

  const connectTimeout = (): ProviderError =>
    new ProviderError('outage', 'openrouter request failed', true, {
      cause: new TypeError('fetch failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      }),
      host: 'openrouter.ai',
    });

  const failingProvider = (): TextProvider => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools'] as const),
    generateText: async () => {
      throw connectTimeout();
    },
  });

  const usable = (provider: TextProvider, model: string): ChainEntry => ({
    providerId: 'openrouter',
    model,
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  it('two connect-timeout entries throw ChainFailedError naming both', async () => {
    const { ChainFailedError } = await import('./chain-failed-error.js');
    const t: MigratedTestDatabase = openMigratedTestDatabase();
    try {
      guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
      assistantProvidersRepo.addKey(t.scopes.instance(), {
        provider: 'openrouter',
        label: 'Key A',
        apiKeyEnc: 'sealed-key-a',
        now: NOW,
        keyId: 'key_a',
      });
      assistantProvidersRepo.addKey(t.scopes.instance(), {
        provider: 'openrouter',
        label: 'Test provider',
        apiKeyEnc: 'sealed-key-test',
        now: NOW,
        keyId: 'key_test',
      });
      assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
      const service = createAssistantService(
        t.scopes.forGuild(GUILD),
        t.scopes.instance(),
        config,
        () => NOW,
        {},
        undefined,
        undefined,
        undefined,
        () => [usable(failingProvider(), 'model-a'), usable(failingProvider(), 'model-b')],
      );
      const err = await service.invoke(ask).then(
        () => {
          throw new Error('expected invoke to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ChainFailedError);
      const chained = err as InstanceType<typeof ChainFailedError>;
      expect(chained.code).toBe('chain-failed');
      expect(chained.attempts).toHaveLength(2);
      const occurrences = chained.summary.split('provider-connect-timeout').length - 1;
      expect(occurrences).toBe(2);
    } finally {
      t.close();
    }
  });
});

/**
 * B2b fix 2: one shared harness for the three B2b describes below. Same
 * guild ids, config, behaviour shape, provider keys and service wiring —
 * only the behaviour's skill allowlist varies per block. Each describe keeps
 * its own test-specific helpers (`ask`, `targetsOk`, `actionsOf`).
 */
const B2B_GUILD = parseGuildId('234567890123456789');
const B2B_MEMBER = '456789012345678901';
const B2B_CHANNEL = '567890123456789012';
const B2B_CLUB_ROLE = '678901234567890123';
const B2B_SPECIAL_ROLE = '789012345678901234';
const B2B_OWNER = '345678901234567890';
const B2B_NOW = 1_800_000_000_000;

const B2B_CONFIG = parseConfig({
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_APPLICATION_ID: '123456789012345678',
  BANANASAURS_GUILD_ALLOWLIST: B2B_GUILD,
  BANANASAURS_OWNER_USER_ID: B2B_OWNER,
  AI_PROVIDER: 'off',
  AI_MODEL: 'fixture-model',
  AI_PROFILE_COST_CLASS: 'free',
});

const setupB2b = (preferredSkillIds: readonly string[]) => {
  const t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(B2B_GUILD), { name: 'fixture', now: B2B_NOW });
  assistantProvidersRepo.addKey(t.scopes.instance(), {
    provider: 'gemini',
    label: 'Key A',
    apiKeyEnc: 'sealed-key-a',
    now: B2B_NOW,
    keyId: 'key_a',
  });
  assistantProvidersRepo.addKey(t.scopes.instance(), {
    provider: 'gemini',
    label: 'Test provider',
    apiKeyEnc: 'sealed-key-test',
    now: B2B_NOW,
    keyId: 'key_test',
  });
  const direct = {
    id: 'direct',
    guildId: B2B_GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [B2B_CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: [...preferredSkillIds],
    resourceIds: [],
    enabled: true,
  };
  assistantRepo.putBehaviour(t.scopes.forGuild(B2B_GUILD), direct, B2B_NOW);
  assistantRepo.putSkillGrant(
    t.scopes.forGuild(B2B_GUILD),
    { skillId: 'search-club', roleIds: [B2B_CLUB_ROLE], userIds: [] },
    B2B_NOW,
  );
  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });
  const scripted = (responses: GenerateTextResponse[]): TextProvider => {
    const queue = [...responses];
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error('no scripted response');
        return next;
      },
    };
  };
  const serviceWith = (
    provider: TextProvider,
    discord: Parameters<typeof createAssistantService>[7] = {
      memberChannels: async () => [],
    },
    ports: AssistantServiceTestPorts = {},
  ) =>
    createAssistantService(
      t.scopes.forGuild(B2B_GUILD),
      t.scopes.instance(),
      B2B_CONFIG,
      () => B2B_NOW,
      ports,
      undefined,
      undefined,
      discord,
      () => [usable(provider)],
    );
  return { t, direct, usable, scripted, serviceWith };
};

/**
 * B2b step 1: each skill is gated by the behaviour allowlist and its
 * per-skill scope, checked in code against the asker's live roles. The owner
 * passes every scope; try-it counts as the owner.
 */
describe('B2b: per-skill scopes gate chat skills', () => {
  const GUILD = B2B_GUILD;
  const MEMBER = B2B_MEMBER;
  const CHANNEL = B2B_CHANNEL;
  const CLUB_ROLE = B2B_CLUB_ROLE;
  const SPECIAL_ROLE = B2B_SPECIAL_ROLE;
  const OWNER = B2B_OWNER;
  const NOW = B2B_NOW;

  let h: ReturnType<typeof setupB2b>;
  beforeEach(() => {
    h = setupB2b(['search-club', 'reminders']);
  });
  afterEach(() => h.t.close());

  const wrap = (
    generateText: (req: { systemInstruction?: string }) => Promise<GenerateTextResponse>,
  ): TextProvider => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText,
  });

  const ask = (over: Record<string, unknown> = {}) => ({
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    callerRoleIds: [CLUB_ROLE],
    behaviour: h.direct,
    command: 'ask' as const,
    input: { question: 'when is the meeting?' },
    source: 'slash-command' as const,
    invocationId: 'int-scope-1',
    ...over,
  });

  it('a member without the scoped role is refused, one with it passes', async () => {
    assistantRepo.setSkillScope(
      h.t.scopes.forGuild(GUILD),
      { skillId: 'search-club', mode: 'roles', roleIds: [SPECIAL_ROLE] },
      NOW,
    );
    const generateText = vi.fn(async () => ({ text: 'done', model: 'model-a' }));
    const service = h.serviceWith(wrap(generateText));
    const refused = await service.invoke(ask());
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.content).toBe(
      "You don't have access to that assistant skill. No action was taken.",
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(assistantRepo.listSkillActivity(h.t.scopes.forGuild(GUILD), 10)[0]).toMatchObject({
      skillId: 'search-club',
      outcome: 'denied',
    });
    const allowed = await service.invoke(
      ask({ callerRoleIds: [CLUB_ROLE, SPECIAL_ROLE], invocationId: 'int-scope-2' }),
    );
    expect(allowed.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('an owner-scoped skill passes for the owner and is refused for a member', async () => {
    assistantRepo.setSkillScope(
      h.t.scopes.forGuild(GUILD),
      { skillId: 'search-club', mode: 'owner', roleIds: [] },
      NOW,
    );
    const generateText = vi.fn(async () => ({ text: 'done', model: 'model-a' }));
    const service = h.serviceWith(wrap(generateText));
    const refused = await service.invoke(ask({ invocationId: 'int-scope-owner-1' }));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.content).toBe(
      "You don't have access to that assistant skill. No action was taken.",
    );
    const allowed = await service.invoke(
      ask({ userId: OWNER, callerRoleIds: [], invocationId: 'int-scope-owner-2' }),
    );
    expect(allowed.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('the default scopes apply with no stored grant: reminders owner-only, search-club everyone', async () => {
    const generateText = vi.fn(async () => ({ text: 'done', model: 'model-a' }));
    const service = h.serviceWith(wrap(generateText));
    const search = await service.invoke(ask({ invocationId: 'int-scope-default-1' }));
    expect(search.ok).toBe(true);
    const remindInput = {
      when: new Date(NOW + 60_000).toISOString(),
      text: 'Bring batteries',
    };
    const memberRemind = await service.invoke(
      ask({ command: 'remind', input: remindInput, invocationId: 'int-scope-default-2' }),
    );
    expect(memberRemind.ok).toBe(false);
    expect(memberRemind.ok === false && memberRemind.content).toBe(
      "You don't have access to that assistant skill. No action was taken.",
    );
    const ownerRemind = await service.invoke(
      ask({
        command: 'remind',
        input: remindInput,
        userId: OWNER,
        callerRoleIds: [],
        invocationId: 'int-scope-default-3',
      }),
    );
    expect(ownerRemind.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('a skill outside the behaviour preference still runs when the scope allows (ADR 0087)', async () => {
    const generateText = vi.fn(async () => ({ text: 'done', model: 'model-a' }));
    const service = h.serviceWith(wrap(generateText));
    const result = await service.invoke(
      ask({
        behaviour: { ...h.direct, id: 'narrow', preferredSkillIds: ['search-club'] },
        command: 'remember',
        input: { request: 'remember this' },
        userId: OWNER,
        callerRoleIds: [],
        invocationId: 'int-scope-allowlist',
      }),
    );
    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('a behaviour whose preference lacks reminders shows the offered capability (ADR 0136)', async () => {
    const declared: string[][] = [];
    const systems: string[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        declared.push((req.tools ?? []).map((d) => d.name));
        systems.push(req.systemInstruction ?? '');
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = h.serviceWith(provider);
    const result = await service.invoke(
      ask({
        behaviour: { ...h.direct, id: 'narrow', preferredSkillIds: ['search-club'] },
        command: 'ask',
        input: { question: 'remind me later?' },
        userId: OWNER,
        callerRoleIds: [],
        invocationId: 'int-preference-regression',
      }),
    );
    expect(result.ok).toBe(true);
    expect(declared[0]).toContain('set_reminder');
    expect(systems[0]).toContain('Reminders and scheduled posts (');
  });

  const capture = () => {
    const requests: GenerateTextRequest[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        requests.push(req);
        return { text: 'done', model: 'model-a' };
      },
    };
    return { requests, provider };
  };

  it('names the asker as not allowed reminders and never names set_reminder for them (ADR 0136)', async () => {
    const { requests, provider } = capture();
    await h.serviceWith(provider).invoke(
      ask({
        input: { question: 'set a reminder for 5pm' },
        askerName: 'Kacey',
        invocationId: 'int-cap-1',
      }),
    );
    const system = requests[0]?.systemInstruction ?? '';
    expect(system).toContain('NOT AVAILABLE TO KACEY RIGHT NOW');
    expect(system).toContain('- Reminders: owner only');
    expect(system).not.toContain('set_reminder');
    expect((requests[0]?.tools ?? []).map((t) => t.name)).not.toContain('set_reminder');
  });

  it('lists set_reminder for the owner and puts the date in the NOW section', async () => {
    const { requests, provider } = capture();
    await h.serviceWith(provider).invoke(
      ask({
        userId: OWNER,
        callerRoleIds: [],
        input: { question: 'set a reminder for 5pm' },
        invocationId: 'int-cap-2',
      }),
    );
    const system = requests[0]?.systemInstruction ?? '';
    expect(system).toMatch(/- Reminders and scheduled posts \([^)]*set_reminder[^)]*\)/);
    expect(system).toMatch(/\nNOW\nIt is .+\.\n/);
    expect(system.indexOf('NOW\nIt is')).toBeLessThan(system.indexOf('WHAT YOU CAN DO RIGHT NOW'));
  });

  it('claims no tools when the provider cannot take tool calls', async () => {
    const requests: GenerateTextRequest[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text']),
      generateText: async (req) => {
        requests.push(req);
        return { text: 'done', model: 'model-a' };
      },
    };
    await h.serviceWith(provider).invoke(
      ask({
        userId: OWNER,
        callerRoleIds: [],
        input: { question: 'set a reminder for 5pm' },
        invocationId: 'int-cap-no-tools',
      }),
    );
    const system = requests[0]?.systemInstruction ?? '';
    expect(system).toContain(
      'No tools this turn. Answer from what you know; do not claim an action.',
    );
    expect(system).not.toContain('set_reminder');
    expect(requests[0]?.tools ?? []).toEqual([]);
  });

  it('adds the abilities line when the history holds an earlier bot reply', async () => {
    const { requests, provider } = capture();
    await h.serviceWith(provider).invoke(
      ask({
        userId: OWNER,
        callerRoleIds: [],
        askerName: 'Bryan',
        invocationId: 'int-cap-3',
        input: { question: 'set one up' },
        history: [
          { role: 'user', text: '[Kacey, 3 min ago] sleep reminder' },
          { role: 'assistant', text: 'reminders are owner-only' },
        ],
      }),
    );
    const last = requests[0]?.messages.at(-1)?.text ?? '';
    expect(last).toContain(
      'Your abilities for Bryan are exactly what WHAT YOU CAN DO RIGHT NOW lists.',
    );
  });

  it('a non-owner denied by owner scope gets a plain NOT AVAILABLE line (ADR 0136)', async () => {
    const declared: string[][] = [];
    const systems: string[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        declared.push((req.tools ?? []).map((d) => d.name));
        systems.push(req.systemInstruction ?? '');
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = h.serviceWith(provider);
    const result = await service.invoke(
      ask({
        behaviour: { ...h.direct, preferredSkillIds: [] },
        command: 'ask',
        input: { question: 'remind me later?' },
        invocationId: 'int-unavailable-owner',
      }),
    );
    expect(result.ok).toBe(true);
    expect(systems[0]).toContain('NOT AVAILABLE TO THIS MEMBER RIGHT NOW');
    expect(systems[0]).toContain('Reminders: owner only');
    for (const names of declared) expect(names).not.toContain('set_reminder');
  });

  it('a roles-scope denial names the fallback plainly without a directory port', async () => {
    assistantRepo.setSkillScope(
      h.t.scopes.forGuild(GUILD),
      { skillId: 'reminders', mode: 'roles', roleIds: [SPECIAL_ROLE] },
      NOW,
    );
    const declared: string[][] = [];
    const systems: string[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        declared.push((req.tools ?? []).map((d) => d.name));
        systems.push(req.systemInstruction ?? '');
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = h.serviceWith(provider);
    const result = await service.invoke(
      ask({
        behaviour: { ...h.direct, preferredSkillIds: [] },
        command: 'ask',
        input: { question: 'when is the meeting?' },
        invocationId: 'int-roles-scope',
      }),
    );
    expect(result.ok).toBe(true);
    expect(systems[0]).toContain('NOT AVAILABLE TO THIS MEMBER RIGHT NOW');
    expect(systems[0]).toContain('Reminders: only for certain roles');
    for (const names of declared) expect(names).not.toContain('set_reminder');
  });

  it('a roles-scope denial names the allowed roles when the port knows them', async () => {
    assistantRepo.setSkillScope(
      h.t.scopes.forGuild(GUILD),
      { skillId: 'reminders', mode: 'roles', roleIds: [SPECIAL_ROLE] },
      NOW,
    );
    const systems: string[] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        systems.push(req.systemInstruction ?? '');
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = h.serviceWith(provider, {
      memberChannels: async () => [],
      roleNames: () => new Map([[SPECIAL_ROLE, 'Robotics Leads']]),
    });
    const result = await service.invoke(
      ask({
        behaviour: { ...h.direct, preferredSkillIds: [] },
        command: 'ask',
        input: { question: 'when is the meeting?' },
        invocationId: 'int-roles-scope-named',
      }),
    );
    expect(result.ok).toBe(true);
    expect(systems[0]).toContain('NOT AVAILABLE TO THIS MEMBER RIGHT NOW');
    expect(systems[0]).toContain('Reminders: only for Robotics Leads');
  });
});

/**
 * B2b step 2: the acting tools' ports are wired in the service — the owner
 * flag, the scope gate, the invocation key, the current channel, the live
 * target resolver, the reminder store, draft proposals and activity records.
 * Try-it has no channel, so its reminder attempts fail in target resolution.
 */
describe('B2b: acting tool ports are wired', () => {
  const GUILD = B2B_GUILD;
  const MEMBER = B2B_MEMBER;
  const CHANNEL = B2B_CHANNEL;
  const CLUB_ROLE = B2B_CLUB_ROLE;
  const OWNER = B2B_OWNER;
  const NOW = B2B_NOW;

  let h: ReturnType<typeof setupB2b>;
  beforeEach(() => {
    h = setupB2b(['search-club', 'reminders', 'propose-memory']);
  });
  afterEach(() => h.t.close());

  const targetsOk = (seen: unknown[]) => ({
    memberChannels: async () => [],
    resolveReminderTargets: async (request: {
      readonly channel?: string | undefined;
      readonly members: readonly string[];
      readonly roles: readonly string[];
      readonly askerId: string;
      readonly currentChannelId: string;
    }) => {
      seen.push(request);
      return {
        ok: true as const,
        targets: {
          channelId: CHANNEL,
          channelName: 'general',
          mentions: { userIds: [], roleIds: [], everyone: false, here: false },
          memberNames: [],
          roleNames: [],
        },
      };
    },
  });

  it('set_reminder through chat writes via the wired store and records the activity', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'Reminder noted.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const service = h.serviceWith(provider, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-ports-1',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toContain('Reminder noted.');
    // The resolver saw the asker and the channel the request came from.
    expect(seen).toEqual([
      {
        channel: undefined,
        members: [],
        roles: [],
        askerId: OWNER,
        currentChannelId: CHANNEL,
      },
    ]);
    // The store closure added the guild scope; the key derives from the invocation and content.
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toMatchObject([
      {
        text: 'Bring batteries',
        creatorId: OWNER,
        destinationId: CHANNEL,
        dedupeKey: expect.stringContaining('reminder_int-ports-1_'),
      },
    ]);
    expect(
      assistantRepo
        .listSkillActivity(h.t.scopes.forGuild(GUILD), 10)
        .find((a) => a.skillId === 'reminders'),
    ).toMatchObject({ outcome: 'completed', actorId: OWNER });
  });

  it('a quoted request wires quotePresent: role pings refuse before resolution', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [
          { name: 'set_reminder', args: { text: 'Bring batteries', when, roles: ['Execs'] } },
        ],
      },
      { text: 'Noted.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const service = h.serviceWith(provider, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind the execs' },
      quoteEnvelope:
        '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
      source: 'slash-command',
      invocationId: 'int-ports-quote-1',
    });
    expect(result.ok).toBe(true);
    // The quote guard refused before target resolution, so nothing resolved or stored.
    expect(seen).toHaveLength(0);
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toHaveLength(0);
    expect(
      assistantRepo
        .listSkillActivity(h.t.scopes.forGuild(GUILD), 10)
        .find((a) => a.skillId === 'reminders'),
    ).toMatchObject({ outcome: 'denied', actorId: OWNER });
  });

  it('a continued turn whose history holds a quote still refuses role pings', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [
          { name: 'set_reminder', args: { text: 'Bring batteries', when, roles: ['everyone'] } },
        ],
      },
      { text: 'Noted.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const service = h.serviceWith(provider, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'ok, go ahead' },
      source: 'slash-command',
      invocationId: 'int-ports-quote-followup-1',
      history: [
        {
          role: 'user',
          text: '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
        },
      ],
      quoteInHistory: true,
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(0);
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toHaveLength(0);
    expect(
      assistantRepo
        .listSkillActivity(h.t.scopes.forGuild(GUILD), 10)
        .find((a) => a.skillId === 'reminders'),
    ).toMatchObject({ outcome: 'denied', actorId: OWNER });
  });

  it('a loop failure after an action still posts the confirmation', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    let calls = 0;
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        calls += 1;
        if (calls === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
          };
        throw new ProviderError('outage', 'HTTP 503', true);
      },
    };
    const seen: unknown[] = [];
    const service = h.serviceWith(failing, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-ports-fail-1',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toContain('Reminder set');
    expect(result.ok === true && result.content).toContain("couldn't finish the rest");
    expect(result.detail?.actions).toHaveLength(1);
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toHaveLength(1);
  });

  it('propose_memory through chat files a draft via the wired port', async () => {
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'propose_memory', args: { content: 'Prefers morning builds' } }],
      },
      { text: 'Filed.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const service = h.serviceWith(provider, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remember the build preference' },
      source: 'slash-command',
      invocationId: 'int-ports-2',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toContain('Filed.');
    expect(assistantRepo.listDecisions(h.t.scopes.forGuild(GUILD))).toMatchObject([
      {
        kind: 'memory',
        summary: 'Prefers morning builds',
        requesterId: OWNER,
        provenance: 'Assistant memory via chat; behaviour=direct',
      },
    ]);
  });

  const ACTING_TOOLS = [
    'set_reminder',
    'edit_reminder',
    'cancel_reminder',
    'my_reminders',
    'propose_memory',
    'propose_decision',
  ];

  it('try-it never acts: set_reminder is undeclared and nothing is stored', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const declared: string[][] = [];
    const seen: { messages: readonly unknown[] }[] = [];
    const queue: GenerateTextResponse[] = [
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'Here is what I would do.', model: 'model-a' },
    ];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        declared.push((req.tools ?? []).map((d) => d.name));
        seen.push({ messages: req.messages });
        const next = queue.shift();
        if (next === undefined) throw new Error('no scripted response');
        return next;
      },
    };
    const service = h.serviceWith(provider, { memberChannels: async () => [] });
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'remind me to bring batteries',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Here is what I would do.');
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toEqual([]);
    expect(assistantRepo.listDecisions(h.t.scopes.forGuild(GUILD))).toEqual([]);
    // No acting tool is offered to the model...
    for (const names of declared)
      for (const name of ACTING_TOOLS) expect(names).not.toContain(name);
    // ...and the call the model makes anyway is refused in code.
    const toolTexts = (seen[1]?.messages as readonly { role: string; text: string }[])
      .filter((m) => m.role === 'tool')
      .map((m) => m.text);
    expect(toolTexts[0]).toContain(
      "This member isn't allowed to use that. Tell them plainly; don't retry.",
    );
  });

  it('an invocation without an id declares no acting tool', async () => {
    const declared: string[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        declared.push((req.tools ?? []).map((d) => d.name));
        return { text: 'Hi.', model: 'model-a' };
      },
    };
    const service = h.serviceWith(provider, { memberChannels: async () => [] });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'hi' },
      source: 'slash-command',
    });
    expect(result.ok).toBe(true);
    expect(declared).toHaveLength(1);
    for (const name of ACTING_TOOLS) expect(declared[0]).not.toContain(name);
    // Read-only tools are still offered.
    expect(declared[0]).toContain('search_archive');
  });

  it('a member refused by the scope cannot act even when the model tries', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'I could not set it.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const service = h.serviceWith(provider, targetsOk(seen));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-ports-3',
    });
    // `ask` itself is allowed, but `reminders` is owner-scoped by default, so
    // the tool refuses before target resolution — and nothing is stored.
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toBe('I could not set it.');
    expect(seen).toEqual([]);
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toEqual([]);
    expect(
      assistantRepo
        .listSkillActivity(h.t.scopes.forGuild(GUILD), 10)
        .find((a) => a.skillId === 'reminders'),
    ).toMatchObject({ outcome: 'denied', actorId: MEMBER });
  });

  it('a reminder stored in one guild is invisible to another (hard rule 2)', async () => {
    const GUILD_B = parseGuildId('345678901234567891');
    guildRepo.upsertGuild(h.t.scopes.forGuild(GUILD_B), { name: 'other', now: NOW });
    const when = new Date(NOW + 3_600_000).toISOString();
    const writer = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'Reminder noted.', model: 'model-a' },
    ]);
    const seen: unknown[] = [];
    const serviceA = h.serviceWith(writer, targetsOk(seen));
    const stored = await serviceA.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-iso-a',
    });
    expect(stored.ok).toBe(true);
    const reminderId = assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))[0]?.id;
    expect(reminderId).toMatch(/^rem_int-iso-a_[0-9a-f]{64}$/);
    // From guild B the same id is unknown: get (via edit), listForCreator
    // and listAll (via my_reminders) see nothing, and update and cancel fail.
    const toolTexts: (readonly string[])[] = [];
    const probing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: (() => {
        let round = 0;
        return async (req: Parameters<TextProvider['generateText']>[0]) => {
          toolTexts.push(
            (req.messages as readonly { role: string; text: string }[])
              .filter((m) => m.role === 'tool')
              .map((m) => m.text),
          );
          round += 1;
          if (round === 1)
            return {
              text: '',
              model: 'model-a',
              toolCalls: [
                { name: 'edit_reminder', args: { reminderId, text: 'Changed' } },
                { name: 'cancel_reminder', args: { reminderId } },
                { name: 'my_reminders', args: {} },
                { name: 'my_reminders', args: { all: true } },
              ],
            };
          return { text: 'Checked.', model: 'model-a' };
        };
      })(),
    };
    const probingService = createAssistantService(
      h.t.scopes.forGuild(GUILD_B),
      h.t.scopes.instance(),
      B2B_CONFIG,
      () => B2B_NOW,
      {},
      undefined,
      undefined,
      { memberChannels: async () => [] },
      () => [h.usable(probing)],
    );
    const checked = await probingService.invoke({
      guildId: GUILD_B,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: { ...h.direct, guildId: GUILD_B },
      command: 'ask',
      input: { question: 'edit, cancel and list that reminder' },
      source: 'slash-command',
      invocationId: 'int-iso-c',
    });
    expect(checked.ok).toBe(true);
    const answers = toolTexts.at(-1) ?? [];
    expect(answers[0]).toContain('No reminder has that id');
    expect(answers[1]).toContain('No reminder has that id');
    expect(answers[2]).toContain('No upcoming reminders.');
    expect(answers[3]).toContain('No upcoming reminders.');
    // Guild A's row is untouched: still scheduled, still exactly one.
    expect(assistantRepo.listReminders(h.t.scopes.forGuild(GUILD))).toMatchObject([
      { text: 'Bring batteries', status: 'scheduled' },
    ]);
  });
});

/**
 * B2b step 3: code-written action summaries are appended to the posted
 * answer — after the answer text, before the Brave attribution and the
 * Sources line — and recorded on the trace detail as `actions`.
 */
describe('B2b: action summaries in answers', () => {
  const GUILD = B2B_GUILD;
  const CHANNEL = B2B_CHANNEL;
  const OWNER = B2B_OWNER;
  const NOW = B2B_NOW;

  let h: ReturnType<typeof setupB2b>;
  beforeEach(() => {
    h = setupB2b(['search-club', 'reminders']);
  });
  afterEach(() => h.t.close());

  const targetsOk = () => ({
    memberChannels: async () => [],
    resolveReminderTargets: async () => ({
      ok: true as const,
      targets: {
        channelId: CHANNEL,
        channelName: 'general',
        mentions: { userIds: [], roleIds: [], everyone: false, here: false },
        memberNames: [],
        roleNames: [],
      },
    }),
  });

  const actionsOf = (result: { detail?: AssistantTraceDetail | undefined }): readonly string[] =>
    result.detail?.actions ?? [];

  it('the posted answer ends with the summary and the trace records it', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'All set.', model: 'model-a' },
    ]);
    const service = h.serviceWith(provider, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-summary-1',
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.toolsOffered).toContain('set_reminder');
    const actions = actionsOf(result);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain('✅ Reminder set: **Bring batteries**');
    expect(result.ok === true && result.content).toBe(`All set.\n\n${actions[0]}`);
  });

  it('the Sources line follows the summary when there is one', async () => {
    assistantRepo.putResource(h.t.scopes.forGuild(GUILD), {
      id: 'club-guide',
      guildId: GUILD,
      title: 'Club Guide',
      url: 'https://example.com/guide',
      kind: 'discord-channel',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    const when = new Date(NOW + 3_600_000).toISOString();
    const provider = h.scripted([
      {
        text: '',
        model: 'model-a',
        toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
      },
      { text: 'See the guide. [S1]', model: 'model-a' },
    ]);
    const service = h.serviceWith(provider, targetsOk(), {
      cacheSearch: () => [
        {
          resourceId: 'club-guide',
          chunkId: 'c_guide_0',
          docId: 'd_guide',
          headingPath: '',
          snippet: 'the guide says Friday',
        },
      ],
    });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'what does the guide say; remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-summary-2',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    const actions = actionsOf(result);
    expect(actions).toHaveLength(1);
    expect(content).toBe(`See the guide.\n\n${actions[0]}\n\n-# Sources: Club Guide`);
  });

  it('records included with the pre-retrieved chunks, quote flag and history turns', async () => {
    const provider = h.scripted([{ text: 'Done.', model: 'model-a' }]);
    const service = h.serviceWith(provider, targetsOk(), {
      cacheSearch: () => [
        {
          resourceId: 'club-guide',
          chunkId: 'c_guide_0',
          docId: 'd_guide',
          headingPath: '',
          snippet: 'the guide says Friday',
        },
        {
          resourceId: 'club-guide',
          chunkId: 'c_guide_1',
          docId: 'd_guide',
          headingPath: '',
          snippet: 'the guide says Saturday',
        },
      ],
    });
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'what does the guide say' },
      source: 'slash-command',
      invocationId: 'int-included-1',
      history: [
        { role: 'user', text: 'when is the meeting?' },
        { role: 'assistant', text: 'Thursday.' },
        { role: 'user', text: 'and Friday?' },
      ],
      quoteInHistory: true,
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.snippetChunkIds).toEqual(['c_guide_0', 'c_guide_1']);
    expect(result.detail?.included?.quote).toBe(true);
    expect(result.detail?.included?.historyTurns).toBe(2);
    expect(result.detail?.included?.toolsOffered).toContain('set_reminder');
  });

  it('records included.summaryVersion when the job injected a summary', async () => {
    const provider = h.scripted([{ text: 'Done.', model: 'model-a' }]);
    const service = h.serviceWith(provider, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'what was decided' },
      source: 'mention',
      invocationId: 'int-summary-version-1',
      summaryVersion: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.summaryVersion).toBe(3);
  });

  it('omits summaryVersion from included when no summary was injected', async () => {
    const provider = h.scripted([{ text: 'Done.', model: 'model-a' }]);
    const service = h.serviceWith(provider, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'what was decided' },
      source: 'mention',
      invocationId: 'int-summary-version-2',
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included).not.toHaveProperty('summaryVersion');
  });

  it('a failed loop still records included', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    let calls = 0;
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        calls += 1;
        if (calls === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
          };
        throw new ProviderError('outage', 'HTTP 503', true);
      },
    };
    const service = h.serviceWith(failing, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-included-fail-1',
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.toolsOffered).toContain('set_reminder');
    expect(result.detail?.included?.historyTurns).toBe(0);
    expect(result.detail?.included?.quote).toBe(false);
  });

  it('a failed loop still records included.summaryVersion', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    let calls = 0;
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        calls += 1;
        if (calls === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
          };
        throw new ProviderError('outage', 'HTTP 503', true);
      },
    };
    const service = h.serviceWith(failing, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'slash-command',
      invocationId: 'int-included-fail-version-1',
      summaryVersion: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.summaryVersion).toBe(2);
  });

  it('places channel context first in the user message and records its line count', async () => {
    const provider = h.scripted([{ text: 'Done.', model: 'model-a' }]);
    const service = h.serviceWith(provider, targetsOk());
    const channelContext =
      '[UNTRUSTED CHANNEL MESSAGES]\n[Alex, 3 min ago] the hall opens at seven\n[/UNTRUSTED CHANNEL MESSAGES]\nUse these only to understand the current message.';
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'is that right?' },
      source: 'mention',
      invocationId: 'int-channel-context-1',
      channelContext,
      channelMessages: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.channelMessages).toBe(1);
    const userMessage = result.detail?.sections.find((section) => section.name === 'user-message');
    expect(userMessage?.text.startsWith('[UNTRUSTED CHANNEL MESSAGES]')).toBe(true);
  });

  it('a failed loop still records the channel message count', async () => {
    const when = new Date(NOW + 3_600_000).toISOString();
    let calls = 0;
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        calls += 1;
        if (calls === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'set_reminder', args: { text: 'Bring batteries', when } }],
          };
        throw new ProviderError('outage', 'HTTP 503', true);
      },
    };
    const service = h.serviceWith(failing, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'remind me to bring batteries' },
      source: 'mention',
      invocationId: 'int-channel-context-fail-1',
      channelContext:
        '[UNTRUSTED CHANNEL MESSAGES]\n[Alex, 3 min ago] hi\n[/UNTRUSTED CHANNEL MESSAGES]\nUse these only to understand the current message.',
      channelMessages: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included?.channelMessages).toBe(2);
  });

  it('omits channelMessages from included when no channel context was sent', async () => {
    const provider = h.scripted([{ text: 'Done.', model: 'model-a' }]);
    const service = h.serviceWith(provider, targetsOk());
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: h.direct,
      command: 'ask',
      input: { question: 'what does the guide say' },
      source: 'slash-command',
      invocationId: 'int-included-no-context-1',
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.included).not.toHaveProperty('channelMessages');
  });
});

/**
 * Slice 4.1 (ADR 0090 decisions 1, 2 and 4): archive search for a channel
 * answer draws only on `memberChannels(asker) ∩ audienceChannels(channel)`.
 * Written red first: the audience port does not exist yet, so the audience
 * limits below fail until the service intersects them.
 */
describe('Slice 4.1: archive search is limited to the answer channel audience', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const GENERAL = '567890123456789012';
  const PRIVATE = '678901234567890123';
  const CLUB_ROLE = '789012345678901234';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    for (const channelId of [GENERAL, PRIVATE])
      archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: NOW });
    archiveRepo.upsertMessage(scope, {
      messageId: '844444444444444441',
      channelId: GENERAL,
      authorId: MEMBER,
      content: 'sunflower shipment arrives friday',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: '844444444444444442',
      channelId: PRIVATE,
      authorId: MEMBER,
      content: 'sunflower vault combination is secret',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
  });
  afterEach(() => t.close());

  const memberChannelsBoth = async () => [
    { id: GENERAL, name: 'general' },
    { id: PRIVATE, name: 'private' },
  ];

  const serviceWithDiscord = (
    discord: Parameters<typeof createAssistantService>[7],
    chain: Parameters<typeof createAssistantService>[8] = () => [],
  ) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      discord,
      chain,
    );

  const findIn = (
    channelId: string,
    discord: Parameters<typeof createAssistantService>[7],
    invocationId: string,
  ) =>
    serviceWithDiscord(discord).invoke({
      guildId: GUILD,
      channelId,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'find',
      input: { query: 'sunflower' },
      source: 'slash-command',
      invocationId,
    });

  it('an asker who can read #private asks in #general: no #private hits', async () => {
    const result = await findIn(
      GENERAL,
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
      },
      'int-aud-general',
    );
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain('shipment');
    expect(content).not.toContain('vault');
  });

  it('the same question asked inside #private reaches #private', async () => {
    const result = await findIn(
      PRIVATE,
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([PRIVATE]),
      },
      'int-aud-private',
    );
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain('vault');
    expect(content).not.toContain('shipment');
  });

  it('a missing audience port fails closed when a channel is set', async () => {
    const result = await findIn(GENERAL, { memberChannels: memberChannelsBoth }, 'int-aud-closed');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toBe(
      'No matching messages in the channels you can see.',
    );
  });

  it('Try it (no channel) keeps the asker-only filter', async () => {
    const seen: { role: string; text: string }[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        seen.push([...request.messages]);
        return seen.length === 1
          ? {
              text: '',
              model: 'model-a',
              toolCalls: [{ name: 'search_archive', args: { query: 'sunflower' } }],
            }
          : { text: 'Both mention sunflowers.', model: 'model-a' };
      }),
    };
    const service = serviceWithDiscord(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
      },
      () => [
        {
          providerId: 'gemini',
          model: 'model-a',
          keyId: 'key_a',
          keyLabel: 'Key A',
          provider,
          skip: undefined,
          mayTrain: false,
          rpmLimit: null,
          rpdLimit: null,
        },
      ],
    );
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'any sunflower news?',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Both mention sunflowers.');
    const toolTurn = seen[1]?.find((message) => message.role === 'tool');
    expect(toolTurn?.text).toContain('shipment');
    expect(toolTurn?.text).toContain('vault');
  });
});

/**
 * Slice 4.2 (ADR 0090 decision 3): "Did X say Y?" resolves `from` to one
 * member in code, answers yes or no with a code-issued message link, and has
 * no tool path for bulk member summaries. Written red first: `search_archive`
 * takes no `from` argument yet, so every `from` call below is refused.
 */
describe('Slice 4.2: Did X say Y resolves from to one member with code-issued links', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const AVA = '777777777777777777';
  const BOB = '888888888888888888';
  const GENERAL = '567890123456789012';
  const PRIVATE = '678901234567890123';
  const CLUB_ROLE = '789012345678901234';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;
  const AVA_MSG = '844444444444444441';
  const BOB_MSG = '844444444444444442';
  const AVA_PRIVATE_MSG = '844444444444444443';
  const AVA_LINK = `https://discord.com/channels/${GUILD}/${GENERAL}/${AVA_MSG}`;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
    for (const channelId of [GENERAL, PRIVATE])
      archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: NOW });
    archiveRepo.upsertMessage(scope, {
      messageId: AVA_MSG,
      channelId: GENERAL,
      authorId: AVA,
      content: 'sunflower shipment arrives friday',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: BOB_MSG,
      channelId: GENERAL,
      authorId: BOB,
      content: 'sunflower sprouts are tasty',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: AVA_PRIVATE_MSG,
      channelId: PRIVATE,
      authorId: AVA,
      content: 'sunflower vault combination is secret',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
  });
  afterEach(() => t.close());

  const discordBase = {
    memberChannels: async () => [
      { id: GENERAL, name: 'general' },
      { id: PRIVATE, name: 'private' },
    ],
    audienceChannels: async () => new Set([GENERAL]),
  };

  /** A provider that makes one scripted tool call, then answers; every request is captured. */
  const scripted = (
    seen: { role: string; text: string }[][],
    toolCall: { name: string; args: Record<string, unknown> },
    answer: string,
  ): TextProvider => {
    let round = 0;
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        seen.push([...request.messages]);
        round += 1;
        if (round === 1) return { text: '', model: 'model-a', toolCalls: [toolCall] };
        return { text: answer, model: 'model-a' };
      }),
    };
  };

  const serviceWithPorts = (
    discord: Parameters<typeof createAssistantService>[7],
    provider: TextProvider,
  ) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      discord,
      () => [
        {
          providerId: 'gemini',
          model: 'model-a',
          keyId: 'key_a',
          keyLabel: 'Key A',
          provider,
          skip: undefined,
          mayTrain: false,
          rpmLimit: null,
          rpdLimit: null,
        },
      ],
    );

  const ask = (
    discord: Parameters<typeof createAssistantService>[7],
    provider: TextProvider,
    invocationId: string,
  ) =>
    serviceWithPorts(discord, provider).invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'did Ava mention the sunflower shipment?' },
      source: 'slash-command',
      invocationId,
    });

  const toolTurnOf = (seen: { role: string; text: string }[][]): string =>
    seen[1]?.find((message) => message.role === 'tool')?.text ?? '';

  const fromCall = (
    query: string,
    from: string,
  ): { name: string; args: Record<string, unknown> } => ({
    name: 'search_archive',
    args: { query, from },
  });

  it('an exact display-name match answers from that member, inside the audience, with a code link', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      {
        ...discordBase,
        findMember: async () => [
          { id: AVA, displayName: 'Ava' },
          { id: BOB, displayName: 'Ava Banana' },
        ],
      },
      scripted(seen, fromCall('sunflower', 'Ava'), 'Yes, they did. [S1]'),
      'int-from-exact',
    );
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain(AVA_LINK);
    expect(content).toContain('-# Sources:');
    expect(content).not.toContain(BOB_MSG);
    expect(content).not.toContain(AVA_PRIVATE_MSG);
    expect(toolTurnOf(seen)).toContain('Answer only whether they said it.');
  });

  it('an ambiguous name refuses without searching', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      {
        ...discordBase,
        findMember: async () => [
          { id: AVA, displayName: 'Ava' },
          { id: BOB, displayName: 'Ava Banana' },
        ],
      },
      scripted(seen, fromCall('sunflower', 'Av'), 'No answer either way.'),
      'int-from-ambiguous',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).toContain("I couldn't tell which member you meant.");
    expect(toolTurnOf(seen)).not.toContain('Answer only whether they said it.');
  });

  it('an unknown name refuses', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      { ...discordBase, findMember: async () => [] },
      scripted(seen, fromCall('sunflower', 'Zed'), 'No answer either way.'),
      'int-from-unknown',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).toContain("I couldn't tell which member you meant.");
  });

  it('a missing findMember port refuses', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      discordBase,
      scripted(seen, fromCall('sunflower', 'Ava'), 'No answer either way.'),
      'int-from-no-port',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).toContain("I couldn't tell which member you meant.");
  });

  it('from without a query word refuses before any member lookup', async () => {
    const seen: { role: string; text: string }[][] = [];
    const findMember = vi.fn(async () => [{ id: AVA, displayName: 'Ava' }]);
    const result = await ask(
      { ...discordBase, findMember },
      scripted(seen, fromCall('hi', 'Ava'), 'No answer either way.'),
      'int-from-no-word',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).toContain('Say what you want to check they said.');
    expect(findMember).not.toHaveBeenCalled();
  });

  it('an uncited hit adds no link', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      {
        ...discordBase,
        findMember: async () => [{ id: AVA, displayName: 'Ava' }],
      },
      scripted(seen, fromCall('sunflower', 'Ava'), 'Yes, they mentioned it.'),
      'int-from-uncited',
    );
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).not.toContain('-# Sources:');
    expect(content).not.toContain('discord.com');
  });

  it('a model-written discord URL is never added to Sources', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      {
        ...discordBase,
        findMember: async () => [{ id: AVA, displayName: 'Ava' }],
      },
      scripted(
        seen,
        fromCall('sunflower', 'Ava'),
        'Yes, see https://discord.com/channels/1/2/3 for proof.',
      ),
      'int-from-model-url',
    );
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain('https://discord.com/channels/1/2/3');
    expect(content).not.toContain('-# Sources:');
  });
});

/**
 * Slice 6.1 (ADR 0092 decisions 1–2): `upcoming_events` lists Discord
 * scheduled events and channel reminders in the answer channel's audience;
 * `channel_history` pages back through the Discord port. Written red first:
 * the tool ports, the service wiring and the Discord port do not exist yet.
 */
describe('Slice 6.1: upcoming_events and channel_history', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const GENERAL = '567890123456789012';
  const PRIVATE = '678901234567890123';
  const CLUB_ROLE = '789012345678901234';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;
  const OLDEST = '820000000000000001';
  const OLDER = '810000000000000001';
  const OLDER_STILL = '800000000000000001';

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  type DiscordPorts = Parameters<typeof createAssistantService>[7];
  const memberChannelsBoth = async () => [
    { id: GENERAL, name: 'general' },
    { id: PRIVATE, name: 'private' },
  ];

  const chainOf = (provider: TextProvider) => () => [
    {
      providerId: 'gemini' as const,
      model: 'model-a',
      keyId: 'key_a',
      keyLabel: 'Key A',
      provider,
      skip: undefined,
      mayTrain: false,
      rpmLimit: null,
      rpdLimit: null,
    },
  ];

  const serviceWith = (
    discord: DiscordPorts,
    provider: TextProvider,
    windowMessages = 0,
    configOver = config,
  ) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      configOver,
      () => NOW,
      {},
      undefined,
      undefined,
      discord,
      chainOf(provider),
      undefined,
      undefined,
      () => windowMessages,
    );

  /** A provider that makes the scripted tool calls in order, then answers. */
  const scriptedCalls = (
    seen: { role: string; text: string }[][],
    calls: { name: string; args: Record<string, unknown> }[],
    answer: string,
  ): TextProvider => {
    let round = 0;
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        seen.push([...request.messages]);
        round += 1;
        const call = calls[round - 1];
        if (call !== undefined) return { text: '', model: 'model-a', toolCalls: [call] };
        return { text: answer, model: 'model-a' };
      }),
    };
  };

  const askIn = (
    discord: DiscordPorts,
    provider: TextProvider,
    invocationId: string,
    over: { channelId?: string; channelContextOldestId?: string; windowMessages?: number } = {},
  ) =>
    serviceWith(discord, provider, over.windowMessages ?? 15).invoke({
      guildId: GUILD,
      channelId: over.channelId ?? GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: "when's the meeting?" },
      source: 'slash-command',
      invocationId,
      ...(over.channelContextOldestId === undefined
        ? {}
        : { channelContextOldestId: over.channelContextOldestId }),
    });

  const toolTurn = (seen: { role: string; text: string }[][], round: number): string =>
    seen[round]?.filter((message) => message.role === 'tool').at(-1)?.text ?? '';

  const scheduledEvent = (
    over: {
      readonly id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly scheduledStartAt?: number;
      readonly channelId?: string;
      readonly location?: string;
    } = {},
  ): {
    readonly id: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly scheduledStartAt: number;
    readonly channelId?: string | undefined;
    readonly location?: string | undefined;
  } => ({
    id: over.id ?? '777777777777777771',
    name: over.name ?? 'Build night',
    ...(over.description === undefined ? {} : { description: over.description }),
    scheduledStartAt: over.scheduledStartAt ?? NOW + 3_600_000,
    ...(over.channelId === undefined ? {} : { channelId: over.channelId }),
    ...(over.location === undefined ? {} : { location: over.location }),
  });

  const channelReminder = (over: {
    id: string;
    destinationId: string;
    text: string;
    dueAt?: number;
    creatorId?: string;
  }) =>
    assistantRepo.insertReminder(t.scopes.forGuild(GUILD), {
      id: over.id,
      guildId: GUILD,
      creatorId: over.creatorId ?? MEMBER,
      destinationId: over.destinationId,
      text: over.text,
      dueAt: over.dueAt ?? NOW + 7_200_000,
      createdAt: NOW,
      status: 'scheduled',
      dedupeKey: `dedupe:${over.id}`,
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: 0,
    });

  it('an event in a private channel is not listed for an answer in a public channel', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await askIn(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        listScheduledEvents: async () => [
          scheduledEvent({ id: '777777777777777771', name: 'Build night', channelId: GENERAL }),
          scheduledEvent({
            id: '777777777777777772',
            name: 'Secret build',
            channelId: PRIVATE,
            scheduledStartAt: NOW + 7_200_000,
          }),
        ],
      },
      scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Build night is on.'),
      'int-ev-private',
    );
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).toContain('Build night');
    expect(toolTurn(seen, 1)).not.toContain('Secret build');
  });

  it('an external event is listed', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await askIn(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        listScheduledEvents: async () => [
          scheduledEvent({
            id: '777777777777777773',
            name: 'Track day',
            location: 'Mission Raceway',
            scheduledStartAt: NOW + 7_200_000,
          }),
        ],
      },
      scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Track day is on.'),
      'int-ev-external',
    );
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).toContain('Track day');
    expect(toolTurn(seen, 1)).toContain('Mission Raceway');
  });

  it('a personal reminder is never listed', async () => {
    channelReminder({ id: 'personal', destinationId: MEMBER, text: 'Renew my own membership' });
    const seen: { role: string; text: string }[][] = [];
    const result = await askIn(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL, PRIVATE]),
        listScheduledEvents: async () => [],
      },
      scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Nothing on.'),
      'int-ev-personal',
    );
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).not.toContain('Renew my own membership');
    expect(toolTurn(seen, 1)).toContain('Nothing scheduled in the next 30 days.');
  });

  it('a channel reminder posts in the audience, one outside it does not', async () => {
    channelReminder({ id: 'open', destinationId: GENERAL, text: 'Bring cones to general' });
    channelReminder({ id: 'closed', destinationId: PRIVATE, text: 'Vault rota' });
    const seen: { role: string; text: string }[][] = [];
    const result = await askIn(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        listScheduledEvents: async () => [],
      },
      scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Cones it is.'),
      'int-ev-audience',
    );
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).toContain('Bring cones to general');
    expect(toolTurn(seen, 1)).not.toContain('Vault rota');
  });

  it('the club time zone reaches the upcoming_events lines', async () => {
    const auckland = parseConfig({
      DISCORD_BOT_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      BANANASAURS_GUILD_ALLOWLIST: GUILD,
      BANANASAURS_OWNER_USER_ID: OWNER,
      BANANASAURS_TIME_ZONE: 'Pacific/Auckland',
      AI_PROVIDER: 'off',
      AI_MODEL: 'fixture-model',
      AI_PROFILE_COST_CLASS: 'free',
    });
    const seen: { role: string; text: string }[][] = [];
    const provider = scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Soon.');
    const service = serviceWith(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        listScheduledEvents: async () => [scheduledEvent({ channelId: GENERAL })],
      },
      provider,
      0,
      auckland,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: "when's the meeting?" },
      source: 'slash-command',
      invocationId: 'int-ev-tz',
    });
    expect(result.ok).toBe(true);
    // 09:00 UTC is 22:00 the same day in Auckland (NZDT, UTC+13) — and 01:00
    // in Vancouver, so the time itself proves which zone formatted the line.
    expect(toolTurn(seen, 1)).toContain('22:00');
  });

  it('channel_history pages from the channel-context oldest id, then with a returned handle', async () => {
    const page = (id: string, content: string) => ({
      messageId: id,
      authorId: MEMBER,
      authorName: 'Ana',
      authorIsBot: false,
      content,
      at: NOW - 60_000,
      hasAttachments: false,
    });
    const fetchChannelMessages = vi.fn(
      async (_channelId: string, opts: { before: string; limit: number }) => {
        if (opts.before === OLDEST)
          return [page(OLDER, 'older line'), page('830000000000000001', 'newer line')];
        if (opts.before === OLDER) return [page(OLDER_STILL, 'older still')];
        return [];
      },
    );
    const seen: { role: string; text: string }[][] = [];
    const result = await askIn(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        fetchChannelMessages,
      },
      scriptedCalls(
        seen,
        [
          { name: 'channel_history', args: {} },
          { name: 'channel_history', args: { before: OLDER } },
        ],
        'Here is the history.',
      ),
      'int-ch-pages',
      { channelContextOldestId: OLDEST },
    );
    expect(result.ok).toBe(true);
    expect(fetchChannelMessages).toHaveBeenNthCalledWith(1, GENERAL, { before: OLDEST, limit: 20 });
    expect(fetchChannelMessages).toHaveBeenNthCalledWith(2, GENERAL, { before: OLDER, limit: 20 });
    expect(toolTurn(seen, 1)).toContain('older line');
    expect(toolTurn(seen, 1)).toContain(`Older: before=${OLDER}`);
    expect(toolTurn(seen, 2)).toContain('older still');
    expect(toolTurn(seen, 2)).toContain(`Older: before=${OLDER_STILL}`);
  });

  it('neither tool is declared when its port is absent', async () => {
    const offered: string[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        offered.push((request.tools ?? []).map((tool) => tool.name));
        return { text: 'No tools needed.', model: 'model-a' };
      }),
    };
    const result = await askIn({ memberChannels: memberChannelsBoth }, provider, 'int-hidden', {
      windowMessages: 0,
    });
    expect(result.ok).toBe(true);
    expect(offered[0]).not.toContain('channel_history');
    expect(offered[0]).not.toContain('upcoming_events');
    expect(offered[0]).toContain('search_archive');
  });

  it('channel_history is not offered without a channel, but upcoming_events is', async () => {
    const offered: string[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        offered.push((request.tools ?? []).map((tool) => tool.name));
        return { text: 'No tools needed.', model: 'model-a' };
      }),
    };
    const service = serviceWith(
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        listScheduledEvents: async () => [],
        fetchChannelMessages: async () => [],
      },
      provider,
      15,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: undefined,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: "when's the meeting?" },
      source: 'slash-command',
      invocationId: 'int-no-channel',
    });
    expect(result.ok).toBe(true);
    expect(offered[0]).not.toContain('channel_history');
    expect(offered[0]).toContain('upcoming_events');
  });

  it('Try it lists external events and member-readable reminders, but no channel events', async () => {
    channelReminder({ id: 'try-open', destinationId: GENERAL, text: 'Bring cones' });
    const seen: { role: string; text: string }[][] = [];
    const service = serviceWith(
      {
        memberChannels: async () => [{ id: GENERAL, name: 'general' }],
        listScheduledEvents: async () => [
          scheduledEvent({ id: '777777777777777771', name: 'Build night', channelId: GENERAL }),
          scheduledEvent({
            id: '777777777777777773',
            name: 'Track day',
            location: 'Mission Raceway',
            scheduledStartAt: NOW + 7_200_000,
          }),
        ],
      },
      scriptedCalls(seen, [{ name: 'upcoming_events', args: {} }], 'Track day and cones.'),
      0,
    );
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: "when's the meeting?",
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Track day and cones.');
    expect(toolTurn(seen, 1)).toContain('Track day');
    expect(toolTurn(seen, 1)).toContain('Bring cones');
    expect(toolTurn(seen, 1)).not.toContain('Build night');
  });

  /** ADR 0126: Read gates the live `channel_history` tool. */
  const accessWith = (readAllowed: boolean, seenChecks: string[]): ChannelAccess => ({
    check: async (purpose, channelId) => {
      seenChecks.push(`${purpose}:${channelId}`);
      return readAllowed || purpose !== 'read'
        ? { allowed: true, grantedBy: GENERAL }
        : { allowed: false, reason: 'not-granted' };
    },
    canSearchArchived: async () => true,
    isNoAccess: async () => false,
  });

  const serviceWithAccess = (access: ChannelAccess, provider: TextProvider) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      {
        memberChannels: memberChannelsBoth,
        audienceChannels: async () => new Set([GENERAL]),
        fetchChannelMessages: async () => [],
      },
      chainOf(provider),
      undefined,
      undefined,
      () => 15,
      access,
    );

  const offeredOf = (): { offered: string[][]; provider: TextProvider } => {
    const offered: string[][] = [];
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        offered.push((request.tools ?? []).map((tool) => tool.name));
        return { text: 'No tools needed.', model: 'model-a' };
      }),
    };
    return { offered, provider };
  };

  const askGeneral = (service: ReturnType<typeof serviceWithAccess>, invocationId: string) =>
    service.invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: "when's the meeting?" },
      source: 'slash-command',
      invocationId,
    });

  it('channel_history is not declared when Read is denied', async () => {
    const { offered, provider } = offeredOf();
    const seenChecks: string[] = [];
    const result = await askGeneral(
      serviceWithAccess(accessWith(false, seenChecks), provider),
      'int-ch-denied',
    );
    expect(result.ok).toBe(true);
    expect(offered[0]).not.toContain('channel_history');
    expect(seenChecks).toContain(`read:${GENERAL}`);
  });

  it('channel_history is declared when Read is allowed', async () => {
    const { offered, provider } = offeredOf();
    const seenChecks: string[] = [];
    const result = await askGeneral(
      serviceWithAccess(accessWith(true, seenChecks), provider),
      'int-ch-allowed',
    );
    expect(result.ok).toBe(true);
    expect(offered[0]).toContain('channel_history');
    expect(seenChecks).toContain(`read:${GENERAL}`);
  });
});

/**
 * Slice 7: cross-conversation recall (ADR 0093). Written red first: the
 * `searchConversations` port, the invocation `conversationId` and the
 * detail `recalled` field do not exist yet.
 */
describe('Slice 7: search_conversations recall is audience-filtered and aggregated', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const GENERAL = '567890123456789012';
  const PRIVATE = '678901234567890123';
  const CLUB_ROLE = '789012345678901234';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    const seed = (
      conversationId: string,
      channelId: string,
      at: number,
      topic: string,
      fact: string,
    ): void => {
      conversationRepo.createConversation(scope, {
        conversationId,
        channelId,
        behaviourId: 'direct',
        startedBy: MEMBER,
        title: topic,
        source: 'discord',
        at,
      });
      conversationRepo.writeSummaryIfNewer(scope, {
        conversationId,
        summary: {
          topic,
          facts: [{ text: fact, from: 'member' }],
          botClaims: ['The bot guessed the gearbox size'],
          openQuestions: [],
          commitments: [{ who: 'Ama', what: 'bring grease' }],
          participants: ['Ama'],
        },
        throughAt: at,
        now: at + 1,
      });
    };
    seed('conv-general', GENERAL, NOW - 3_600_000, 'robot arm gearbox', 'The gearbox needs grease');
    seed('conv-private', PRIVATE, NOW - 1_800_000, 'robot arm gripper', 'The gripper needs oil');
    seed('conv-current', GENERAL, NOW - 900_000, 'robot arm wiring', 'The wiring needs tape');
  });
  afterEach(() => t.close());

  const memberChannelsBoth = async () => [
    { id: GENERAL, name: 'general' },
    { id: PRIVATE, name: 'private' },
  ];

  const serviceWithPorts = (
    discord: Parameters<typeof createAssistantService>[7],
    provider: TextProvider,
  ) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      discord,
      () => [
        {
          providerId: 'gemini',
          model: 'model-a',
          keyId: 'key_a',
          keyLabel: 'Key A',
          provider,
          skip: undefined,
          mayTrain: false,
          rpmLimit: null,
          rpdLimit: null,
        },
      ],
    );

  const scriptedRecall = (
    seen: { role: string; text: string }[][],
    answer: string,
  ): TextProvider => {
    let round = 0;
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        seen.push([...request.messages]);
        round += 1;
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'search_conversations', args: { query: 'robot arm' } }],
          };
        return { text: answer, model: 'model-a' };
      }),
    };
  };

  const ask = (
    discord: Parameters<typeof createAssistantService>[7],
    provider: TextProvider,
    invocationId: string,
    conversationId: string,
  ) =>
    serviceWithPorts(discord, provider).invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'what did we decide about the robot arm?' },
      source: 'slash-command',
      invocationId,
      conversationId,
    });

  const toolTurnOf = (seen: { role: string; text: string }[][]): string =>
    seen[1]?.find((message) => message.role === 'tool')?.text ?? '';

  it('recalls only the audience intersected with the asker channels', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      { memberChannels: memberChannelsBoth, audienceChannels: async () => new Set([GENERAL]) },
      scriptedRecall(seen, 'The gearbox needs grease.'),
      'int-recall-audience',
      'conv-current',
    );
    expect(result.ok).toBe(true);
    const toolText = toolTurnOf(seen);
    expect(toolText).toContain('robot arm gearbox');
    expect(toolText).not.toContain('robot arm gripper');
    expect(result.detail?.recalled).toEqual(['conv-general']);
  });

  it('excludes the current conversation', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      { memberChannels: memberChannelsBoth, audienceChannels: async () => new Set([GENERAL]) },
      scriptedRecall(seen, 'Done.'),
      'int-recall-exclude',
      'conv-current',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).not.toContain('robot arm wiring');
    expect(result.detail?.recalled).toEqual(['conv-general']);
  });

  it('leaves names, bot claims and commitment owners out of what the model sees', async () => {
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      { memberChannels: memberChannelsBoth, audienceChannels: async () => new Set([GENERAL]) },
      scriptedRecall(seen, 'Done.'),
      'int-recall-names',
      'conv-current',
    );
    expect(result.ok).toBe(true);
    const toolText = toolTurnOf(seen);
    expect(toolText).not.toContain('Ama');
    expect(toolText).not.toContain('The bot guessed the gearbox size');
    expect(toolText).not.toContain('bring grease');
  });

  it('redacts evidence text in recalled strings', async () => {
    const scope = t.scopes.forGuild(GUILD);
    conversationRepo.createConversation(scope, {
      conversationId: 'conv-mail',
      channelId: GENERAL,
      behaviourId: 'direct',
      startedBy: MEMBER,
      title: 'mail',
      source: 'discord',
      at: NOW - 100_000,
    });
    conversationRepo.writeSummaryIfNewer(scope, {
      conversationId: 'conv-mail',
      summary: {
        topic: 'robot arm contact',
        facts: [{ text: 'Write to lead@example.com for parts', from: 'member' }],
        botClaims: [],
        openQuestions: [],
        commitments: [],
        participants: [],
      },
      throughAt: NOW - 100_000,
      now: NOW - 99_000,
    });
    const seen: { role: string; text: string }[][] = [];
    const result = await ask(
      { memberChannels: memberChannelsBoth, audienceChannels: async () => new Set([GENERAL]) },
      scriptedRecall(seen, 'Done.'),
      'int-recall-redact',
      'conv-current',
    );
    expect(result.ok).toBe(true);
    expect(toolTurnOf(seen)).not.toContain('lead@example.com');
  });
});

/**
 * Channel-permissions task 7: a No-access channel never surfaces in archive
 * search, Try-it, conversation recall or server_info, while a paused
 * (Archive off, collecting=false) channel stays searchable. Written red
 * first: the service does not yet consult `channelAccess.isNoAccess` on
 * these paths.
 */
describe('Task 7: No-access channels are hidden from search, recall and server_info', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const GENERAL = '567890123456789012';
  const NOACCESS = '678901234567890123';
  const PAUSED = '789012345678901234';
  const CLUB_ROLE = '890123456789012345';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
    for (const channelId of [GENERAL, NOACCESS, PAUSED])
      archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: NOW });
    archiveRepo.pauseChannel(scope, PAUSED);
    archiveRepo.upsertMessage(scope, {
      messageId: '844444444444444451',
      channelId: GENERAL,
      authorId: MEMBER,
      content: 'sunflower shipment arrives friday',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: '844444444444444452',
      channelId: NOACCESS,
      authorId: MEMBER,
      content: 'sunflower vault combination is secret',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    archiveRepo.upsertMessage(scope, {
      messageId: '844444444444444453',
      channelId: PAUSED,
      authorId: MEMBER,
      content: 'sunflower greenhouse stays open late',
      createdAt: NOW - 1_000,
      editedAt: undefined,
      attachments: [],
    });
    const seedConversation = (
      conversationId: string,
      channelId: string,
      at: number,
      topic: string,
      fact: string,
    ): void => {
      conversationRepo.createConversation(scope, {
        conversationId,
        channelId,
        behaviourId: 'direct',
        startedBy: MEMBER,
        title: topic,
        source: 'discord',
        at,
      });
      conversationRepo.writeSummaryIfNewer(scope, {
        conversationId,
        summary: {
          topic,
          facts: [{ text: fact, from: 'member' }],
          botClaims: [],
          openQuestions: [],
          commitments: [],
          participants: [],
        },
        throughAt: at,
        now: at + 1,
      });
    };
    seedConversation(
      'conv-general',
      GENERAL,
      NOW - 3_600_000,
      'robot arm gearbox',
      'The gearbox needs grease',
    );
    seedConversation(
      'conv-noaccess',
      NOACCESS,
      NOW - 1_800_000,
      'robot arm gripper',
      'The gripper needs oil',
    );
  });
  afterEach(() => t.close());

  type DiscordPorts = Parameters<typeof createAssistantService>[7];
  const memberChannelsAll = async () => [
    { id: GENERAL, name: 'general' },
    { id: NOACCESS, name: 'noaccess' },
    { id: PAUSED, name: 'paused' },
  ];

  const noAccessFake: ChannelAccess = {
    check: async () => ({ allowed: true, grantedBy: GENERAL }),
    canSearchArchived: async (channelId) => channelId !== NOACCESS,
    isNoAccess: async (channelId) => channelId === NOACCESS,
  };

  const chainOf = (provider: TextProvider) => () => [
    {
      providerId: 'gemini' as const,
      model: 'model-a',
      keyId: 'key_a',
      keyLabel: 'Key A',
      provider,
      skip: undefined,
      mayTrain: false,
      rpmLimit: null,
      rpdLimit: null,
    },
  ];

  const serviceWith = (discord: DiscordPorts, provider: TextProvider, access?: ChannelAccess) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      discord,
      chainOf(provider),
      undefined,
      undefined,
      undefined,
      access,
    );

  /** A provider that makes the scripted tool calls in order, then answers. */
  const scriptedCalls = (
    seen: { role: string; text: string }[][],
    calls: { name: string; args: Record<string, unknown> }[],
    answer: string,
  ): TextProvider => {
    let round = 0;
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: vi.fn<TextProvider['generateText']>(async (request) => {
        seen.push([...request.messages]);
        round += 1;
        const call = calls[round - 1];
        if (call !== undefined) return { text: '', model: 'model-a', toolCalls: [call] };
        return { text: answer, model: 'model-a' };
      }),
    };
  };

  const toolTurn = (seen: { role: string; text: string }[][], round: number): string =>
    seen[round]?.filter((message) => message.role === 'tool').at(-1)?.text ?? '';

  it('search_archive (find) returns no hits from the No-access channel', async () => {
    const service = serviceWith(
      {
        memberChannels: memberChannelsAll,
        audienceChannels: async () => new Set([GENERAL, NOACCESS, PAUSED]),
      },
      scriptedCalls([], [], 'unused'),
      noAccessFake,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: NOACCESS,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'find',
      input: { query: 'sunflower' },
      source: 'slash-command',
      invocationId: 'int-noaccess-find',
    });
    expect(result.ok).toBe(true);
    const content = result.ok === true ? result.content : '';
    expect(content).toContain('shipment');
    expect(content).not.toContain('vault');
  });

  it('Try-it search_archive returns no hits from the No-access channel', async () => {
    const seen: { role: string; text: string }[][] = [];
    const service = serviceWith(
      { memberChannels: memberChannelsAll },
      scriptedCalls(
        seen,
        [{ name: 'search_archive', args: { query: 'sunflower' } }],
        'Sunflowers.',
      ),
      noAccessFake,
    );
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'any sunflower news?',
      accountUsername: 'owner-name',
    });
    expect(result.answer).toBe('Sunflowers.');
    expect(toolTurn(seen, 1)).toContain('shipment');
    expect(toolTurn(seen, 1)).not.toContain('vault');
  });

  it('a paused (Archive off) channel that is not No access still returns its hits', async () => {
    const service = serviceWith(
      {
        memberChannels: memberChannelsAll,
        audienceChannels: async () => new Set([GENERAL, NOACCESS, PAUSED]),
      },
      scriptedCalls([], [], 'unused'),
      noAccessFake,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'find',
      input: { query: 'greenhouse' },
      source: 'slash-command',
      invocationId: 'int-paused-find',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.content).toContain('greenhouse');
  });

  it('search_conversations drops the No-access channel summary', async () => {
    const seen: { role: string; text: string }[][] = [];
    const service = serviceWith(
      {
        memberChannels: memberChannelsAll,
        audienceChannels: async () => new Set([GENERAL, NOACCESS]),
      },
      scriptedCalls(
        seen,
        [{ name: 'search_conversations', args: { query: 'robot arm' } }],
        'Done.',
      ),
      noAccessFake,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'what did we decide about the robot arm?' },
      source: 'slash-command',
      invocationId: 'int-noaccess-recall',
    });
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).toContain('robot arm gearbox');
    expect(toolTurn(seen, 1)).not.toContain('robot arm gripper');
    expect(result.detail?.recalled).toEqual(['conv-general']);
  });

  it('server_info omits the No-access channel', async () => {
    const seen: { role: string; text: string }[][] = [];
    const service = serviceWith(
      { memberChannels: memberChannelsAll },
      scriptedCalls(seen, [{ name: 'server_info', args: {} }], 'Here are the channels.'),
      noAccessFake,
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: GENERAL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'what channels are here?' },
      source: 'slash-command',
      invocationId: 'int-noaccess-server-info',
    });
    expect(result.ok).toBe(true);
    expect(toolTurn(seen, 1)).toContain('#general');
    expect(toolTurn(seen, 1)).toContain('#paused');
    expect(toolTurn(seen, 1)).not.toContain(NOACCESS);
    expect(toolTurn(seen, 1)).not.toContain('#noaccess');
  });
});

describe('assistant service run recorder (ADR 0129 §6)', () => {
  const GUILD = parseGuildId('234567890123456789');
  const BOT = '123456789012345678';
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: BOT,
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
  });

  const answering = (text: string): TextProvider => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: async () => ({ text, model: 'model-a' }),
  });

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key A',
      apiKeyEnc: 'sealed-key-a',
      now: NOW,
      keyId: 'key_a',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Test provider',
      apiKeyEnc: 'sealed-key-test',
      now: NOW,
      keyId: 'key_test',
    });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const serviceWith = (provider: TextProvider) =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      { memberChannels: vi.fn(async () => []) },
      () => [usable(provider)],
    );

  it('invoke with a recorder logs context-built then the model pair', async () => {
    const events: RunEvent[] = [];
    const service = serviceWith(answering('hello'));
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'when is the meeting?' },
      source: 'slash-command',
      invocationId: 'inv-rec-1',
      recorder: {
        runId: 'inv-rec-1',
        event: (e: RunEvent) => {
          events.push(e);
        },
        update: () => undefined,
      },
    });
    expect(result.ok).toBe(true);
    // ADR 0144: the routed decision is the run's first event (S6-T13).
    expect(events.map((e) => e.kind)).toEqual([
      'routed',
      'context-built',
      'model-call',
      'model-result',
    ]);
    expect(events[0]).toMatchObject({ kind: 'routed', tier: 'light', reason: 'short-and-simple' });
    const built = events[1]!;
    expect(built.kind).toBe('context-built');
    if (built.kind === 'context-built') {
      expect(built.sections.length).toBeGreaterThan(0);
      expect(built.toolsOffered.length).toBeGreaterThan(0);
    }
    expect(events[3]).toMatchObject({ ok: true });
  });

  it('tryIt creates a dashboard-test run that ends finished with the trace id', async () => {
    const service = serviceWith(answering('Try-it answer.'));
    const result = await service.tryIt({
      behaviourId: 'direct',
      question: 'when is the meeting?',
      accountUsername: 'owner-name',
    });
    const scope = t.scopes.forGuild(GUILD);
    const runs = runRepo.listRuns(scope, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      source: 'dashboard-test',
      state: 'answered',
      stage: 'done',
      conversationId: result.conversationId,
    });
    const finished = runRepo
      .listRunEvents(scope, runs[0]!.runId, 0, 50)
      .find((r) => r.event.kind === 'finished')?.event;
    expect(finished).toMatchObject({ outcome: 'answered', traceId: result.traceId });
  });
});

describe('complexity routing (ADR 0144, spec 6e)', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;
  const LIGHT_MODEL = 'gemini-3.5-flash-lite';
  const STANDARD_MODEL = 'gemini-3.8-flash';

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    preferredSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'fixture', now: NOW });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key Light',
      apiKeyEnc: 'sealed-key-light',
      now: NOW,
      keyId: 'key_light',
    });
    assistantProvidersRepo.addKey(t.scopes.instance(), {
      provider: 'gemini',
      label: 'Key Standard',
      apiKeyEnc: 'sealed-key-standard',
      now: NOW,
      keyId: 'key_standard',
    });
    assistantRepo.putBehaviour(scope, direct, NOW);
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  const chainEntry = (
    provider: TextProvider | undefined,
    over: Partial<ChainEntry>,
  ): ChainEntry => ({
    providerId: 'gemini',
    model: STANDARD_MODEL,
    keyId: 'key_standard',
    keyLabel: 'Key Standard',
    provider,
    skip: undefined,
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
    pool: 'key',
    tier: 'standard',
    selectedKeyId: 'key_standard',
    ...over,
  });
  const lightEntry = (provider: TextProvider): ChainEntry =>
    chainEntry(provider, {
      model: LIGHT_MODEL,
      keyId: 'key_light',
      keyLabel: 'Key Light',
      tier: 'light',
      selectedKeyId: 'key_light',
    });
  const standardEntry = (provider: TextProvider): ChainEntry => chainEntry(provider, {});

  /** A provider that makes the scripted tool calls in round 1, then answers. */
  const fakeProvider = (
    model: string,
    calls: string[],
    toolCalls: readonly string[] = [],
  ): TextProvider => {
    let round = 0;
    return {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        round += 1;
        calls.push(model);
        if (round === 1 && toolCalls.length > 0) {
          return { text: '', model, toolCalls: toolCalls.map((name) => ({ name, args: {} })) };
        }
        return { text: 'Here you go.', model };
      },
    };
  };

  let invocationCounter = 0;
  const runWith = async (
    text: string,
    opts: {
      readonly hasAttachments?: boolean;
      readonly earlierTurns?: number;
      readonly spentModels?: readonly string[];
      readonly toolCalls?: readonly string[];
      readonly settings?: Readonly<Record<string, unknown>>;
    },
  ): Promise<{
    readonly routed: { readonly tier: string; readonly reason: string };
    readonly rounds: readonly { readonly tier: string; readonly reason: string }[];
    readonly firstEntryTier: string | undefined;
    readonly answeredBy: { readonly model: string; readonly tier: string | undefined };
  }> => {
    const instance = t.scopes.instance();
    for (const [key, value] of Object.entries(opts.settings ?? {})) {
      instanceSettingsRepo.upsertSetting(instance, {
        key,
        valueJson: JSON.stringify(value),
        updatedAt: NOW,
        updatedBy: 'fixture',
      });
    }
    for (const model of opts.spentModels ?? []) {
      assistantKeyCooldownsRepo.setCooldown(instance, {
        keyId: 'key_light',
        model,
        until: NOW + 3_600_000,
        reason: 'daily-quota',
        setAt: NOW,
      });
    }
    const calls: string[] = [];
    const events: RunEvent[] = [];
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      instance,
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [
        lightEntry(fakeProvider(LIGHT_MODEL, calls, opts.toolCalls ?? [])),
        standardEntry(fakeProvider(STANDARD_MODEL, calls)),
      ],
    );
    invocationCounter += 1;
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: text },
      source: 'slash-command',
      invocationId: `int-route-${invocationCounter}`,
      ...(opts.hasAttachments === true ? { hasAttachments: true } : {}),
      ...(opts.earlierTurns === undefined
        ? {}
        : {
            history: Array.from({ length: opts.earlierTurns }, (_, i) => ({
              role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
              text: `turn ${i}`,
            })),
          }),
      recorder: {
        runId: `run-route-${invocationCounter}`,
        event: (e: RunEvent) => {
          events.push(e);
        },
        update: () => undefined,
      },
    });
    const routedEvents = events
      .filter((e) => e.kind === 'routed')
      .map((e) => ({ tier: e.tier, reason: e.reason }));
    const answeredModel = result.ok ? result.detail?.answeredBy?.model : undefined;
    return {
      routed: routedEvents[0] ?? { tier: '', reason: '' },
      rounds: routedEvents,
      firstEntryTier:
        calls.length === 0 ? undefined : calls[0] === LIGHT_MODEL ? 'light' : 'standard',
      answeredBy: {
        model: answeredModel ?? '',
        tier:
          answeredModel === undefined
            ? undefined
            : answeredModel === LIGHT_MODEL
              ? 'light'
              : 'standard',
      },
    };
  };

  const runWithSummaryTier = async (
    tier: 'light' | 'standard',
  ): Promise<{ readonly tierUsed: string }> => {
    instanceSettingsRepo.upsertSetting(t.scopes.instance(), {
      key: 'assistant.routerSummaryTier',
      valueJson: JSON.stringify(tier),
      updatedAt: NOW,
      updatedBy: 'fixture',
    });
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
    );
    return { tierUsed: service.backgroundTier('summary') };
  };

  it.each([
    ['hi', 'light'],
    ['remind me at 5', 'standard'],
  ])('routes %s to the %s tier first', async (text, tier) => {
    const seen = await runWith(text, {});
    expect(seen.routed).toEqual({
      tier,
      reason: tier === 'light' ? 'greeting' : 'full-model-keyword',
    });
    expect(seen.firstEntryTier).toBe(tier);
  });

  it('routes attachments and long threads to standard, greetings stay light', async () => {
    expect((await runWith('look', { hasAttachments: true })).routed.tier).toBe('standard');
    expect((await runWith('and then?', { earlierTurns: 5 })).routed).toMatchObject({
      tier: 'standard',
      reason: 'long-thread',
    });
    expect((await runWith('thanks!', { earlierTurns: 9 })).routed).toMatchObject({
      tier: 'light',
      reason: 'greeting',
    });
  });

  it('a light run falls back to standard when Flash-Lite is spent', async () => {
    const seen = await runWith('hi', { spentModels: [LIGHT_MODEL] });
    expect(seen.routed.tier).toBe('light');
    expect(seen.answeredBy.model).not.toBe(LIGHT_MODEL);
    expect(seen.answeredBy.tier).toBe('standard');
  });

  it('a light tool call escalates to standard on the next round (on by default)', async () => {
    const seen = await runWith('hi', { toolCalls: ['list_sources'] });
    expect(seen.rounds[1]).toMatchObject({ tier: 'standard', reason: 'escalated-after-tool' });
  });

  it('router-off and background tiers are honoured', async () => {
    expect(
      (await runWith('hi', { settings: { 'assistant.routerEnabled': 0 } })).routed,
    ).toMatchObject({
      tier: 'standard',
      reason: 'router-off',
    });
    expect((await runWithSummaryTier('light')).tierUsed).toBe('light');
  });

  it('passes the instance scope to the loop: a daily 429 persists a cooldown', async () => {
    const failing: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async () => {
        throw new ProviderError('quota', 'HTTP 429', true, { quotaScope: 'day' });
      },
    };
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [standardEntry(failing)],
    );
    await service
      .invoke({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MEMBER,
        callerRoleIds: [CLUB_ROLE],
        behaviour: direct,
        command: 'ask',
        input: { question: 'when is the meeting?' },
        source: 'slash-command',
        invocationId: 'int-route-cooldown',
      })
      .catch(() => undefined);
    const cooldown = assistantKeyCooldownsRepo.getCooldown(
      t.scopes.instance(),
      'key_standard',
      STANDARD_MODEL,
      NOW,
    );
    expect(cooldown).toMatchObject({ reason: 'daily-quota' });
    expect(cooldown?.until).toBeGreaterThan(NOW);
  });
});
