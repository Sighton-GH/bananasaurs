import { describe, expect, it, vi } from 'vitest';
import {
  createTaskCommandSubscriber,
  formatDueLabel,
  type TaskCommandDeps,
  type TaskCommandRow,
} from './commands.js';
import { ERROR_COPY } from '../copy/errors.js';
import { buildTaskCustomId } from './components.js';
import type { OutgoingMessage } from '../discord/port.js';
import type { InteractionEvent, SlashCommandEvent, ModalSubmitEvent } from '../discord/events.js';

const V2 = 32768;
const body = (m: OutgoingMessage | undefined): string => JSON.stringify(m?.components ?? []);

const GUILD = '111111111111111111';
const USER = '333333333333333333';
const CHANNEL = '444444444444444444';

const slashEvent = (subcommand: string): SlashCommandEvent => ({
  kind: 'slashCommand',
  guildId: GUILD,
  receivedAtMs: 1,
  interactionId: '222222222222222222',
  token: 'private-token',
  commandName: 'task',
  subcommandPath: [subcommand],
  options: [],
  userId: USER,
  channelId: CHANNEL,
});

const interactionEvent = (customId: string, values?: readonly string[]): InteractionEvent => ({
  kind: 'interaction',
  guildId: GUILD,
  receivedAtMs: 1,
  interactionId: '555555555555555555',
  token: 'interaction-token',
  channelId: CHANNEL,
  messageId: '666666666666666666',
  userId: USER,
  customId,
  ...(values === undefined ? {} : { values }),
});

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

const baseDeps = () => {
  const sent: OutgoingMessage[] = [];
  const defer = vi.fn(async (): Promise<void> => undefined);
  const respond = vi.fn(async (_ref: unknown, message: OutgoingMessage): Promise<void> => {
    sent.push(message);
  });
  const edits: { channelId: string; messageId: string; message: OutgoingMessage }[] = [];
  const listForMember = vi.fn(async (): Promise<readonly TaskCommandRow[]> => []);
  const completableForMember = vi.fn(
    async (): Promise<
      readonly { taskId: string; title: string; dueAt: number; timezone: string }[]
    > => [],
  );
  const completeForMember = vi.fn(
    async (): Promise<'awaiting_approval' | 'already-awaiting' | 'not-found' | 'conflict'> =>
      'not-found',
  );
  const decideReview = vi.fn(
    async (): Promise<{
      outcome: 'done' | 'sent-back' | 'not-authorised' | 'conflict';
      title?: string;
      teamName?: string;
    }> => ({ outcome: 'conflict' }),
  );
  const pickReplyTask = vi.fn(
    async (): Promise<{ outcome: 'recorded' | 'not-yours' | 'gone'; title?: string }> => ({
      outcome: 'gone',
    }),
  );
  const editBotMessage = vi.fn(
    async (channelId: string, messageId: string, message: OutgoingMessage): Promise<void> => {
      edits.push({ channelId, messageId, message });
    },
  );
  const deferUpdate = vi.fn(async (): Promise<void> => undefined);
  const showModal = vi.fn(async (_ref: unknown, _modal: unknown): Promise<void> => undefined);
  const taskTitle = vi.fn(() => 'Wire the brake light harness');
  const postUpdate = vi.fn(
    async (): Promise<{
      outcome: 'recorded' | 'duplicate' | 'not-yours' | 'not-open' | 'invalid';
      postsOn: boolean;
    }> => ({ outcome: 'recorded', postsOn: true }),
  );
  const startTask = vi.fn(
    async (): Promise<'started' | 'not-yours' | 'stale' | 'not-open'> => 'started',
  );
  const refreshTaskCard = vi.fn(async (): Promise<void> => undefined);
  // `satisfies` keeps the mock types (so mockResolvedValueOnce exists) while
  // proving the harness matches the subscriber's real dependency shape.
  const deps = {
    guildId: GUILD,
    responder: {
      defer,
      respond,
      deferUpdate,
      showModal,
    },
    now: () => 1700000000000,
    listForMember,
    completableForMember,
    completeForMember,
    decideReview,
    pickReplyTask,
    startTask,
    refreshTaskCard,
    taskTitle,
    postUpdate,
    editBotMessage,
  } satisfies TaskCommandDeps;
  return {
    sent,
    edits,
    defer,
    respond,
    deferUpdate,
    showModal,
    startTask,
    refreshTaskCard,
    taskTitle,
    postUpdate,
    deps,
  };
};

describe('/task list', () => {
  it('shows only rows given, with status icons and overdue marker, capped at 10 with footer', async () => {
    const h = baseDeps();
    const rows = [
      {
        taskId: UUID_A,
        teamName: 'Tech',
        title: 'Early',
        status: 'not_started',
        dueAt: 1699000000000,
        timezone: 'America/Vancouver',
      },
      {
        taskId: UUID_B,
        teamName: 'Tech',
        title: 'Later',
        status: 'in_progress',
        dueAt: 1701000000000,
        timezone: 'America/Vancouver',
      },
      {
        taskId: '00000000-0000-4000-8000-000000000003',
        teamName: 'Exec',
        title: 'Review me',
        status: 'awaiting_approval',
        dueAt: 1701000000000,
        timezone: 'America/Vancouver',
      },
    ];
    h.deps.listForMember.mockResolvedValueOnce(rows);
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(slashEvent('list'));
    expect(h.deps.listForMember).toHaveBeenCalledWith(USER);
    expect(h.sent[0]?.flags).toBe(V2);
    const content = body(h.sent[0]);
    expect(content).toContain('YOUR TASKS · 3 open');
    expect(content).toContain('**Tech**');
    expect(content).toContain('**Exec**');
    expect(content).toContain('waiting for review');
    expect(content).toContain('⚠️ Early · due <t:1699000000:R>');
    expect(content).toContain('🔧 Later · due <t:1701000000:R>');
    expect(content).toContain('👀 Review me · waiting for review');

    // 10-row cap footer
    const h2 = baseDeps();
    const many = Array.from({ length: 20 }, (_, i) => ({
      taskId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      teamName: 'Tech',
      title: `Task ${i}`,
      status: 'not_started',
      dueAt: 1701000000000 + i,
      timezone: 'America/Vancouver',
    }));
    h2.deps.listForMember.mockResolvedValueOnce(many);
    const sub2 = createTaskCommandSubscriber(h2.deps);
    await sub2.handle(slashEvent('list'));
    const content2 = body(h2.sent[0]);
    expect(content2).toContain('YOUR TASKS · 20 open');
    expect(content2).toContain('and 10 more');
    expect(content2).not.toContain('Task 10');
  });

  it('says so when there are no open tasks', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(slashEvent('list'));
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain('**📋 You have no open tasks**');
  });

  it('replies with the unknown-command card', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(slashEvent('nope'));
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain("That command isn't available");
  });

  it('replies with the unavailable card when the lookup throws', async () => {
    const h = baseDeps();
    h.deps.listForMember.mockRejectedValueOnce(new Error('db down'));
    await createTaskCommandSubscriber(h.deps).handle(slashEvent('list'));
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain("Couldn't update the task");
  });

  it('renders a Discord timestamp even when a row has a bad timezone', async () => {
    const h = baseDeps();
    const dueAt = 1700000000000;
    h.deps.listForMember.mockResolvedValueOnce([
      {
        taskId: UUID_A,
        teamName: 'Tech',
        title: 'Bad tz',
        status: 'not_started',
        dueAt,
        timezone: 'Pacific Time',
      },
    ]);
    const subscriber = createTaskCommandSubscriber(h.deps);
    await expect(subscriber.handle(slashEvent('list'))).resolves.toBeUndefined();
    const content = body(h.sent[0]);
    const iso = new Date(dueAt).toISOString().slice(0, 10);
    // The list card uses Discord timestamps, so the bad zone no longer reaches the text.
    expect(content).toContain('<t:1700000000:R>');
    expect(formatDueLabel(dueAt, 'Pacific Time')).toBe(iso);
  });
});

describe('formatDueLabel', () => {
  it('falls back to an ISO date for a bad timezone without throwing', () => {
    expect(() => formatDueLabel(1700000000000, 'Pacific Time')).not.toThrow();
    expect(formatDueLabel(1700000000000, 'Pacific Time')).toBe('2023-11-14');
  });
});

describe('/task complete', () => {
  it('responds with a select whose options are exactly the completable tasks', async () => {
    const h = baseDeps();
    h.deps.completableForMember.mockResolvedValueOnce([
      { taskId: UUID_A, title: 'Alpha', dueAt: 1701000000000, timezone: 'America/Vancouver' },
      { taskId: UUID_B, title: 'Beta', dueAt: 1702000000000, timezone: 'America/Vancouver' },
    ]);
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(slashEvent('complete'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain('bs.task:complete');
    const values = [...body(h.sent[0]).matchAll(/"value":"([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual([UUID_A, UUID_B]);
  });

  it('replies with the empty card when nothing can be completed', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(slashEvent('complete'));
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain('**📋 Nothing is ready to complete**');
    expect(body(h.sent[0])).toContain('You have no open tasks that can go to review.');
  });

  it('calls completeForMember with the selected id on select interaction', async () => {
    const h = baseDeps();
    h.deps.completeForMember.mockResolvedValueOnce('awaiting_approval');
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(interactionEvent(buildTaskCustomId({ action: 'complete' }), [UUID_A]));
    expect(h.deps.completeForMember).toHaveBeenCalledWith(USER, UUID_A);
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain('**👀 Sent for review**');
    expect(body(h.sent[0])).toContain('A lead (or the president for exec tasks) can approve it.');
  });

  it.each([
    ['already-awaiting', '**👀 Already waiting for review**'],
    ['not-found', 'This task is closed'],
    ['conflict', 'This task just changed'],
  ] as const)('replies to %s with a card', async (outcome, expected) => {
    const h = baseDeps();
    h.deps.completeForMember.mockResolvedValueOnce(outcome);
    await createTaskCommandSubscriber(h.deps).handle(
      interactionEvent(buildTaskCustomId({ action: 'complete' }), [UUID_A]),
    );
    expect(h.sent[0]?.flags).toBe(V2);
    expect(body(h.sent[0])).toContain(expected);
  });

  it.each(['completeForMember', 'defer'] as const)(
    'replies with the unavailable card when select %s throws',
    async (throwing) => {
      const h = baseDeps();
      if (throwing === 'completeForMember')
        h.deps.completeForMember.mockRejectedValueOnce(new Error('db down'));
      else h.defer.mockRejectedValueOnce(new Error('defer unavailable'));
      await createTaskCommandSubscriber(h.deps).handle(
        interactionEvent(buildTaskCustomId({ action: 'complete' }), [UUID_A]),
      );
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.flags).toBe(V2);
      expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
      expect(body(h.sent[0])).toContain("**❌ Couldn't update the task**");
      expect(body(h.sent[0])).toContain(
        "Bananasaurs couldn't save the change. Nothing was changed.",
      );
      expect(body(h.sent[0])).toContain('Try again in a minute.');
      expect(h.edits).toHaveLength(0);
    },
  );

  it('rejects a non-uuid selection', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(
      interactionEvent(buildTaskCustomId({ action: 'complete' }), ['not-a-uuid']),
    );
    expect(h.deps.completeForMember).not.toHaveBeenCalled();
    expect(body(h.sent[0])).toContain('Choose a task from the list');
  });
});

const textOf = (message: OutgoingMessage | undefined): string =>
  JSON.stringify(message?.components ?? []);

describe('review buttons', () => {
  it('approve with done replies privately and edits a V2 decision card', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({
      outcome: 'done',
      title: 'My Task',
      teamName: 'Robotics',
    });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.deps.decideReview).toHaveBeenCalledWith(USER, UUID_A, 2, 'approve');
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain('**✅ Approved**');
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.message.flags).toBe(32768);
    expect(textOf(h.edits[0]?.message)).toContain('APPROVED');
    expect(textOf(h.edits[0]?.message)).toContain(`Approved by <@${USER}>`);
    expect(textOf(h.edits[0]?.message)).toContain('Robotics');
    expect(h.edits[0]?.message.allowedMentions).toEqual({ parse: [] });
  });

  it('keeps the success reply when the post edit fails', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({
      outcome: 'done',
      title: 'My Task',
      teamName: 'Robotics',
    });
    h.deps.editBotMessage.mockRejectedValueOnce(new Error('Discord unavailable'));
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain('**✅ Approved**');
  });

  it('approve with not-authorised does not edit', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'not-authorised' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'reject', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain(ERROR_COPY['task.review-not-yours'].title);
    expect(h.edits).toHaveLength(0);
  });

  it('conflict on a second press does not edit', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'conflict' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain('This review is out of date');
    expect(textOf(h.sent[0])).toContain('Use the newest review post for this task.');
    expect(h.edits).toHaveLength(0);
  });
});

it('reject sends back with a private result and a silent V2 decision edit', async () => {
  const h = baseDeps();
  h.deps.decideReview.mockResolvedValueOnce({ outcome: 'sent-back', title: 'My Task' });
  await createTaskCommandSubscriber(h.deps).handle(
    interactionEvent(buildTaskCustomId({ action: 'reject', taskId: UUID_A, version: 2 })),
  );
  expect(h.deps.decideReview).toHaveBeenCalledWith(USER, UUID_A, 2, 'reject');
  expect(h.sent[0]?.flags).toBe(32768);
  expect(textOf(h.sent[0])).toContain('**↩️ Sent back**');
  expect(textOf(h.sent[0])).toContain('The task is back in progress.');
  expect(h.edits[0]?.message.flags).toBe(32768);
  expect(textOf(h.edits[0]?.message)).toContain('SENT BACK');
  expect(h.edits[0]?.message.allowedMentions).toEqual({ parse: [] });
});
it('pick recorded edits the public card to the same result without pings', async () => {
  const h = baseDeps();
  h.deps.pickReplyTask.mockResolvedValueOnce({ outcome: 'recorded', title: '@everyone **Task**' });
  await createTaskCommandSubscriber(h.deps).handle(
    interactionEvent(
      buildTaskCustomId({ action: 'pick', choiceMessageId: '777777777777777777', taskId: UUID_A }),
    ),
  );
  expect(h.sent[0]?.flags).toBe(32768);
  expect(textOf(h.sent[0])).toContain('**📝 Update recorded**');
  expect(h.edits[0]?.message).toEqual(h.sent[0]);
  expect(h.edits[0]?.message.allowedMentions).toEqual({ parse: [] });
  expect(textOf(h.sent[0])).not.toContain('On @everyone **Task**.');
});
it('pick gone uses the expired choice error card without an edit', async () => {
  const h = baseDeps();
  await createTaskCommandSubscriber(h.deps).handle(
    interactionEvent(
      buildTaskCustomId({ action: 'pick', choiceMessageId: '777777777777777777', taskId: UUID_A }),
    ),
  );
  expect(h.sent[0]?.flags).toBe(32768);
  expect(textOf(h.sent[0])).toContain(ERROR_COPY['task.choice-gone'].title);
  expect(h.edits).toHaveLength(0);
});
it('pins the exact changed-task catalogue copy', () => {
  expect(ERROR_COPY).toHaveProperty('task.changed', {
    title: 'This task just changed',
    detail: 'Someone edited it while you were choosing.',
    next: 'Run /task complete again.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  });
});

describe('pick buttons', () => {
  it('pick with not-yours replies accordingly', async () => {
    const h = baseDeps();
    h.deps.pickReplyTask.mockResolvedValueOnce({ outcome: 'not-yours' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(
        buildTaskCustomId({
          action: 'pick',
          choiceMessageId: '777777777777777777',
          taskId: UUID_A,
        }),
      ),
    );
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain(ERROR_COPY['task.choice-not-yours'].title);
    expect(h.edits).toHaveLength(0);
  });

  it('keeps the success reply when the post edit fails', async () => {
    const h = baseDeps();
    h.deps.pickReplyTask.mockResolvedValueOnce({ outcome: 'recorded', title: 'My Task' });
    h.deps.editBotMessage.mockRejectedValueOnce(new Error('Discord unavailable'));
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(
        buildTaskCustomId({
          action: 'pick',
          choiceMessageId: '777777777777777777',
          taskId: UUID_A,
        }),
      ),
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(32768);
    expect(textOf(h.sent[0])).toContain('**📝 Update recorded**');
    expect(textOf(h.sent[0])).toContain('On My Task.');
  });
});

describe('button errors', () => {
  it.each([
    ['approve', 'dependency'],
    ['reject', 'dependency'],
    ['pick', 'dependency'],
    ['approve', 'defer'],
    ['reject', 'defer'],
    ['pick', 'defer'],
  ] as const)('replies with the unavailable card when %s %s throws', async (action, throwing) => {
    const h = baseDeps();
    if (throwing === 'defer') h.defer.mockRejectedValueOnce(new Error('defer unavailable'));
    else if (action === 'pick') h.deps.pickReplyTask.mockRejectedValueOnce(new Error('db down'));
    else h.deps.decideReview.mockRejectedValueOnce(new Error('db down'));
    const customId =
      action === 'pick'
        ? buildTaskCustomId({ action, choiceMessageId: '777777777777777777', taskId: UUID_A })
        : buildTaskCustomId({ action, taskId: UUID_A, version: 2 });
    await createTaskCommandSubscriber(h.deps).handle(interactionEvent(customId));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(V2);
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(body(h.sent[0])).toContain("**❌ Couldn't update the task**");
    expect(body(h.sent[0])).toContain("Bananasaurs couldn't save the change. Nothing was changed.");
    expect(body(h.sent[0])).toContain('Try again in a minute.');
    expect(h.edits).toHaveLength(0);
  });
});

describe('foreign components', () => {
  it('ignores a foreign custom id with no defer', async () => {
    const h = baseDeps();
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(interactionEvent('bs.panel:a:b'));
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });
});

describe("I'm on it", () => {
  const start = () =>
    interactionEvent(buildTaskCustomId({ action: 'start', taskId: UUID_A, version: 2 }));

  it('acknowledges with a deferred update, starts the task and refreshes its card', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.startTask).toHaveBeenCalledWith(USER, UUID_A, 2);
    expect(h.refreshTaskCard).toHaveBeenCalledWith(UUID_A);
    expect(h.sent).toEqual([]);
  });

  it('waits for deferUpdate to resolve before starting or refreshing', async () => {
    const h = baseDeps();
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    h.deferUpdate.mockImplementationOnce(() => pending);
    const handling = createTaskCommandSubscriber(h.deps).handle(start());
    await Promise.resolve();
    expect(h.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.refreshTaskCard).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    acknowledge();
    await handling;
    expect(h.startTask).toHaveBeenCalledWith(USER, UUID_A, 2);
    expect(h.refreshTaskCard).toHaveBeenCalledWith(UUID_A);
    expect(h.sent).toEqual([]);
  });

  it.each(['started', 'stale'] as const)(
    'contains a refresh rejection after %s',
    async (outcome) => {
      const h = baseDeps();
      h.startTask.mockResolvedValueOnce(outcome);
      h.refreshTaskCard.mockRejectedValueOnce(new Error('edit unavailable'));
      await expect(createTaskCommandSubscriber(h.deps).handle(start())).resolves.toBeUndefined();
      expect(h.startTask).toHaveBeenCalledTimes(1);
      expect(h.refreshTaskCard).toHaveBeenCalledTimes(1);
      if (outcome === 'started') expect(h.sent).toEqual([]);
      else {
        expect(h.sent).toHaveLength(1);
        expect(JSON.stringify(h.sent[0]?.components)).toContain('This card was out of date');
        expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
        expect(h.sent[0]?.files ?? []).toEqual([]);
        expect(JSON.stringify(h.sent[0]?.components)).not.toContain('attachment://');
      }
    },
  );

  it.each(['not-yours', 'not-open', 'stale', 'throws'] as const)(
    'contains a reply rejection for %s without retrying',
    async (outcome) => {
      const h = baseDeps();
      if (outcome === 'throws') h.startTask.mockRejectedValueOnce(new Error('db'));
      else h.startTask.mockResolvedValueOnce(outcome);
      h.respond.mockRejectedValueOnce(new Error('expired'));
      await expect(createTaskCommandSubscriber(h.deps).handle(start())).resolves.toBeUndefined();
      expect(h.respond).toHaveBeenCalledTimes(1);
      const message = h.respond.mock.calls[0]?.[1];
      expect(message?.allowedMentions).toEqual({ parse: [] });
      expect(message?.files ?? []).toEqual([]);
      expect(JSON.stringify(message?.components)).not.toContain('attachment://');
      expect(h.refreshTaskCard).toHaveBeenCalledTimes(outcome === 'stale' ? 1 : 0);
      expect(h.sent).toEqual([]);
    },
  );

  it.each([
    ['not-yours', "This task isn't yours to pick up"],
    ['not-open', 'This task is closed'],
  ] as const)('%s: a private error card and no refresh', async (outcome, title) => {
    const h = baseDeps();
    h.startTask.mockResolvedValueOnce(outcome);
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.refreshTaskCard).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(1 << 15);
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(h.sent[0]?.files ?? []).toEqual([]);
    expect(JSON.stringify(h.sent[0]?.components)).not.toContain('attachment://');
    expect(JSON.stringify(h.sent[0]?.components)).toContain(title);
  });

  it('stale: refreshes the card and says so privately', async () => {
    const h = baseDeps();
    h.startTask.mockResolvedValueOnce('stale');
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.refreshTaskCard).toHaveBeenCalledWith(UUID_A);
    expect(JSON.stringify(h.sent[0]?.components)).toContain('This card was out of date');
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(h.sent[0]?.files ?? []).toEqual([]);
    expect(JSON.stringify(h.sent[0]?.components)).not.toContain('attachment://');
  });

  it('a failure while starting reports "Couldn\'t update the task"', async () => {
    const h = baseDeps();
    h.startTask.mockRejectedValueOnce(new Error('db'));
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(JSON.stringify(h.sent[0]?.components)).toContain("Couldn't update the task");
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(h.sent[0]?.files ?? []).toEqual([]);
    expect(JSON.stringify(h.sent[0]?.components)).not.toContain('attachment://');
  });

  it('does nothing else when the acknowledgement itself fails', async () => {
    const h = baseDeps();
    h.deferUpdate.mockRejectedValueOnce(new Error('expired'));
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });
});

describe('Post update', () => {
  it('opens the form at once, without deferring', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(
      interactionEvent(buildTaskCustomId({ action: 'update', taskId: UUID_A })),
    );
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.showModal).toHaveBeenCalledTimes(1);
    const modal = h.showModal.mock.calls[0]?.[1] as { custom_id: string; title: string };
    expect(modal.custom_id).toBe(`bs.task:update:${UUID_A}`);
    expect(JSON.stringify(modal)).toContain('Wire the brake light harness');
  });

  const submit = (
    fields: Record<string, string>,
    customId = `bs.task:update:${UUID_A}`,
  ): ModalSubmitEvent => ({
    kind: 'modalSubmit' as const,
    guildId: GUILD,
    receivedAtMs: 1,
    interactionId: '777777777777777777',
    token: 'modal-token',
    channelId: CHANNEL,
    messageId: '666666666666666666',
    userId: USER,
    customId,
    fields,
  });

  it('records the update and confirms privately', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(
      submit({ body: 'Left side done', blocker: '' }),
    );
    expect(h.defer).toHaveBeenCalledWith(expect.anything(), { ephemeral: true });
    expect(h.postUpdate).toHaveBeenCalledWith(
      USER,
      UUID_A,
      '777777777777777777',
      'Left side done',
      undefined,
    );
    expect(JSON.stringify(h.sent[0]?.components)).toContain('Update saved');
    expect(JSON.stringify(h.sent[0]?.components)).toContain('posted in the channel');
  });

  it('says nothing was posted when task posts are off', async () => {
    const h = baseDeps();
    h.postUpdate.mockResolvedValueOnce({ outcome: 'recorded', postsOn: false });
    await createTaskCommandSubscriber(h.deps).handle(submit({ body: 'x y z' }));
    expect(JSON.stringify(h.sent[0]?.components)).toContain('nothing was posted');
  });

  it.each(['not-yours', 'not-open'] as const)(
    '%s: not saved, and the text comes back to copy',
    async (outcome) => {
      const h = baseDeps();
      h.postUpdate.mockResolvedValueOnce({ outcome, postsOn: true });
      await createTaskCommandSubscriber(h.deps).handle(
        submit({ body: 'Left side done', blocker: 'connectors' }),
      );
      const json = JSON.stringify(h.sent[0]?.components);
      expect(json).toContain("Your update wasn't saved");
      expect(json).toContain('> Left side done');
      expect(json).toContain('> Blocked: connectors');
    },
  );

  it.each([
    ['whitespace-only', '   \n  \t '],
    ['over 1000 characters', `Done: ${'x'.repeat(1001)}`],
  ])('rejects a %s body without calling postUpdate', async (_label, body) => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(submit({ body }));
    expect(h.postUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(h.sent[0]?.components)).toContain("Your update wasn't saved");
  });

  it('rejects a blocker over 200 characters without calling postUpdate', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(
      submit({ body: 'Left side done', blocker: `b${'x'.repeat(200)}` }),
    );
    expect(h.postUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(h.sent[0]?.components)).toContain("Your update wasn't saved");
  });

  it('returns the trimmed text when postUpdate rejects it as invalid', async () => {
    const h = baseDeps();
    h.postUpdate.mockResolvedValueOnce({ outcome: 'invalid', postsOn: true });
    await createTaskCommandSubscriber(h.deps).handle(
      submit({ body: 'Left side done', blocker: 'connectors' }),
    );
    const json = JSON.stringify(h.sent[0]?.components);
    expect(json).toContain("Your update wasn't saved");
    expect(json).toContain('> Left side done');
  });

  it('ignores a modal that is not a task update', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(submit({ body: 'x' }, 'bs.mod:warn:1'));
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.postUpdate).not.toHaveBeenCalled();
  });
});

describe('Post update failure boundaries', () => {
  const event = (): ModalSubmitEvent => ({
    kind: 'modalSubmit',
    guildId: GUILD,
    receivedAtMs: 1,
    interactionId: '777777777777777777',
    token: 'modal-token',
    channelId: CHANNEL,
    messageId: undefined,
    userId: USER,
    customId: `bs.task:update:${UUID_A}`,
    fields: { body: ' Left side done ', blocker: ' connectors ' },
  });
  it('confirms a duplicate as saved without exposing mentions or attaching art', async () => {
    const h = baseDeps();
    h.postUpdate.mockResolvedValueOnce({ outcome: 'duplicate', postsOn: true });
    await createTaskCommandSubscriber(h.deps).handle(event());
    expect(JSON.stringify(h.sent[0]?.components)).toContain('Update saved');
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(h.sent[0]?.files ?? []).toEqual([]);
  });
  it('returns the typed text when saving throws, with no mentions', async () => {
    const h = baseDeps();
    h.postUpdate.mockRejectedValueOnce(new Error('offline'));
    await createTaskCommandSubscriber(h.deps).handle(event());
    expect(JSON.stringify(h.sent[0]?.components)).toContain("Couldn't update the task");
    expect(JSON.stringify(h.sent[0]?.components)).toContain('> Left side done');
    expect(JSON.stringify(h.sent[0]?.components)).toContain('> Blocked: connectors');
    expect(h.sent[0]?.allowedMentions).toEqual({ parse: [] });
  });
  it('does not write after a defer failure', async () => {
    const h = baseDeps();
    h.defer.mockRejectedValueOnce(new Error('expired'));
    await expect(createTaskCommandSubscriber(h.deps).handle(event())).resolves.toBeUndefined();
    expect(h.postUpdate).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
  });
  it('does not retry a reply rejection or a modal-open rejection', async () => {
    const h = baseDeps();
    h.respond.mockRejectedValueOnce(new Error('expired'));
    await expect(createTaskCommandSubscriber(h.deps).handle(event())).resolves.toBeUndefined();
    expect(h.respond).toHaveBeenCalledTimes(1);
    h.showModal.mockRejectedValueOnce(new Error('expired'));
    await expect(
      createTaskCommandSubscriber(h.deps).handle(interactionEvent(`bs.task:update:${UUID_A}`)),
    ).resolves.toBeUndefined();
    expect(h.showModal).toHaveBeenCalledTimes(1);
    expect(h.defer).toHaveBeenCalledTimes(1);
  });
});
