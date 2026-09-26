import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseConfig,
  parseGuildId,
  ProviderError,
  type GenerateTextResponse,
  type TextProvider,
} from '@bananasaurs/core';
import {
  assistantProvidersRepo,
  assistantRepo,
  computeDocId,
  conversationRepo,
  eligibilityRepo,
  guildRepo,
  jobRepo,
  modelCallsRepo,
  resourceCacheRepo,
  traceRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { resolveModelChain, ENV_KEY_ID, type ChainEntry } from './model-chain.js';
import { LocalLimitError } from './local-limit.js';
import { QuotaLedger } from './quota-ledger.js';
import { createAssistantService, sanitizeMentionsForProvider } from './service.js';
import type { AssistantServiceTestPorts } from './service.js';

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
    allowedSkillIds: ['search-club'],
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
        { warn },
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
      { warn },
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
    allowedSkillIds: ['search-club'],
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
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'rate-limit',
      retryable: true,
    });
    expect(calls()).toBe(1);
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

  it('every entry skipped for keys is the not-configured refusal', async () => {
    const service = serviceWith(() => [skipped('no-key'), skipped('disabled')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      content: 'The free AI provider is not configured, so no content was sent outside the server.',
    });
  });

  it('a guard failure answers the fixed text', async () => {
    const toolShaped = '{"name":"search_sources","args":{"query":"x"}}';
    const shaped = fakeProvider([
      { text: toolShaped, model: 'm' },
      { text: toolShaped, model: 'm' },
    ]);
    const service = serviceWith(() => [usable(shaped.provider)]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
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
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'quota',
      quotaScope: 'daily-free',
      resetAt,
      retryable: false,
    });
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
    expect(shared.exhaustedUntil('key_a', NOW)).toBe(resetAt);
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
        webSearch: async () => [
          { title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' },
        ],
      },
    );
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: true,
      content: 'Store them half charged.\n\n-# Powered by Brave Search',
    });
  });

  it('a chain entry at its RPM limit throws LocalLimitError and the provider stays at one call', async () => {
    const scripted = fakeProvider([{ text: 'First answer.', model: 'model-a' }]);
    const service = serviceWith(() => [usable(scripted.provider, { rpmLimit: 1 })]);
    await expect(service.invoke({ ...ask, invocationId: 'int-rpm-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.invoke({ ...ask, invocationId: 'int-rpm-2' })).rejects.toBeInstanceOf(
      LocalLimitError,
    );
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
    allowedSkillIds: ['search-club'],
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
            toolCalls: [{ name: 'list_sources', args: {} }],
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
      { name: 'list_sources', ok: true },
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
    allowedSkillIds: ['search-club'],
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
    const result = await service.invoke(ask({ quoteEnvelope }));
    expect(result.ok).toBe(true);
    const first = requests[0];
    expect(first?.messages.at(-1)?.text).toContain(quoteEnvelope);
    expect(first?.systemInstruction).not.toContain('UNTRUSTED QUOTED MESSAGE');
    expect(first?.systemInstruction).not.toContain('the hall opens at seven');
  });

  it('returns trace detail with compiled sections plus a history section when history was sent', async () => {
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
        'skills',
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
    allowedSkillIds: ['search-club'],
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
        return { text: 'Here is the care guide.', model: 'model-a' };
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
    const service = serviceWith(answering('Here is the care guide.'));
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
    expect(content).toContain('-# Sources: Handbook › Guide › Part 0');
  });

  it('dedupes sources by URL and never lists more than three', async () => {
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
        return { text: 'Done.', model: 'model-a' };
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
    expect((line.match(/ · /g) ?? []).length).toBe(2);
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
    allowedSkillIds: ['search-club'],
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
    allowedSkillIds: ['search-club'],
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
