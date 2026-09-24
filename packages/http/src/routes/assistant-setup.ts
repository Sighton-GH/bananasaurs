import type { AssistantBehaviour, AssistantSkill } from '@bananasaurs/core';
import type { eligibilityRepo } from '@bananasaurs/storage';
import type { AssistantProviderStatus } from '../server.js';

type EligibilityRow = eligibilityRepo.EligibilityRow;

export type SetupStepId = 'connect' | 'terms' | 'cost' | 'who' | 'skills' | 'on';
export interface SetupStep {
  readonly id: SetupStepId;
  /** `warning` counts as complete: the step works, with a caveat the owner has accepted (ADR 0062). */
  readonly state: 'done' | 'todo' | 'blocked' | 'warning';
  /** One plain sentence for a first-time operator: what is true now, or what to do next. */
  readonly detail: string;
}
export interface AssistantSetup {
  readonly steps: readonly SetupStep[]; // always all six, in the order above
  /** True exactly when the request path would send a member's question to the provider. */
  readonly answering: boolean;
}

const displayName = (provider: string): string => {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'nvidia-nim') return 'NVIDIA NIM';
  return provider;
};

const connectStep = (status: AssistantProviderStatus): SetupStep => {
  if (
    status.provider !== 'off' &&
    status.provider !== 'unknown' &&
    status.modelConfigured &&
    status.keyReadable
  ) {
    return {
      id: 'connect',
      state: 'done',
      detail: `Connected to ${displayName(status.provider)} using ${status.model ?? ''}.`,
    };
  }
  if (status.secretSource === 'missing' && !status.keyConfigured) {
    if (status.secretProblem === 'key-file-permissions') {
      return {
        id: 'connect',
        state: 'blocked',
        detail:
          "The host's key file can be read by other users. Restrict it to the bot's user (chmod 600) and restart.",
      };
    }
    if (status.secretProblem === 'key-file-invalid') {
      return {
        id: 'connect',
        state: 'blocked',
        detail: "The host's key file is damaged. Remove it and restart to create a new one.",
      };
    }
    return {
      id: 'connect',
      state: 'blocked',
      detail:
        "The bot can't store API keys on this host yet. Restart it once without read-only mode.",
    };
  }
  if (status.provider === 'off' || status.provider === 'unknown') {
    return {
      id: 'connect',
      state: 'todo',
      detail: 'Choose an AI service and paste its API key.',
    };
  }
  if (!status.modelConfigured) {
    return {
      id: 'connect',
      state: 'todo',
      detail: `Enter the model name for ${displayName(status.provider)}.`,
    };
  }
  if (!status.keyConfigured) {
    return {
      id: 'connect',
      state: 'todo',
      detail: `Paste the API key for ${displayName(status.provider)}.`,
    };
  }
  return {
    id: 'connect',
    state: 'todo',
    detail:
      "The saved key can't be read on this host (it was saved under a different secret). Paste it again.",
  };
};

const termsStep = (
  status: AssistantProviderStatus,
  terms: EligibilityRow | undefined,
  now: number,
  reviewMaxAgeMs: number,
): SetupStep => {
  if (status.provider === 'off' || status.provider === 'unknown') {
    return { id: 'terms', state: 'todo', detail: 'Choose an AI service first.' };
  }
  if (terms === undefined) {
    return {
      id: 'terms',
      state: 'todo',
      detail: `Record what ${displayName(status.provider)}'s terms say about training on your data.`,
    };
  }
  if (!terms.productionUseAllowed) {
    return {
      id: 'terms',
      state: 'blocked',
      detail: `${displayName(status.provider)}'s terms record doesn't allow use for member questions.`,
    };
  }
  if (now - terms.reviewedAt > reviewMaxAgeMs) {
    const date = new Date(terms.reviewedAt).toISOString().slice(0, 10);
    return {
      id: 'terms',
      state: 'todo',
      detail: `Terms last checked on ${date}, over 90 days ago. The assistant still answers; check them again.`,
    };
  }
  // ADR 0062: training is disclosed, not blocked.
  if (terms.trainsOnInput !== 'no') {
    return {
      id: 'terms',
      state: 'warning',
      detail: `${displayName(status.provider)}'s terms record says it may train on your data. Member questions and server excerpts sent to it may be used for training.`,
    };
  }
  const date = new Date(terms.reviewedAt).toISOString().slice(0, 10);
  return {
    id: 'terms',
    state: 'done',
    detail: `Terms checked on ${date}: it doesn't train on your data.`,
  };
};

const costStep = (status: AssistantProviderStatus): SetupStep => {
  if (status.costClass === 'free') {
    return { id: 'cost', state: 'done', detail: 'Marked as free to use.' };
  }
  if (status.costClass === 'paid') {
    return {
      id: 'cost',
      state: 'blocked',
      detail: "Marked as paid. The spending limit is $0, so paid models can't be used.",
    };
  }
  return { id: 'cost', state: 'todo', detail: 'Confirm the model is free to use.' };
};

const whoStep = (
  behaviours: readonly AssistantBehaviour[],
  roleNames?: ReadonlyMap<string, string>,
): SetupStep => {
  const roles = new Set<string>();
  for (const item of behaviours) {
    for (const roleId of item.callerRoleIds) roles.add(roleId);
  }
  if (roles.size > 0) {
    const ids = [...roles];
    const names = roleNames === undefined ? undefined : ids.map((id) => roleNames.get(id));
    if (names !== undefined && names.every((name): name is string => name !== undefined)) {
      if (names.length === 1) {
        return { id: 'who', state: 'done', detail: `${names[0]} can ask.` };
      }
      if (names.length === 2) {
        return { id: 'who', state: 'done', detail: `${names[0]} and ${names[1]} can ask.` };
      }
      return {
        id: 'who',
        state: 'done',
        detail: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} can ask.`,
      };
    }
    return {
      id: 'who',
      state: 'done',
      detail: roles.size === 1 ? '1 role can ask.' : `${String(roles.size)} roles can ask.`,
    };
  }
  return {
    id: 'who',
    state: 'todo',
    detail: 'Choose which server roles may ask the assistant.',
  };
};

/** ADR 0064: a skill is ready once a behaviour allows it; "Who can ask" decides who. */
const skillsStep = (
  behaviours: readonly AssistantBehaviour[],
  skills: readonly AssistantSkill[],
): SetupStep => {
  const allowed = new Set(behaviours.flatMap((item) => item.allowedSkillIds));
  const ready = skills.filter((item) => allowed.has(item.id)).length;
  if (ready > 0) {
    return {
      id: 'skills',
      state: 'done',
      detail:
        ready === 1 ? '1 skill is ready to use.' : `${String(ready)} skills are ready to use.`,
    };
  }
  return {
    id: 'skills',
    state: 'todo',
    detail: 'Choose what the assistant may do for members.',
  };
};

const onStep = (
  status: AssistantProviderStatus,
  behaviours: readonly AssistantBehaviour[],
): SetupStep => {
  const usable = behaviours.some((item) => item.enabled && item.callerRoleIds.length > 0);
  if (status.enabled && usable) {
    return { id: 'on', state: 'done', detail: 'The assistant is on.' };
  }
  if (!status.enabled) {
    return { id: 'on', state: 'todo', detail: 'Turn on the AI service in AI setup.' };
  }
  return {
    id: 'on',
    state: 'todo',
    detail: 'Turn on a behaviour that members can use.',
  };
};

export const computeAssistantSetup = (input: {
  status: AssistantProviderStatus;
  terms: EligibilityRow | undefined;
  behaviours: readonly AssistantBehaviour[];
  skills: readonly AssistantSkill[];
  now: number;
  reviewMaxAgeMs: number;
  roleNames?: ReadonlyMap<string, string>;
}): AssistantSetup => {
  const steps: readonly SetupStep[] = [
    connectStep(input.status),
    termsStep(input.status, input.terms, input.now, input.reviewMaxAgeMs),
    costStep(input.status),
    whoStep(input.behaviours, input.roleNames),
    skillsStep(input.behaviours, input.skills),
    onStep(input.status, input.behaviours),
  ];
  const complete = (step: SetupStep): boolean => step.state === 'done' || step.state === 'warning';
  const othersDone = steps.filter((step) => step.id !== 'terms').every(complete);
  const staleButAcceptable =
    input.terms !== undefined &&
    input.terms.productionUseAllowed &&
    input.now - input.terms.reviewedAt > input.reviewMaxAgeMs;
  const answering = steps.every(complete) || (othersDone && staleButAcceptable);
  return { steps, answering };
};
