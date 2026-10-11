import { describe, expect, it } from 'vitest';
import { buildCapabilityBlock } from '@bananasaurs/core';
import { CAPABILITY_FIXTURES } from './capability-fixtures.js';
import { skillAccess } from './skill-access.js';
import { toolDeclarations, type AssistantToolPorts } from './tools.js';

const fixturePorts = (skillAllowed: (skillId: string) => boolean): AssistantToolPorts => {
  const ports: AssistantToolPorts = {
    userId: '456789012345678901',
    guildId: '234567890123456789',
    now: () => 1_800_000_000_000,
    timeZone: 'America/Vancouver',
    isOwner: false,
    skillAllowed,
    quotePresent: false,
    invocationKey: 'fixture-invocation',
    currentChannelId: '567890123456789012',
    resolveReminderTargets: async () => ({
      ok: false as const,
      problem: "I can't check permissions right now, so I didn't set the reminder.",
    }),
    reminderStore: {
      insert: () => 'created' as const,
      get: () => undefined,
      update: () => 'not-found' as const,
      cancel: () => false,
      listForCreator: () => [],
      listAll: () => [],
    },
    proposeDraft: () => 'created' as const,
    recordSkillActivity: () => undefined,
    searchArchive: async () => ({ ok: true as const, hits: [] }),
    resources: () => [],
    fetchResource: async () => {
      throw new Error('no resource fetch in capability fixtures');
    },
    webSearch: async () => ({ results: [], source: 'brave' as const }),
    serverCard: () => 'Fixture server.',
    visibleChannels: async () => [],
    upcomingEvents: async () => [],
    channelHistory: async () => ({ lines: [], oldestId: undefined }),
    cacheSearch: () => [],
    cacheChunk: () => undefined,
    cacheNeighbours: () => [],
    cacheOutline: () => [],
    cacheDocument: () => undefined,
    cacheResourceDocs: () => [],
    cacheResourceChunks: () => [],
    cacheFreshness: () => [],
    enqueueRefresh: () => true,
    searchConversations: async () => [],
    findMember: async () => [],
    taskTools: {
      scope: undefined as never,
      access: async () => undefined,
      resolveMember: async () => [],
      destinationId: undefined,
    },
  };
  return ports;
};

describe('capability fixtures from the live transcripts', () => {
  for (const fixture of CAPABILITY_FIXTURES) {
    it(`${fixture.asker}: ${fixture.message}`, () => {
      const owner = fixture.asker === 'owner';
      const access = skillAccess({
        grants: [],
        owner,
        roleIds: [],
        acting: { skipActions: false, invocationId: 'fixture-invocation' },
      });
      const declared = toolDeclarations(fixturePorts(access.skillAllowed)).map(
        (declaration) => declaration.name,
      );
      const block = buildCapabilityBlock({
        offeredTools: declared,
        skills: access.permittedSkills,
        unavailable: access.unavailableSkills.map((entry) => ({
          name: entry.skill.name,
          reason: entry.reason,
        })),
      });
      for (const name of fixture.mustOffer) expect(declared).toContain(name);
      for (const name of fixture.mustNotOffer) expect(declared).not.toContain(name);
      for (const phrase of fixture.blockContains) expect(block).toContain(phrase);
    });
  }
});
