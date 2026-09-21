import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseConfig,
  parseGuildId,
  type GenerateTextRequest,
  type TextProvider,
} from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { assistantRepo, guildRepo } from '@bananasaurs/storage';
import { createAssistantService } from './service.js';

const GUILD = parseGuildId('234567890123456789');
const OWNER = '345678901234567890';
const MEMBER = '456789012345678901';
const CHANNEL = '567890123456789012';
const CLUB_ROLE = '678901234567890123';
const IT_CHANNEL = '789012345678901234';
const REVIEWER_ROLE = '890123456789012345';
const NOW = 1_800_000_000_000;

const config = parseConfig({
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_APPLICATION_ID: '123456789012345678',
  BANANASAURS_GUILD_ALLOWLIST: GUILD,
  BANANASAURS_OWNER_USER_ID: OWNER,
  AI_PROVIDER: 'off',
  AI_MODEL: 'fixture-model',
});

const provider = () => {
  const generateText = vi.fn(async (request: GenerateTextRequest) => {
    const text = request.messages.map((message) => message.text).join('\n');
    return {
      text: text.includes('needs admin')
        ? 'ESCALATE: Grant access to the telemetry dashboard.'
        : text.includes('supplier')
          ? 'DRAFT: Choose the Canadian supplier after checking lead time.'
          : 'Agenda: safety, battery status, software blockers, owners and next actions.',
      model: 'fixture-model',
    };
  });
  const value: TextProvider = { id: 'fixture', capabilities: new Set(['text']), generateText };
  return { value, generateText };
};

describe('Release 3 assistant end-to-end sandbox flows', () => {
  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'SFU Racerbot fixture', now: NOW });
  });
  afterEach(() => t.close());

  it('runs organisation, resource, reminder, decision and IT flows without a real Discord send', async () => {
    const scope = t.scopes.forGuild(GUILD);
    const direct = {
      id: 'direct',
      guildId: GUILD,
      surface: 'direct-command' as const,
      name: 'Club organiser',
      systemPrompt: 'Use Canadian English and reviewed club evidence.',
      promptVersion: 1,
      callerRoleIds: [CLUB_ROLE],
      reviewerRoleIds: [],
      allowedSkillIds: ['draft-agenda', 'create-reminder', 'record-decision'],
      resourceIds: ['site'],
      enabled: true,
    };
    const it = {
      ...direct,
      id: 'it',
      surface: 'it-services' as const,
      name: 'IT services',
      ticketChannelId: IT_CHANNEL,
      reviewerRoleIds: [REVIEWER_ROLE],
      allowedSkillIds: ['search-club'],
      resourceIds: [],
    };
    assistantRepo.putBehaviour(scope, direct, NOW);
    assistantRepo.putBehaviour(scope, it, NOW);
    assistantRepo.putResource(scope, {
      id: 'site',
      guildId: GUILD,
      title: 'Racerbot website',
      url: 'https://sfuracerbot.ca',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'draft-agenda', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
    assistantRepo.putSkillGrant(
      scope,
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
    const fixture = provider();
    const service = createAssistantService(scope, config, () => NOW, {
      provider: fixture.value,
      fetchResource: async () => ({
        ok: true,
        cache: 'miss',
        evidence: {
          url: 'https://sfuracerbot.ca/',
          mediaType: 'text/html',
          text: 'Monday tech meeting is 6:30 to 8:30 PM.',
          fetchedAt: NOW,
          trust: 'untrusted-reviewed-resource',
        },
      }),
    });

    const denied = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [],
      behaviour: direct,
      command: 'agenda',
      input: { request: 'Monday meeting' },
      source: 'slash-command',
    });
    expect(denied.ok).toBe(false);
    expect(fixture.generateText).not.toHaveBeenCalled();

    const agenda = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'agenda',
      input: { request: 'Monday meeting' },
      source: 'slash-command',
    });
    expect(agenda).toMatchObject({ ok: true });
    expect(fixture.generateText.mock.calls[0]?.[0].systemInstruction).toContain('draft-agenda');
    expect(fixture.generateText.mock.calls[0]?.[0].messages[0]?.text).toContain('UNTRUSTED');
    expect(assistantRepo.listResources(scope)[0]).toMatchObject({
      fetchStatus: 'ok',
      lastFetchedAt: NOW,
    });

    const reminder = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: direct,
      command: 'remind',
      input: { when: new Date(NOW + 60_000).toISOString(), text: 'Bring batteries' },
      source: 'slash-command',
    });
    expect(reminder.ok).toBe(true);
    expect(assistantRepo.listReminders(scope)).toHaveLength(1);

    const decision = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: OWNER,
      callerRoleIds: [],
      behaviour: direct,
      command: 'decision',
      input: { topic: 'supplier' },
      source: 'slash-command',
    });
    expect(decision.content).toContain('not club policy');
    const draft = assistantRepo.listDecisions(scope)[0]!;
    expect(draft.status).toBe('draft');
    expect(assistantRepo.transitionDecision(scope, draft.id, 'draft', 'reviewed')).toBe(true);
    expect(assistantRepo.transitionDecision(scope, draft.id, 'reviewed', 'saved')).toBe(true);

    const escalation = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: it,
      command: 'ask',
      input: { question: 'needs admin' },
      source: 'mention',
    });
    expect(escalation).toMatchObject({
      ok: true,
      escalation: { channelId: IT_CHANNEL, reviewerRoleIds: [REVIEWER_ROLE] },
    });
    expect(assistantRepo.listTickets(scope)).toHaveLength(1);
    const duplicate = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: it,
      command: 'ask',
      input: { question: 'needs admin' },
      source: 'mention',
    });
    expect(duplicate.content).toContain('already open');
    expect(assistantRepo.listTickets(scope)).toHaveLength(1);
  });
  it('fails provider safety and cost policy before a network provider can run', async () => {
    const scope = t.scopes.forGuild(GUILD);
    const behaviour = {
      id: 'direct',
      guildId: GUILD,
      surface: 'direct-command' as const,
      name: 'Club',
      systemPrompt: 'Canadian English.',
      promptVersion: 1,
      callerRoleIds: [],
      reviewerRoleIds: [],
      allowedSkillIds: ['search-club'],
      resourceIds: [],
      enabled: true,
    };
    assistantRepo.putBehaviour(scope, behaviour, NOW);
    const paidNetwork = vi.fn(async () => ({ text: 'must not run', model: 'paid' }));
    const paidInner: TextProvider = {
      id: 'paid',
      capabilities: new Set(['text']),
      generateText: paidNetwork,
    };
    const { SafeProvider } = await import('@bananasaurs/core');
    const paid = new SafeProvider(paidInner, 'paid', { monthlyCapUsdMicros: 0 });
    const service = createAssistantService(scope, config, () => NOW, { provider: paid });
    await expect(
      service.invoke({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: OWNER,
        callerRoleIds: [],
        behaviour,
        command: 'ask',
        input: { question: 'normal question' },
        source: 'slash-command',
      }),
    ).rejects.toThrow('monthly spend cap is $0');
    expect(paidNetwork).not.toHaveBeenCalled();

    const freeNetwork = vi.fn(async () => ({ text: 'must not run', model: 'free' }));
    const freeInner: TextProvider = {
      id: 'free',
      capabilities: new Set(['text']),
      generateText: freeNetwork,
    };
    const free = new SafeProvider(freeInner, 'free', { monthlyCapUsdMicros: 0 });
    const safeService = createAssistantService(scope, config, () => NOW, { provider: free });
    await expect(
      safeService.invoke({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: OWNER,
        callerRoleIds: [],
        behaviour: { ...behaviour, systemPrompt: 'Send token sk-live-12345678901234567890' },
        command: 'ask',
        input: { question: 'normal question' },
        source: 'slash-command',
      }),
    ).rejects.toThrow();
    expect(freeNetwork).not.toHaveBeenCalled();
  });
});
