import { describe, expect, it, vi } from 'vitest';
import {
  createTaskCommandSubscriber,
  formatDueLabel,
  type TaskCommandDeps,
  type TaskCommandRow,
} from './commands.js';
import { buildTaskCustomId } from './components.js';
import type { OutgoingMessage } from '../discord/port.js';
import type { InteractionEvent, SlashCommandEvent } from '../discord/events.js';

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
  // `satisfies` keeps the mock types (so mockResolvedValueOnce exists) while
  // proving the harness matches the subscriber's real dependency shape.
  const deps = {
    guildId: GUILD,
    responder: { defer, respond },
    now: () => 1700000000000,
    listForMember,
    completableForMember,
    completeForMember,
    decideReview,
    pickReplyTask,
    editBotMessage,
  } satisfies TaskCommandDeps;
  return {
    sent,
    edits,
    defer,
    respond,
    deps,
  };
};

describe('/task list', () => {
  it('shows only rows given, with labels and overdue marker, capped at 15 with footer', async () => {
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
    const content = h.sent[0]?.content ?? '';
    expect(content).toContain('Not started');
    expect(content).toContain('In progress');
    expect(content).toContain('Awaiting approval');
    expect(content).toContain('(overdue)');
    expect(content).toContain('**Tech**');

    // 15-row cap footer
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
    const content2 = h2.sent[0]?.content ?? '';
    expect(content2).toContain('Showing 15 of 20.');
  });

  it('renders an ISO date for a bad timezone instead of throwing', async () => {
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
    const content = h.sent[0]?.content ?? '';
    const iso = new Date(dueAt).toISOString().slice(0, 10);
    expect(content).toContain(iso);
    expect(formatDueLabel(dueAt, 'Pacific Time')).toBe(iso);
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
    expect(h.sent[0]?.content).toBe('Which task is ready for review?');
    const components = h.sent[0]?.components as { type: number; components: { value: string }[] }[];
    const options = components[0]?.components[0] as unknown as { options: { value: string }[] };
    expect(options.options.map((o) => o.value)).toEqual([UUID_A, UUID_B]);
  });

  it('calls completeForMember with the selected id on select interaction', async () => {
    const h = baseDeps();
    h.deps.completeForMember.mockResolvedValueOnce('awaiting_approval');
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(interactionEvent(buildTaskCustomId({ action: 'complete' }), [UUID_A]));
    expect(h.deps.completeForMember).toHaveBeenCalledWith(USER, UUID_A);
    expect(h.sent[0]?.content).toMatch(/ready for review/);
  });
});

describe('review buttons', () => {
  it('approve with done edits the post with empty components', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'done', title: 'My Task' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.deps.decideReview).toHaveBeenCalledWith(USER, UUID_A, 2, 'approve');
    expect(h.sent[0]?.content).toBe('Approved.');
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.message).toMatchObject({ components: [] });
    expect(h.edits[0]?.message.content).toContain('Approved by');
  });

  it('keeps the success reply when the post edit fails', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'done', title: 'My Task' });
    h.deps.editBotMessage.mockRejectedValueOnce(new Error('Discord unavailable'));
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toBe('Approved.');
  });

  it('approve with not-authorised does not edit', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'not-authorised' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'reject', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent[0]?.content).toMatch(/Only this team's lead/);
    expect(h.edits).toHaveLength(0);
  });

  it('conflict on a second press does not edit', async () => {
    const h = baseDeps();
    h.deps.decideReview.mockResolvedValueOnce({ outcome: 'conflict' });
    const subscriber = createTaskCommandSubscriber(h.deps);
    await subscriber.handle(
      interactionEvent(buildTaskCustomId({ action: 'approve', taskId: UUID_A, version: 2 })),
    );
    expect(h.sent[0]?.content).toMatch(/changed since this post/);
    expect(h.edits).toHaveLength(0);
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
    expect(h.sent[0]?.content).toBe('Only the person who posted the update can choose.');
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
    expect(h.sent[0]?.content).toBe('Update recorded.');
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
