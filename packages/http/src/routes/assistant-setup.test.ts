import { describe, expect, it } from 'vitest';
import type { AssistantBehaviour, AssistantSkill } from '@bananasaurs/core';
import type { eligibilityRepo } from '@bananasaurs/storage';
import type { AssistantProviderStatus } from '../server.js';
import { computeAssistantSetup } from './assistant-setup.js';

type EligibilityRow = eligibilityRepo.EligibilityRow;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23);
const REVIEW_MAX_AGE_MS = 90 * DAY_MS;

const behaviour = (over: Partial<AssistantBehaviour> = {}): AssistantBehaviour => ({
  id: 'club',
  guildId: '111111111111111111',
  surface: 'bananasaurs',
  mentionRoleId: '222222222222222222',
  callerRoleIds: ['222222222222222222'],
  reviewerRoleIds: [],
  name: 'Club',
  systemPrompt: 'Be helpful.',
  promptVersion: 1,
  allowedSkillIds: ['search-club'],
  resourceIds: [],
  enabled: true,
  ...over,
});

const skill = (id: string): AssistantSkill => ({
  id,
  name: id,
  description: `${id} skill`,
  effect: 'read',
  requiredPermission: 'test',
  requiresConfirmation: false,
});

const status = (over: Partial<AssistantProviderStatus> = {}): AssistantProviderStatus => ({
  provider: 'gemini',
  model: 'gemini-2.0-flash',
  enabled: true,
  modelConfigured: true,
  keyConfigured: true,
  keyReadable: true,
  costClass: 'free',
  secretSource: 'file',
  ...over,
});

const terms = (over: Partial<EligibilityRow> = {}): EligibilityRow => ({
  provider: 'gemini',
  trainsOnInput: 'no',
  evidenceUrl: 'https://example.com/terms',
  evidenceClause: 'This service does not train on customer data.',
  productionUseAllowed: true,
  reviewedAt: NOW,
  ...over,
});

const grant = (
  skillId: string,
  roleIds: readonly string[] = ['222222222222222222'],
  userIds: readonly string[] = [],
) => ({ skillId, roleIds, userIds });

const doneInput = () => ({
  status: status(),
  terms: terms() as EligibilityRow | undefined,
  behaviours: [behaviour()],
  grants: [grant('search-club')],
  skills: [skill('search-club')],
  now: NOW,
  reviewMaxAgeMs: REVIEW_MAX_AGE_MS,
});

const stepById = (setup: ReturnType<typeof computeAssistantSetup>, id: string) =>
  setup.steps.find((s) => s.id === id)!;

describe('computeAssistantSetup', () => {
  it('returns all six steps in order and answering true when everything is done', () => {
    const setup = computeAssistantSetup(doneInput());
    expect(setup.steps.map((s) => s.id)).toEqual([
      'connect',
      'terms',
      'cost',
      'who',
      'skills',
      'on',
    ]);
    expect(setup.steps.every((s) => s.state === 'done')).toBe(true);
    expect(setup.answering).toBe(true);
    expect(stepById(setup, 'connect').detail).toBe('Connected to Gemini using gemini-2.0-flash.');
    expect(stepById(setup, 'terms').detail).toBe(
      "Terms checked on 2026-09-23: it doesn't train on your data.",
    );
    expect(stepById(setup, 'cost').detail).toBe('Marked as free to use.');
    expect(stepById(setup, 'who').detail).toBe('1 role can ask.');
    expect(stepById(setup, 'skills').detail).toBe('1 skill is ready to use.');
    expect(stepById(setup, 'on').detail).toBe('The assistant is on.');
  });

  it('answers false when any step is not done', () => {
    const setup = computeAssistantSetup({
      ...doneInput(),
      status: status({ costClass: 'unknown' }),
    });
    expect(stepById(setup, 'cost').state).toBe('todo');
    expect(setup.answering).toBe(false);
  });

  describe('connect', () => {
    it.each([
      {
        name: 'blocked on key file permissions',
        status: status({
          provider: 'gemini',
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          secretSource: 'missing',
          secretProblem: 'key-file-permissions',
        }),
        state: 'blocked',
        detail:
          "The host's key file can be read by other users. Restrict it to the bot's user (chmod 600) and restart.",
      },
      {
        name: 'blocked on a damaged key file',
        status: status({
          provider: 'gemini',
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          secretSource: 'missing',
          secretProblem: 'key-file-invalid',
        }),
        state: 'blocked',
        detail: "The host's key file is damaged. Remove it and restart to create a new one.",
      },
      {
        name: 'blocked in read-only mode without a key file',
        status: status({
          provider: 'gemini',
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          secretSource: 'missing',
          secretProblem: 'readonly-no-key-file',
        }),
        state: 'blocked',
        detail:
          "The bot can't store API keys on this host yet. Restart it once without read-only mode.",
      },
      {
        name: 'blocked without a named secret problem',
        status: status({
          provider: 'gemini',
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          secretSource: 'missing',
        }),
        state: 'blocked',
        detail:
          "The bot can't store API keys on this host yet. Restart it once without read-only mode.",
      },
      {
        name: 'todo when the provider is off',
        status: status({ provider: 'off', modelConfigured: false, keyConfigured: false }),
        state: 'todo',
        detail: 'Choose an AI service and paste its API key.',
      },
      {
        name: 'todo when the provider is unknown',
        status: status({ provider: 'unknown', modelConfigured: false, keyConfigured: false }),
        state: 'todo',
        detail: 'Choose an AI service and paste its API key.',
      },
      {
        name: 'todo when the model name is missing',
        status: status({ provider: 'openrouter', modelConfigured: false }),
        state: 'todo',
        detail: 'Enter the model name for OpenRouter.',
      },
      {
        name: 'todo when the key is missing',
        status: status({ keyConfigured: false, keyReadable: false, secretSource: 'file' }),
        state: 'todo',
        detail: 'Paste the API key for Gemini.',
      },
      {
        name: 'todo when the saved key cannot be read',
        status: status({ keyReadable: false, secretSource: 'file' }),
        state: 'todo',
        detail:
          "The saved key can't be read on this host (it was saved under a different secret). Paste it again.",
      },
    ])('$name', ({ status: s, state, detail }) => {
      const setup = computeAssistantSetup({ ...doneInput(), status: s });
      expect(stepById(setup, 'connect').state).toBe(state);
      expect(stepById(setup, 'connect').detail).toBe(detail);
    });
  });

  describe('terms', () => {
    it('is todo before a provider is chosen', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        status: status({ provider: 'off' }),
        terms: undefined,
      });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'todo',
        detail: 'Choose an AI service first.',
      });
    });

    it('is todo when no row exists for the provider', () => {
      const setup = computeAssistantSetup({ ...doneInput(), terms: undefined });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'todo',
        detail: "Record what Gemini's terms say about training on your data.",
      });
    });

    it.each(['yes', 'unknown'] as const)('is blocked when trainsOnInput is %s', (trains) => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ trainsOnInput: trains }),
      });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'blocked',
        detail: "Gemini's terms record says it may train on your data, so it can't be used.",
      });
    });

    it('is blocked when production use is not allowed', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ productionUseAllowed: false }),
      });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'blocked',
        detail: "Gemini's terms record doesn't allow use for member questions.",
      });
    });

    it('is todo when the review is stale, but still answering when everything else is done', () => {
      const reviewedAt = NOW - 91 * DAY_MS;
      const date = new Date(reviewedAt).toISOString().slice(0, 10);
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ reviewedAt }),
      });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'todo',
        detail: `Terms last checked on ${date}, over 90 days ago. The assistant still answers; check them again.`,
      });
      expect(setup.answering).toBe(true);
    });

    it('is not answering when stale and another step is not done', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ reviewedAt: NOW - 91 * DAY_MS }),
        status: status({ costClass: 'unknown' }),
      });
      expect(stepById(setup, 'terms').state).toBe('todo');
      expect(setup.answering).toBe(false);
    });

    it('is not answering when stale terms are otherwise unacceptable', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ reviewedAt: NOW - 91 * DAY_MS, productionUseAllowed: false }),
      });
      expect(stepById(setup, 'terms').state).toBe('blocked');
      expect(setup.answering).toBe(false);
    });

    it('is done with the UTC review date', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        terms: terms({ reviewedAt: Date.UTC(2026, 8, 18) }),
      });
      expect(stepById(setup, 'terms')).toEqual({
        id: 'terms',
        state: 'done',
        detail: "Terms checked on 2026-09-18: it doesn't train on your data.",
      });
    });
  });

  describe('cost', () => {
    it.each([
      { costClass: 'free' as const, state: 'done', detail: 'Marked as free to use.' },
      {
        costClass: 'paid' as const,
        state: 'blocked',
        detail: "Marked as paid. The spending limit is $0, so paid models can't be used.",
      },
      {
        costClass: 'unknown' as const,
        state: 'todo',
        detail: 'Confirm the model is free to use.',
      },
    ])('$costClass → $state', ({ costClass, state, detail }) => {
      const setup = computeAssistantSetup({ ...doneInput(), status: status({ costClass }) });
      expect(stepById(setup, 'cost')).toEqual({ id: 'cost', state, detail });
    });
  });

  describe('who', () => {
    it('counts the union of caller roles across behaviours', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [
          behaviour({ id: 'a', callerRoleIds: ['222222222222222222', '333333333333333333'] }),
          behaviour({ id: 'b', callerRoleIds: ['333333333333333333'] }),
          behaviour({ id: 'c', callerRoleIds: [] }),
        ],
      });
      expect(stepById(setup, 'who')).toEqual({
        id: 'who',
        state: 'done',
        detail: '2 roles can ask.',
      });
    });

    it('names one role', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ callerRoleIds: ['222222222222222222'] })],
        roleNames: new Map([['222222222222222222', 'Member']]),
      });
      expect(stepById(setup, 'who').detail).toBe('Member can ask.');
    });

    it('names two roles', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [
          behaviour({ callerRoleIds: ['222222222222222222', '333333333333333333'] }),
        ],
        roleNames: new Map([
          ['222222222222222222', 'Member'],
          ['333333333333333333', 'Helper'],
        ]),
      });
      expect(stepById(setup, 'who').detail).toBe('Member and Helper can ask.');
    });

    it('names three roles', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [
          behaviour({
            callerRoleIds: [
              '222222222222222222',
              '333333333333333333',
              '444444444444444444',
            ],
          }),
        ],
        roleNames: new Map([
          ['222222222222222222', 'Member'],
          ['333333333333333333', 'Helper'],
          ['444444444444444444', 'Mod'],
        ]),
      });
      expect(stepById(setup, 'who').detail).toBe('Member, Helper and Mod can ask.');
    });

    it('falls back to counts for unknown ids', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ callerRoleIds: ['222222222222222222'] })],
        roleNames: new Map([['999999999999999999', 'Someone']]),
      });
      expect(stepById(setup, 'who').detail).toBe('1 role can ask.');
    });

    it('is todo when nobody may ask', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ callerRoleIds: [] })],
      });
      expect(stepById(setup, 'who')).toEqual({
        id: 'who',
        state: 'todo',
        detail: 'Choose which server roles may ask the assistant.',
      });
    });
  });

  describe('skills', () => {
    it('counts skills allowed by a behaviour and granted to someone', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ allowedSkillIds: ['search-club', 'other-skill'] })],
        grants: [grant('search-club'), grant('other-skill', [], ['999999999999999999'])],
        skills: [skill('search-club'), skill('other-skill'), skill('ungranted')],
      });
      expect(stepById(setup, 'skills')).toEqual({
        id: 'skills',
        state: 'done',
        detail: '2 skills are ready to use.',
      });
    });

    it('is todo when the allowed skill has no grant', () => {
      const setup = computeAssistantSetup({ ...doneInput(), grants: [] });
      expect(stepById(setup, 'skills')).toEqual({
        id: 'skills',
        state: 'todo',
        detail: 'Choose what the assistant may do for members.',
      });
    });

    it('is todo when the grant names nobody', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        grants: [grant('search-club', [], [])],
      });
      expect(stepById(setup, 'skills')).toEqual({
        id: 'skills',
        state: 'todo',
        detail: 'Choose what the assistant may do for members.',
      });
    });
  });

  describe('on', () => {
    it('is todo when the provider is switched off', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        status: status({ enabled: false }),
      });
      expect(stepById(setup, 'on')).toEqual({
        id: 'on',
        state: 'todo',
        detail: 'Turn on the AI service in AI setup.',
      });
    });

    it('is todo when no usable behaviour is switched on', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ enabled: false })],
      });
      expect(stepById(setup, 'on')).toEqual({
        id: 'on',
        state: 'todo',
        detail: 'Turn on a behaviour that members can use.',
      });
    });

    it('is todo when the enabled behaviour may be used by nobody', () => {
      const setup = computeAssistantSetup({
        ...doneInput(),
        behaviours: [behaviour({ callerRoleIds: [] })],
      });
      expect(stepById(setup, 'on')).toEqual({
        id: 'on',
        state: 'todo',
        detail: 'Turn on a behaviour that members can use.',
      });
    });
  });
});
