// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantPage } from './assistant.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const BEHAVIOURS = [
  {
    id: 'club',
    guildId: '1540816150026518620',
    surface: 'bananasaurs',
    name: 'Club assistant',
    systemPrompt: 'Answer with reviewed club knowledge only.',
    promptVersion: 1,
    allowedSkillIds: ['search-club', 'create-reminder'],
    resourceIds: ['handbook'],
    enabled: true,
    callerRoleIds: ['role-club-member'],
  },
  {
    id: 'it',
    guildId: '1540816150026518620',
    surface: 'it-services',
    name: 'IT services',
    systemPrompt: 'Answer infrastructure questions.',
    promptVersion: 1,
    allowedSkillIds: ['open-resource'],
    resourceIds: [],
    enabled: false,
    callerRoleIds: [],
    ticket: { reviewerRoleIds: [] },
  },
];

const SKILLS = [
  {
    id: 'search-club',
    name: 'Search club knowledge',
    description: 'Search enabled Discord archive and reviewed resources.',
    effect: 'read',
    requiredPermission: 'assistant.search',
    requiresConfirmation: false,
  },
  {
    id: 'create-reminder',
    name: 'Set a reminder',
    description: 'Schedule a reminder for the requester or an allowed channel.',
    effect: 'schedule',
    requiredPermission: 'assistant.reminders.create',
    requiresConfirmation: true,
  },
  {
    id: 'open-resource',
    name: 'Link a club resource',
    description: 'Return a reviewed website, document or channel link.',
    effect: 'read',
    requiredPermission: 'assistant.resources',
    requiresConfirmation: false,
  },
  {
    id: 'send-reminder',
    name: 'Deliver a reminder',
    description: 'Send a due reminder through the configured Discord destination.',
    effect: 'send',
    requiredPermission: 'assistant.reminders.deliver',
    ownerOnly: true,
    requiresConfirmation: false,
  },
];

const FULL = {
  behaviours: BEHAVIOURS,
  resources: [
    {
      id: 'handbook',
      guildId: '1540816150026518620',
      title: 'Club handbook',
      url: 'https://example.com/handbook',
      kind: 'document',
      enabled: true,
      reviewedAt: '2026-09-01T12:00:00.000Z',
    },
  ],
  reminders: [
    {
      id: 'rem-1',
      text: 'Bring the robot battery',
      dueAt: 1790000000000,
      destinationId: '123456789012345678',
      status: 'failed',
    },
  ],
  skills: SKILLS,
  activity: [],
  roles: [
    { id: 'role-club-member', name: 'Club Member', position: 10 },
    { id: 'role-onboarding', name: 'Onboarding', position: 5 },
  ],
  members: [
    { id: 'user-bryan', name: 'Bryan' },
    { id: 'user-aston', name: 'Aston' },
  ],
  channels: [
    { id: 'chan-it', name: 'it-services' },
    { id: 'chan-general', name: 'general' },
  ],
  skillGrants: [{ skillId: 'create-reminder', roleIds: [], userIds: ['user-bryan'] }],
  tickets: [
    {
      id: 'ticket-1',
      behaviourId: 'it',
      channelId: 'chan-it',
      requesterId: 'user-aston',
      summary: 'Wi-Fi certificate install',
      status: 'open',
      at: 1790000000000,
    },
  ],
  decisions: [
    {
      id: 'dec-1',
      kind: 'decision',
      summary: 'Buy two spare batteries',
      status: 'draft',
      requesterId: 'user-aston',
      provenance: 'from #general, 12 messages cited',
      at: 1790000000000,
    },
  ],
};

function renderPage(body: unknown = FULL) {
  const mock = stubFetch([
    { url: '/api/assistant', body },
    { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/behaviours/it', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/skill-grants/create-reminder', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/resources/handbook', body: { ok: true } },
  ]);
  renderWithSession(<AssistantPage />);
  return mock;
}

describe('AssistantPage', () => {
  it('renders behaviours, detail, skills, reminders and resources', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Assistant' })).toBeTruthy();
    const club = screen.getByRole('button', { name: /Club assistant/ });
    expect(club.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByDisplayValue('Answer with reviewed club knowledge only.')).toBeTruthy();
    expect(screen.getAllByText('Search club knowledge').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Asks an operator first').length).toBeGreaterThan(0);
    expect(screen.getByText('Bring the robot battery')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('https://example.com/handbook')).toBeTruthy();
    expect(screen.getByText(/reviewed 2026-09-01/)).toBeTruthy();
  });

  it('saves the caller-role allowlist through the behaviour endpoint, whole object', async () => {
    const mock = renderPage();
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    const onboarding = within(region).getByRole('checkbox', { name: 'Onboarding' });
    expect(onboarding).toBeTruthy();
    fireEvent.click(onboarding);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByText('Club assistant access saved');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      id: 'club',
      surface: 'bananasaurs',
      name: 'Club assistant',
      systemPrompt: 'Answer with reviewed club knowledge only.',
      promptVersion: 1,
      allowedSkillIds: ['search-club', 'create-reminder'],
      resourceIds: ['handbook'],
      enabled: true,
      callerRoleIds: ['role-club-member', 'role-onboarding'],
    });
  });

  it('fails closed when the server build does not expose role allowlists', async () => {
    renderPage({
      ...FULL,
      behaviours: FULL.behaviours.map(({ callerRoleIds: _drop, ...b }) => b),
    });
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    expect(
      screen.getByText(/Role allowlists are not exposed by this server build yet/),
    ).toBeTruthy();
    expect(within(region).queryByRole('checkbox')).toBeNull();
  });

  it('fails closed when the role directory does not load', async () => {
    const body = { ...FULL } as Record<string, unknown>;
    delete body['roles'];
    renderPage(body);
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    expect(
      within(region).getByText(/The role directory did not load, so this list cannot be edited/),
    ).toBeTruthy();
    expect(within(region).queryByRole('checkbox')).toBeNull();
  });

  it('toggles behaviour enablement through the same whole-object write', async () => {
    const mock = renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Turn off - members will get no answer' }),
    );
    await screen.findByText('Club assistant disabled');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { enabled: boolean }).enabled).toBe(false);
  });

  it("never carries one behaviour's edited prompt onto another (B3)", async () => {
    const mock = renderPage();
    // Edit behaviour A's prompt, then switch to behaviour B WITHOUT saving.
    const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    fireEvent.change(editor, { target: { value: 'Unsaved rewrite of the club prompt.' } });
    fireEvent.click(await screen.findByRole('button', { name: /IT services/ }));
    // The editor must show B's prompt, not A's unsaved text.
    const switched = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    expect(switched.value).toBe('Answer infrastructure questions.');
    // Saving now writes B's object to B's endpoint — A's text cannot land on B.
    fireEvent.change(switched, { target: { value: 'New IT prompt.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await screen.findByText('IT services prompt saved');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/it' && c[1]?.method === 'PUT',
    )!;
    const body = bodyOf(put) as { systemPrompt: string };
    expect(body.systemPrompt).toBe('New IT prompt.');
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('configures ticket routing for it-services with a fail-closed empty channel', async () => {
    const mock = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /IT services/ }));
    // No channel selected: the fail-closed notice shows before anything is saved.
    expect(await screen.findByText(/ticket creation fails closed/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Ticket channel' }), {
      target: { value: 'chan-it' },
    });
    const reviewers = screen.getByRole('list', { name: 'Ticket reviewer roles' });
    fireEvent.click(within(reviewers).getByRole('checkbox', { name: 'Club Member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByText('IT services access saved');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/it' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { ticket: unknown }).ticket).toEqual({
      channelId: 'chan-it',
      reviewerRoleIds: ['role-club-member'],
    });
  });

  it('shows ticket status for the selected behaviour', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /IT services/ }));
    const table = await screen.findByRole('table', { name: 'Escalation tickets' });
    expect(within(table).getByText('Wi-Fi certificate install')).toBeTruthy();
    expect(within(table).getByText('Aston')).toBeTruthy();
    expect(within(table).getByText('#it-services')).toBeTruthy();
    expect(within(table).getByText('open')).toBeTruthy();
  });

  it('saves a skill grant and keeps owner-only skills unwidened', async () => {
    const mock = renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Assistant' });
    const grants = screen.getByRole('heading', { name: 'Skill grants' }).closest('section')!;
    const row = within(grants).getByText('Set a reminder').closest('li')!;
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save grant' }));
    await screen.findByText('Set a reminder grant saved');
    const put = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/skill-grants/create-reminder' &&
        c[1]?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({ roleIds: ['role-onboarding'], userIds: ['user-bryan'] });
    // The owner-only skill offers no editor.
    const ownerRow = within(grants).getByText('Deliver a reminder').closest('li')!;
    expect(within(ownerRow).queryByRole('checkbox')).toBeNull();
    expect(within(ownerRow).getByText(/Always restricted to the server owner/)).toBeTruthy();
  });

  it('adds a resource through the reviewed endpoint and surfaces URL refusal inline', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
      {
        method: 'PUT',
        url: `/api/assistant/resources/res-${NOW.toString(36)}`,
        status: 400,
        body: { error: 'unsafe-resource-url' },
      },
    ]);
    renderWithSession(<AssistantPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add resource' }))[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Club website' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: 'http://169.254.169.254/meta' },
    });
    const submit = screen
      .getAllByRole('button', { name: 'Add resource' })
      .find((b) => b.getAttribute('type') === 'submit')!;
    fireEvent.click(submit);
    expect(
      await screen.findByText(
        'That address is not allowed: private and local addresses are refused.',
      ),
    ).toBeTruthy();
    const put = mock.mock.calls.find((c) =>
      (c[0] as string).startsWith('/api/assistant/resources/'),
    )!;
    expect(put[1]?.method).toBe('PUT');
    const sent = bodyOf(put) as { id: string; title: string; enabled: boolean };
    expect(sent.id).toMatch(/^res-/);
    expect(sent.title).toBe('Club website');
    expect(sent.enabled).toBe(true);
  });

  it('enables a disabled resource with a whole-object write', async () => {
    const mock = renderPage({
      ...FULL,
      resources: [{ ...FULL.resources[0]!, enabled: false }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/resources/handbook' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { enabled: boolean }).enabled).toBe(true);
  });

  it('shows decision records as drafts, never as policy', async () => {
    renderPage();
    expect(await screen.findByText('Buy two spare batteries')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText(/A draft is analysis, not club policy/)).toBeTruthy();
    expect(screen.getByText('from #general, 12 messages cited')).toBeTruthy();
  });

  it('empty state can create the working default behaviour', async () => {
    renderPage({ ...FULL, behaviours: [] });
    expect(await screen.findByText('No assistant behaviour configured')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create default behaviour' })).toBeTruthy();
  });

  it('offers no control without a backing endpoint', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Assistant' });
    for (const label of [/Edit behaviour/, /Run test scenario/, /New reminder/]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Save instructions' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant settings/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
