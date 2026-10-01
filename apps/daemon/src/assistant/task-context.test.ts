import { describe, expect, it, vi } from 'vitest';
import { boundedTaskContext } from './task-context.js';
import { taskRepo } from '@bananasaurs/storage';
const scope = { guildId: '111111111111111111' } as Parameters<typeof boundedTaskContext>[0];
const task = {
  taskId: 'task-1',
  teamId: 'team-1',
  title: '@everyone Engine tune',
  destinationId: 'channel-1',
  status: 'in_progress',
  dueAt: 1791000000000,
  assignmentKind: 'team',
  assigneeId: null,
};
const port = {
  access: vi.fn().mockResolvedValue({
    actorId: 'member-1',
    president: false,
    leadTeamIds: [],
    teams: [{ teamId: 'team-1', name: 'Engine', kind: 'subteam', categoryId: 'category-1' }],
  }),
  anchorTaskId: vi.fn().mockReturnValue('task-1'),
};

describe('bounded task context', () => {
  it('does not read private tasks for an unrelated message', async () => {
    const spy = vi.spyOn(taskRepo, 'listTasks');
    expect(
      await boundedTaskContext(scope, port, {
        actorId: 'member-1',
        channelId: 'channel-1',
        text: 'hello',
      }),
    ).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('does not expose tasks when actor access is absent', async () => {
    const spy = vi.spyOn(taskRepo, 'listTasks');
    expect(
      await boundedTaskContext(
        scope,
        { access: async () => undefined },
        { actorId: 'member-1', channelId: 'channel-1', text: 'task update' },
      ),
    ).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('includes only accessible destination tasks with the read-only instruction', async () => {
    const spy = vi
      .spyOn(taskRepo, 'listTasks')
      .mockReturnValue([
        task,
        { ...task, taskId: 'task-2', teamId: 'elsewhere' },
        { ...task, taskId: 'task-3', destinationId: 'another-channel' },
      ] as ReturnType<typeof taskRepo.listTasks>);
    const text = await boundedTaskContext(scope, port, {
      actorId: 'member-1',
      channelId: 'channel-1',
      text: 'Task update: done',
    });
    expect(text).toContain(
      "To log progress, the member replies directly to the task's post or reminder in Discord.",
    );
    expect(text).not.toContain('Ask which task');
    expect(text).toContain('task-1');
    expect(text).not.toContain('task-2');
    expect(text).not.toContain('task-3');
    expect(text).not.toContain('@everyone');
    spy.mockRestore();
  });
  it('uses the exact anchor and still avoids a model write', async () => {
    const spy = vi
      .spyOn(taskRepo, 'listTasks')
      .mockReturnValue([task] as ReturnType<typeof taskRepo.listTasks>);
    const text = await boundedTaskContext(scope, port, {
      actorId: 'member-1',
      channelId: 'channel-1',
      referencedMessageId: 'anchor-1',
      text: 'Done',
    });
    expect(port.anchorTaskId).toHaveBeenCalledWith('channel-1', 'anchor-1');
    expect(text).toContain(
      "To log progress, the member replies directly to the task's post or reminder in Discord.",
    );
    expect(text).toContain('Do not claim anything was recorded or changed.');
    spy.mockRestore();
  });
});
