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
    mentionRoleId: 'role-club-assistant',
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
    mentionRoleId: 'role-it-help',
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
    { id: 'role-club-assistant', name: 'Club Assistant', position: 20 },
    { id: 'role-it-help', name: 'IT Help', position: 15 },
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
  ]);
  renderWithSession(<AssistantPage />);
  return mock;
}

describe('AssistantPage', () => {
  it('renders behaviours with their tag mapping, prompt editor, AI status and records', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Assistant' })).toBeTruthy();
    const club = screen.getByRole('button', { name: /Club assistant/ });
    expect(club.getAttribute('aria-pressed')).toBe('true');
    expect(within(club).getByText('Members mention @Club Assistant')).toBeTruthy();
    expect(screen.getByDisplayValue('Answer with reviewed club knowledge only.')).toBeTruthy();
    expect(screen.getByText('AI status')).toBeTruthy();
    expect(screen.getByText('Buy two spare batteries')).toBeTruthy();
  });

  it('keeps skills, schedules and resources off this page (ADR 0060 declutter)', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Assistant' });
    expect(screen.queryByText('Things the assistant can do')).toBeNull();
    expect(screen.queryByText('Skill grants')).toBeNull();
    expect(screen.queryByText('Schedules and reminders')).toBeNull();
    expect(screen.queryByText('Resources and context')).toBeNull();
    expect(screen.queryByText('Bring the robot battery')).toBeNull();
    expect(screen.queryByText('https://example.com/handbook')).toBeNull();
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
      mentionRoleId: 'role-club-assistant',
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
    const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    fireEvent.change(editor, { target: { value: 'Unsaved rewrite of the club prompt.' } });
    fireEvent.click(await screen.findByRole('button', { name: /IT services/ }));
    const switched = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    expect(switched.value).toBe('Answer infrastructure questions.');
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

  it('shows decision records as drafts, never as policy', async () => {
    renderPage();
    expect(await screen.findByText('Buy two spare batteries')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText(/A draft is analysis, not club policy/)).toBeTruthy();
    expect(screen.getByText('from #general, 12 messages cited')).toBeTruthy();
  });

  it('creates a new tag behaviour disabled, through the PUT create path', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const id = `new-member-help-${NOW.toString(36)}`;
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
      { method: 'PUT', url: `/api/assistant/behaviours/${id}`, body: { ok: true } },
    ]);
    renderWithSession(<AssistantPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
    // Submit stays disabled until the mention role is chosen from the live directory.
    const submit = screen.getAllByRole('button', { name: 'Create behaviour' })[0]!;
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New member help' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), {
      target: { value: 'help' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mention role' }), {
      target: { value: 'role-onboarding' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
      target: { value: 'Answer new member questions from reviewed sources only.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Search club knowledge/ }));
    const callers = screen.getByRole('list', { name: 'Who may use the new behaviour' });
    fireEvent.click(within(callers).getByRole('checkbox', { name: 'Club Member' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Create behaviour' })[0]!);
    await screen.findByText('New member help created');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === `/api/assistant/behaviours/${id}` && c[1]?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      id,
      surface: 'help',
      mentionRoleId: 'role-onboarding',
      name: 'New member help',
      systemPrompt: 'Answer new member questions from reviewed sources only.',
      promptVersion: 0,
      allowedSkillIds: ['search-club'],
      resourceIds: [],
      callerRoleIds: ['role-club-member'],
      enabled: false,
    });
  });

  it('states the fail-closed and ambiguous-tag rules inside the create form', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
    expect(
      await screen.findByText(/An empty allowlist fails closed: the behaviour answers nobody/),
    ).toBeTruthy();
    expect(
      screen.getByText(/A role mapped to two behaviours is refused rather than answered by a mix/),
    ).toBeTruthy();
    expect(screen.getByText(/New behaviours start turned off/)).toBeTruthy();
  });

  it('maps a mention-role refusal to a plain-language inline error', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const id = `welcome-${NOW.toString(36)}`;
    stubFetch([
      { url: '/api/assistant', body: FULL },
      {
        method: 'PUT',
        url: `/api/assistant/behaviours/${id}`,
        status: 400,
        body: { error: 'mention-role-required' },
      },
    ]);
    renderWithSession(<AssistantPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Welcome' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mention role' }), {
      target: { value: 'role-onboarding' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
      target: { value: 'Welcome new members.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create behaviour' })[0]!);
    expect(
      await screen.findByText(
        'Choose the Discord role members will mention to reach this behaviour.',
      ),
    ).toBeTruthy();
  });

  it('cannot create a behaviour when the role directory did not load', async () => {
    const body = { ...FULL } as Record<string, unknown>;
    delete body['roles'];
    renderPage(body);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
    expect(
      await screen.findByText(/no mention role can be chosen and the behaviour cannot be created/),
    ).toBeTruthy();
    const submit = screen.getAllByRole('button', { name: 'Create behaviour' })[0]!;
    expect(submit.hasAttribute('disabled')).toBe(true);
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
