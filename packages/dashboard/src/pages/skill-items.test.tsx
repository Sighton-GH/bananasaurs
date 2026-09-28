// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { SkillItemsCard } from './skill-items.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const DUE_AT = 1890000000000;

const REMINDERS = {
  kind: 'reminders',
  reminders: [
    {
      id: 'rem-1',
      creatorId: 'user-bryan',
      creatorName: 'Bryan',
      destinationId: 'chan-general',
      destinationName: 'general',
      text: 'Standup time',
      context: 'Daily sync',
      dueAt: DUE_AT,
      status: 'scheduled',
      recurrence: { pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' },
      mentions: { userIds: ['user-aston'], roleIds: ['role-mods'], everyone: true, here: false },
      deliveredCount: 0,
    },
    {
      id: 'rem-2',
      creatorId: 'user-bryan',
      destinationId: 'chan-general',
      text: 'Old news',
      dueAt: 1790000000000,
      status: 'delivered',
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: 1,
    },
  ],
} as const;

const PROPOSALS = {
  kind: 'memory-proposals',
  proposals: [
    {
      id: 'dec-1',
      kind: 'memory',
      summary: 'The club meets on Mondays.',
      status: 'draft',
      requesterId: 'user-bryan',
      provenance: 'chat',
      at: 1790000000000,
    },
  ],
} as const;

const DECISIONS = {
  kind: 'decisions',
  decisions: [
    {
      id: 'dec-2',
      kind: 'decision',
      summary: 'Buy more filament.',
      status: 'draft',
      requesterId: 'user-aston',
      provenance: 'chat',
      at: 1790000000000,
    },
    {
      id: 'dec-3',
      kind: 'decision',
      summary: 'Book room 204.',
      status: 'reviewed',
      requesterId: 'user-aston',
      provenance: 'chat',
      at: 1790000001000,
    },
  ],
} as const;

describe('SkillItemsCard', () => {
  it('renders nothing for items of kind none', () => {
    const { container } = renderWithSession(<SkillItemsCard items={{ kind: 'none' }} reload={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('renders reminders with when, message, where, pings, set-by and status, history collapsed', () => {
    stubFetch([]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(REMINDERS))} reload={() => undefined} />,
    );
    const card = screen.getByRole('heading', { name: 'Reminders' }).closest('section')!;
    expect(within(card).getByText('Standup time')).toBeTruthy();
    expect(within(card).getByText('Daily sync')).toBeTruthy();
    expect(within(card).getByText('#general')).toBeTruthy();
    expect(within(card).getByText(/@everyone/)).toBeTruthy();
    expect(within(card).getByText(/1 role/)).toBeTruthy();
    expect(within(card).getByText(/1 user/)).toBeTruthy();
    expect(within(card).getByText('Bryan')).toBeTruthy();
    expect(within(card).getByText('scheduled')).toBeTruthy();
    expect(within(card).getByText(/repeats daily/)).toBeTruthy();
    const history = within(card).getByText('History').closest('details')!;
    expect(history.open).toBe(false);
    expect(within(history).getByText('Old news')).toBeTruthy();
  });

  it('editing only the text PATCHes only text', async () => {
    const reload = vi.fn();
    const mock = stubFetch([
      { method: 'PATCH', url: '/api/assistant/reminders/rem-1', body: { ok: true } },
    ]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(REMINDERS))} reload={reload} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('heading', { name: 'Edit reminder' }).closest('section')!;
    fireEvent.change(within(dialog).getByLabelText('Message'), {
      target: { value: 'Standup moved' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const patch = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/reminders/rem-1' &&
        (c[1] as RequestInit)?.method === 'PATCH',
    )!;
    expect(bodyOf(patch)).toEqual({ text: 'Standup moved' });
    expect(reload).toHaveBeenCalled();
  });

  it('Stop repeating PATCHes recurrence null', async () => {
    const mock = stubFetch([
      { method: 'PATCH', url: '/api/assistant/reminders/rem-1', body: { ok: true } },
    ]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(REMINDERS))} reload={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('heading', { name: 'Edit reminder' }).closest('section')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop repeating' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const patch = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/reminders/rem-1' &&
        (c[1] as RequestInit)?.method === 'PATCH',
    )!;
    expect(bodyOf(patch)).toEqual({ recurrence: null });
  });

  it('shows the server message when the edit is refused with a 400', async () => {
    stubFetch([
      {
        method: 'PATCH',
        url: '/api/assistant/reminders/rem-1',
        status: 400,
        body: { error: 'invalid-reminder', message: 'reminder text must be 1 to 1500 characters' },
      },
    ]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(REMINDERS))} reload={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('heading', { name: 'Edit reminder' }).closest('section')!;
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('reminder text must be 1 to 1500 characters'),
    ).toBeTruthy();
  });

  it('Cancel confirms in a dialog before posting', async () => {
    const reload = vi.fn();
    const mock = stubFetch([
      { method: 'POST', url: '/api/assistant/reminders/rem-1/cancel', body: { ok: true } },
    ]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(REMINDERS))} reload={reload} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Cancel this reminder\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      mock.mock.calls.some(
        (c) =>
          (c[0] as string) === '/api/assistant/reminders/rem-1/cancel' &&
          (c[1] as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
    expect(reload).toHaveBeenCalled();
  });

  it('lists memory proposals with a Review in Memory link', () => {
    stubFetch([]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(PROPOSALS))} reload={() => undefined} />,
    );
    const card = screen.getByRole('heading', { name: 'Memory proposals' }).closest('section')!;
    expect(within(card).getByText('The club meets on Mondays.')).toBeTruthy();
    expect(within(card).getByText(/user-bryan/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Review in Memory' }).getAttribute('href')).toBe(
      '/memory',
    );
  });

  it('lists decisions with Review for drafts and Save for reviewed records', async () => {
    const reload = vi.fn();
    const mock = stubFetch([
      { method: 'POST', url: '/api/assistant/decisions/dec-2/review', body: { ok: true } },
      { method: 'POST', url: '/api/assistant/decisions/dec-3/save', body: { ok: true } },
    ]);
    renderWithSession(
      <SkillItemsCard items={JSON.parse(JSON.stringify(DECISIONS))} reload={reload} />,
    );
    const card = screen.getByRole('heading', { name: 'Decisions' }).closest('section')!;
    expect(within(card).getByText('Buy more filament.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Review' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      mock.mock.calls.some(
        (c) =>
          (c[0] as string) === '/api/assistant/decisions/dec-2/review' &&
          (c[1] as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const save = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/decisions/dec-3/save' &&
        (c[1] as RequestInit)?.method === 'POST',
    )!;
    expect(bodyOf(save)).toEqual({});
    expect(reload).toHaveBeenCalled();
  });
});
