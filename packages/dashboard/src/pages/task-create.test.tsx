// @vitest-environment jsdom
import { cleanup, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { TaskCreatePage } from './task-create.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const TEAMS = {
  teams: [{ teamId: 'one', name: 'Tech', categoryId: '333333333333333333' }],
  tasks: [],
};

const DESTINATIONS = {
  destinations: [
    { channelId: '444444444444444444', name: 'tech-tasks', kind: 'channel' },
    {
      channelId: '555555555555555555',
      name: 'help-thread',
      kind: 'thread',
      parentName: 'tech-tasks',
    },
  ],
};

const ASSIGNEES = {
  assignees: [{ memberId: '555555555555555555', displayName: 'Alex' }],
};

function renderCreate(
  extraRoutes: readonly { method?: string; url: string; status?: number; body: unknown }[] = [],
) {
  const mock = stubFetch([
    { url: '/api/tasks', body: TEAMS },
    { url: '/api/tasks/teams/one/destinations', body: DESTINATIONS },
    { url: '/api/tasks/teams/one/assignees', body: ASSIGNEES },
    ...extraRoutes,
  ]);
  renderWithSession(
    <Router>
      <TaskCreatePage />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

describe('task creation', () => {
  it('does not show the form to non-owner sessions', () => {
    stubFetch([]);
    renderWithSession(
      <Router>
        <TaskCreatePage />
      </Router>,
    );
    expect(screen.getByText(/Setting up tasks needs the owner/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save task' })).toBeNull();
  });

  it('offers an individual assignment from verified team members', async () => {
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Team'), { target: { value: 'one' } });
    fireEvent.change(screen.getByLabelText('Assignment'), { target: { value: 'individual' } });
    expect(await screen.findByRole('option', { name: 'Alex' })).toBeTruthy();
  });

  it('create form sends description, timezone and extraReminderAt', async () => {
    const mock = renderCreate([
      { method: 'POST', url: '/api/tasks', body: { taskId: 'task-new' } },
    ]);
    fireEvent.change(await screen.findByLabelText('Team'), { target: { value: 'one' } });
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Some details' },
    });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    fireEvent.change(await screen.findByLabelText(/destination/i), {
      target: { value: '444444444444444444' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));
    fireEvent.change(await screen.findByLabelText(/extra reminder 1/i), {
      target: { value: '2026-10-09T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = bodyOf(posts[0]!) as Record<string, unknown>;
      expect(body['description']).toBe('Some details');
      expect(typeof body['timezone']).toBe('string');
      expect((body['timezone'] as string).length).toBeGreaterThan(0);
      expect(Array.isArray(body['extraReminderAt'])).toBe(true);
      expect((body['extraReminderAt'] as unknown[]).length).toBe(1);
    });
  });
});
