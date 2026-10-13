// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { Route } from 'wouter';
import { AssistantPage } from './assistant.js';
import { AssistantBehaviourDetailPage } from './behaviours/detail.js';

const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

afterEach(cleanup);
beforeEach(() => window.history.pushState({}, '', '/'));
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
    preferredSkillIds: ['search-club', 'create-reminder'],
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
    preferredSkillIds: ['open-resource'],
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
    id: 'draft-post',
    name: 'Draft an announcement',
    description: 'Draft a club announcement for an operator to send.',
    effect: 'draft',
    requiredPermission: 'assistant.draft',
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

const WRITES = [
  { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
  { method: 'PUT', url: '/api/assistant/behaviours/it', body: { ok: true } },
];

/** The list page (`/assistant`), optionally on a named tab. */
function renderPage(body: unknown = FULL, tab?: string) {
  window.history.pushState({}, '', tab === undefined ? '/assistant' : `/assistant?tab=${tab}`);
  const mock = stubFetch([{ url: '/api/assistant', body }, ...WRITES]);
  renderWithSession(<AssistantPage />);
  return mock;
}

/** One behaviour's page (`/assistant/behaviours/:id`) on a tab. */
function renderDetail(id = 'club', tab = 'prompt', body: unknown = FULL) {
  window.history.pushState({}, '', `/assistant/behaviours/${id}?tab=${tab}`);
  const mock = stubFetch([{ url: '/api/assistant', body }, ...WRITES]);
  renderWithSession(
    <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
  );
  return mock;
}

async function pickOption(option: string | RegExp, name?: string | RegExp) {
  const user = userEvent.setup();
  if (name !== undefined) await user.click(await screen.findByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('AssistantPage', () => {
  it('states its purpose sentence (Task 9)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    expect(
      screen.getByText('Behaviours decide who answers, how they sound, and who may ask.'),
    ).toBeTruthy();
  });

  it('lists behaviours in a table with tag mapping, who can use them, skills and status', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Assistant behaviours' });
    const club = within(table).getByRole<HTMLAnchorElement>('link', { name: 'Club assistant' });
    expect(club.pathname).toBe('/assistant/behaviours/club');
    const row = club.closest('tr')!;
    expect(within(row).getByText('Members mention @Club Assistant')).toBeTruthy();
    expect(within(row).getByText('Club Member')).toBeTruthy();
    expect(within(row).getByText('Search club knowledge, Set a reminder')).toBeTruthy();
    expect(within(row).getByText('On')).toBeTruthy();
    // IT services has an empty allowlist: it fails closed and says nobody.
    const itRow = within(table).getByRole('link', { name: 'IT services' }).closest('tr')!;
    expect(within(itRow).getByText('Nobody yet')).toBeTruthy();
    expect(within(itRow).getByText('Off')).toBeTruthy();
    // The editors live on the behaviour page, not on the list.
    expect(
      screen.queryByRole('textbox', { name: 'Instructions the assistant follows' }),
    ).toBeNull();
  });

  it('says plainly when a server build does not expose the allowlist', async () => {
    renderPage({
      ...FULL,
      behaviours: FULL.behaviours.map(({ callerRoleIds: _drop, ...b }) => b),
    });
    const table = await screen.findByRole('table', { name: 'Assistant behaviours' });
    expect(within(table).getAllByText('Not shown by this server')).toHaveLength(2);
    expect(within(table).queryByText(/everyone|anyone/i)).toBeNull();
  });

  it('labels a direct command and badges On and Off', async () => {
    const direct = {
      id: 'ask',
      guildId: '1540816150026518620',
      surface: 'direct-command',
      name: 'Club Q and A',
      systemPrompt: 'Answer member questions.',
      promptVersion: 1,
      preferredSkillIds: [],
      resourceIds: [],
      enabled: true,
      callerRoleIds: [],
    };
    renderPage({ ...FULL, behaviours: [direct, BEHAVIOURS[1]!] });
    const row = (await screen.findByRole('link', { name: 'Club Q and A' })).closest('tr')!;
    expect(within(row).getByText('Direct command: members tag @Bananasaurs')).toBeTruthy();
    expect(within(row).getByText('On')).toBeTruthy();
    const itRow = screen.getByRole('link', { name: 'IT services' }).closest('tr')!;
    expect(within(itRow).getByText('Off')).toBeTruthy();
    expect(screen.queryByText('enabled')).toBeNull();
    expect(screen.queryByText('disabled')).toBeNull();
  });

  it('shows no AI status card and no answering claim outside the setup tracker', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Behaviours' });
    expect(screen.queryByText('AI status')).toBeNull();
    expect(screen.queryByText('Off - the assistant will not answer')).toBeNull();
    expect(screen.queryByText('Enabled')).toBeNull();
  });

  it('keeps skills, schedules and resources off this page (ADR 0060 declutter)', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Behaviours' });
    expect(screen.queryByText('Things the assistant can do')).toBeNull();
    expect(screen.queryByText('Skill grants')).toBeNull();
    expect(screen.queryByText('Schedules and reminders')).toBeNull();
    expect(screen.queryByText('Resources and context')).toBeNull();
    expect(screen.queryByText('Bring the robot battery')).toBeNull();
    expect(screen.queryByText('https://example.com/handbook')).toBeNull();
  });

  it('saves the caller-role allowlist through the behaviour endpoint, whole object', async () => {
    const mock = renderDetail('club', 'access');
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
      preferredSkillIds: ['search-club', 'create-reminder'],
      resourceIds: ['handbook'],
      enabled: true,
      callerRoleIds: ['role-club-member', 'role-onboarding'],
    });
  });

  it('fails closed when the server build does not expose role allowlists', async () => {
    renderDetail('club', 'access', {
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
    renderDetail('club', 'access', body);
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    expect(
      within(region).getByText(/The role directory did not load, so this list cannot be edited/),
    ).toBeTruthy();
    expect(within(region).queryByRole('checkbox')).toBeNull();
  });

  it('toggles behaviour enablement through the same whole-object write', async () => {
    const mock = renderDetail('club');
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
    const mock = renderDetail('club');
    const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions the assistant follows',
    });
    fireEvent.change(editor, { target: { value: 'Unsaved rewrite of the club prompt.' } });
    window.history.pushState({}, '', '/assistant/behaviours/it?tab=prompt');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'IT services' });
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
    const mock = renderDetail('it', 'access');
    expect(await screen.findByText(/ticket creation fails closed/)).toBeTruthy();
    await pickOption('#it-services', 'Ticket channel');
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
    renderDetail('it', 'access');
    const table = await screen.findByRole('table', { name: 'Escalation tickets' });
    expect(within(table).getByText('Wi-Fi certificate install')).toBeTruthy();
    expect(within(table).getByText('Aston')).toBeTruthy();
    expect(within(table).getByText('#it-services')).toBeTruthy();
    expect(within(table).getByText('open')).toBeTruthy();
  });

  it('shows decision records as drafts, never as policy', async () => {
    renderPage(FULL, 'settings');
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
    window.history.pushState({}, '', '/assistant');
    renderWithSession(<AssistantPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    // Submit stays disabled until the mention role is chosen from the live directory.
    const submit = screen.getAllByRole('button', { name: 'Create behaviour' })[0]!;
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New member help' },
    });
    await pickOption(/help/, 'Tag');
    await pickOption('@Onboarding', 'Mention role');
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
      target: { value: 'Answer new member questions from reviewed sources only.' },
    });
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Skills the new behaviour may use' })).getByRole(
        'checkbox',
        { name: /Search club knowledge/ },
      ),
    );
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
      preferredSkillIds: ['search-club'],
      resourceIds: [],
      callerRoleIds: ['role-club-member'],
      enabled: false,
    });
  });

  it('states the fail-closed rule inside the create form in plain words', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    const form = (await screen.findByRole('heading', { name: 'Create a behaviour' })).closest(
      'section',
    )!;
    expect(within(form).getByText('If no role is ticked, nobody can use it.')).toBeTruthy();
    expect(
      within(form).getByText(/Each role can belong to only one behaviour that is turned on/),
    ).toBeTruthy();
    expect(within(form).getByText(/New behaviours start turned off/)).toBeTruthy();
  });

  it('describes the prompt card without system internals', async () => {
    renderDetail('club');
    expect(
      await screen.findByText(
        /These are the instructions this behaviour follows\. Bananasaurs adds its own safety rules/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Ambiguous tags are refused rather than mixed/)).toBeNull();
  });

  it('offers no owner-only skill in the create form and labels effects plainly', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    const picker = await screen.findByRole('region', {
      name: 'Skills the new behaviour may use',
    });
    expect(within(picker).queryByText('Deliver a reminder')).toBeNull();
    expect(within(picker).getByText('Draft an announcement')).toBeTruthy();
    expect(within(picker).getByText('Drafts, never sends')).toBeTruthy();
    expect(within(picker).getAllByText('Reads').length).toBe(2);
    expect(within(picker).getByText('Schedules')).toBeTruthy();
    expect(
      screen.getByText(
        'Which kind of helper this is. It decides the safety rules it follows, for example IT help can open tickets.',
      ),
    ).toBeTruthy();
  });

  it('shows ticket routing only for IT behaviours', async () => {
    const direct = {
      id: 'ask',
      guildId: '1540816150026518620',
      surface: 'direct-command',
      name: 'Club Q and A',
      systemPrompt: 'Answer member questions.',
      promptVersion: 1,
      preferredSkillIds: [],
      resourceIds: [],
      enabled: true,
      callerRoleIds: [],
      ticket: { reviewerRoleIds: [] },
    };
    const body = { ...FULL, behaviours: [direct, BEHAVIOURS[1]!] };
    renderDetail('ask', 'access', body);
    expect(await screen.findByRole('region', { name: 'Caller roles' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ticket routing' })).toBeNull();
    expect(screen.queryByText(/Ticket routing is not exposed/)).toBeNull();
    cleanup();
    renderDetail('it', 'access', body);
    expect(await screen.findByRole('region', { name: 'Ticket routing' })).toBeTruthy();
  });

  it('renders a mention-role refusal through the server answer', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const id = `welcome-${NOW.toString(36)}`;
    stubFetch([
      { url: '/api/assistant', body: FULL },
      {
        method: 'PUT',
        url: `/api/assistant/behaviours/${id}`,
        status: 400,
        body: {
          error: 'mention-role-required',
          title: 'A mention role is needed',
          message: 'A behaviour outside direct commands must mention a role.',
          hint: 'Pick which role mentions it.',
          fields: [{ path: 'mentionRoleId', problem: 'invalid_type' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    window.history.pushState({}, '', '/assistant');
    renderWithSession(<AssistantPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Welcome' },
    });
    await pickOption('@Onboarding', 'Mention role');
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
      target: { value: 'Welcome new members.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create behaviour' })[0]!);
    expect(await screen.findByText('A mention role is needed')).toBeTruthy();
    expect(screen.getByText('Missing or the wrong kind of value.')).toBeTruthy();
  });

  it('cannot create a behaviour when the role directory did not load', async () => {
    const body = { ...FULL } as Record<string, unknown>;
    delete body['roles'];
    renderPage(body);
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    expect(
      await screen.findByText(/no mention role can be chosen and the behaviour cannot be created/),
    ).toBeTruthy();
    const submit = screen.getAllByRole('button', { name: 'Create behaviour' })[0]!;
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('keeps other query fields and the hash when switching list tabs, and keeps a Settings draft', async () => {
    window.history.pushState({}, '', '/assistant?x=1#top');
    stubFetch([{ url: '/api/assistant', body: FULL }]);
    renderWithSession(<AssistantPage />);
    await screen.findByRole('table', { name: 'Assistant behaviours' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByRole('combobox', { name: 'When someone tags @Bananasaurs, answer with' });
    const params = new URLSearchParams(window.location.search);
    expect([params.get('x'), params.get('tab'), window.location.hash]).toEqual([
      '1',
      'settings',
      '#top',
    ]);
    await pickOption('Club assistant', 'When someone tags @Bananasaurs, answer with');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Behaviours' }));
    await screen.findByRole('table', { name: 'Assistant behaviours' });
    expect(window.location.search).toBe('?x=1');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByRole('tab', { name: 'Settings', selected: true });
    expect(
      screen.getByRole('combobox', { name: 'When someone tags @Bananasaurs, answer with' })
        .textContent,
    ).toContain('Club assistant');
  });

  it('empty state shows the tracker and the no-behaviours guidance', async () => {
    renderPage({
      ...FULL,
      behaviours: [],
      aiStatus: {
        provider: 'gemini',
        enabled: true,
        modelConfigured: true,
        keyConfigured: true,
        keyReadable: true,
        costClass: 'free',
        secretSource: 'env',
      },
      setup: {
        answering: false,
        steps: [
          { id: 'connect', state: 'done', detail: 'A provider is connected.' },
          { id: 'terms', state: 'done', detail: 'Terms are recorded.' },
          { id: 'cost', state: 'done', detail: 'Free.' },
          { id: 'who', state: 'todo', detail: 'No behaviour has caller roles yet.' },
          { id: 'skills', state: 'todo', detail: 'No everyday skills granted yet.' },
          { id: 'on', state: 'todo', detail: 'Nothing is turned on yet.' },
        ],
      },
    });
    expect(await screen.findByText('Set up the assistant')).toBeTruthy();
    expect(screen.getByText('No behaviours yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Step 4 creates the club assistant, which members reach by tagging @Bananasaurs. To set up a tagged helper like @it-services instead, create a behaviour.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create default behaviour' })).toBeNull();
  });

  it('with zero behaviours, the header Create a behaviour button shows the create form', async () => {
    renderPage({ ...FULL, behaviours: [] });
    expect(await screen.findByText('No behaviours yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New behaviour' }));
    expect(await screen.findByRole('heading', { name: 'Create a behaviour' })).toBeTruthy();
  });

  it('offers no control without a backing endpoint', async () => {
    renderDetail('club');
    await screen.findByRole('heading', { name: 'Club assistant' });
    for (const label of [/Edit behaviour/, /Run test scenario/, /New reminder/]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Save instructions' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([{ url: '/api/assistant', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AssistantPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn't load assistant settings/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('AssistantPage: Try it (Task 20)', () => {
  const TRY = { answer: 'Tried answer.', traceId: 'try_1', conversationId: 'try_c1' };
  const renderTry = (tryRoute: { status?: number; body: unknown } = { body: TRY }) => {
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
      { method: 'POST', url: '/api/assistant/behaviours/club/try', ...tryRoute },
    ]);
    window.history.pushState({}, '', '/assistant/behaviours/club?tab=try');
    renderWithSession(
      <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
    );
    return mock;
  };
  const tryCalls = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.filter((c) => c[0] === '/api/assistant/behaviours/club/try');

  it('tries the selected behaviour and links the answer to its history detail', async () => {
    const mock = renderTry();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'when is the meeting?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByText('Tried answer.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View details' });
    expect((link as HTMLAnchorElement).pathname).toBe('/assistant/history/try_1');
    expect(bodyOf(tryCalls(mock)[0]!)).toEqual({ question: 'when is the meeting?' });
  });

  it('continues the conversation when asked, keeping the conversation id', async () => {
    const mock = renderTry();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'first question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    await screen.findByText('Tried answer.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'and parking?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue this conversation' }));
    await screen.findByText('Tried answer.');
    expect(bodyOf(tryCalls(mock)[1]!)).toEqual({
      question: 'and parking?',
      conversationId: 'try_c1',
    });
  });

  it('reads the rate limit as an inline error, not only a toast', async () => {
    renderTry({
      status: 429,
      body: {
        error: 'rate-limited',
        message: 'You have used your 20 tries for this hour. Try again later.',
      },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'one too many' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    // The 429 must reach this call's inline alert — a toast alone is not enough.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You have used your 20 tries for this hour.');
    expect(screen.queryByRole('link', { name: 'View details' })).toBeNull();
  });

  it('renders an unclosed code fence as text, not a code block', async () => {
    renderTry({
      body: { ...TRY, answer: 'Here is code:\n```js\nconst x = 1;\nno closing fence' },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'show code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    const section = await screen.findByLabelText('Tried answer');
    expect(section.querySelector('pre')).toBeNull();
    expect(section.textContent).toContain('const x = 1;');
  });

  it('still renders a closed code fence as a code block', async () => {
    renderTry({
      body: { ...TRY, answer: 'Here is code:\n```js\nconst x = 1;\n```\ndone' },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'show code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    const section = await screen.findByLabelText('Tried answer');
    expect(section.querySelector('pre')?.textContent).toContain('const x = 1;');
  });
});

describe('AssistantPage: tagging @Bananasaurs (ADR 0063)', () => {
  const LABEL = 'When someone tags @Bananasaurs, answer with';
  const withFlag = (id: string | undefined) => ({
    ...FULL,
    behaviours: BEHAVIOURS.map((b) => ({ ...b, answersBotTag: b.id === id })),
  });
  const render = (
    body: unknown,
    put: { status?: number; body: unknown } = { body: { ok: true } },
  ) => {
    const mock = stubFetch([
      { url: '/api/assistant', body },
      { method: 'PUT', url: '/api/assistant/bot-tag', ...put },
    ]);
    window.history.pushState({}, '', '/assistant?tab=settings');
    renderWithSession(<AssistantPage />);
    return mock;
  };
  const putCalls = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.filter(
      (call) => call[0] === '/api/assistant/bot-tag' && (call[1] as RequestInit)?.method === 'PUT',
    );

  it('offers Nobody and only enabled behaviours, preselecting the flagged one', async () => {
    const enabledIt = {
      ...FULL,
      behaviours: [
        { ...BEHAVIOURS[0]!, answersBotTag: false },
        { ...BEHAVIOURS[1]!, enabled: true, answersBotTag: true },
      ],
    };
    render(enabledIt);
    const select = await screen.findByRole('combobox', { name: LABEL });
    expect(select.textContent).toContain('IT services');
    cleanup();
    render(withFlag(undefined));
    const again = await screen.findByRole('combobox', { name: LABEL });
    // IT services is disabled in FULL, so its control shows the none choice.
    expect(again.textContent).toContain('Nobody');
    expect(
      screen.getByText('Tagging the bot does nothing until you pick a behaviour.'),
    ).toBeTruthy();
  });

  it('saves the chosen behaviour, then Nobody, through PUT /api/assistant/bot-tag', async () => {
    const mock = render(withFlag(undefined));
    await screen.findByRole('combobox', { name: LABEL });
    // Nothing to save until a field changes: no save bar at all.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    await pickOption('Club assistant', 'When someone tags @Bananasaurs, answer with');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Tag @Bananasaurs now answers with Club assistant'),
    ).toBeTruthy();
    expect(bodyOf(putCalls(mock)[0]!)).toEqual({ behaviourId: 'club' });
    cleanup();
    const mock2 = render(withFlag('club'));
    await screen.findByRole('combobox', { name: LABEL });
    await pickOption('Nobody', LABEL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Tagging @Bananasaurs is off')).toBeTruthy();
    expect(bodyOf(putCalls(mock2)[0]!)).toEqual({ behaviourId: null });
  });

  it('explains a refused save inline', async () => {
    render(withFlag(undefined), {
      status: 409,
      body: {
        error: 'behaviour-disabled',
        title: 'That behaviour is off',
        message: 'The behaviour this needs is disabled.',
        hint: 'Turn the behaviour on first.',
        requestId: 'req-0a1b2c3d',
      },
    });
    await pickOption('Club assistant', LABEL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That behaviour is off')).toBeTruthy();
    cleanup();
    render(withFlag(undefined), {
      status: 400,
      body: {
        error: 'bad-request',
        title: 'The request was not valid',
        message: 'One or more fields were missing or had the wrong format.',
        hint: 'Fix the highlighted fields and try again.',
        requestId: 'req-0a1b2c3d',
      },
    });
    await pickOption('Club assistant', LABEL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The request was not valid')).toBeTruthy();
  });

  it('badges only the behaviour that answers the bot tag', async () => {
    window.history.pushState({}, '', '/assistant');
    stubFetch([{ url: '/api/assistant', body: withFlag('club') }]);
    renderWithSession(<AssistantPage />);
    const club = (await screen.findByRole('link', { name: 'Club assistant' })).closest('tr')!;
    expect(within(club).getByText('Tag @Bananasaurs')).toBeTruthy();
    const it = screen.getByRole('link', { name: 'IT services' }).closest('tr')!;
    expect(within(it).queryByText('Tag @Bananasaurs')).toBeNull();
  });
});

describe('AssistantPage: AI log channel (ADR 0065)', () => {
  const LABEL = 'Post every assistant request to';
  const render = (
    settings: unknown,
    put: { status?: number; body: unknown } = { body: { ok: true } },
  ) => {
    const mock = stubFetch([
      { url: '/api/assistant', body: { ...FULL, settings } },
      { method: 'PUT', url: '/api/assistant/log-channel', ...put },
    ]);
    window.history.pushState({}, '', '/assistant?tab=settings');
    renderWithSession(<AssistantPage />);
    return mock;
  };
  const putCall = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.find(
      (c) => c[0] === '/api/assistant/log-channel' && (c[1] as RequestInit)?.method === 'PUT',
    );

  it('offers Nobody and the live channels, preselecting the saved one', async () => {
    render({ logChannelId: 'chan-it' });
    const select = await screen.findByRole('combobox', { name: LABEL });
    expect(select.textContent).toContain('#it-services');
    expect(screen.getByText(/staff-only channel/)).toBeTruthy();
  });

  it('saves a channel and turns logging off with null', async () => {
    const mock = render({});
    await pickOption('#general', LABEL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Assistant requests now log to #general')).toBeTruthy();
    expect(bodyOf(putCall(mock)!)).toEqual({ channelId: 'chan-general' });
    cleanup();
    const mock2 = render({ logChannelId: 'chan-general' });
    await pickOption('No log channel', LABEL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Assistant logging is off')).toBeTruthy();
    expect(bodyOf(putCall(mock2)!)).toEqual({ channelId: null });
  });
});

describe('AssistantPage: Settings SaveBar and unsaved guard', () => {
  const TAG = 'When someone tags @Bananasaurs, answer with';
  const LOG = 'Post every assistant request to';
  const open = (
    routes: Parameters<typeof stubFetch>[0] = [],
    body: unknown = { ...FULL, settings: {} },
  ) => {
    window.history.pushState({}, '', '/assistant?tab=settings');
    const mock = stubFetch([{ url: '/api/assistant', body }, ...routes]);
    renderWithSession(<AssistantPage />);
    return mock;
  };
  const puts = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.filter((c) => c[1]?.method === 'PUT');
  const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

  it('counts changed fields, discards them, and sends nothing for a clean page', async () => {
    const mock = open();
    await pickOption('Club assistant', TAG);
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    await pickOption('#it-services', LOG);
    expect(within(bar()!).getByText('2 unsaved changes')).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(screen.getByRole('combobox', { name: TAG }).textContent).toContain('Nobody');
    expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('No log channel');
    expect(puts(mock)).toHaveLength(0);
  });

  it('saves only the changed field, as its own unchanged request', async () => {
    const mock = open([{ method: 'PUT', url: '/api/assistant/log-channel', body: { ok: true } }]);
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #it-services');
    expect(puts(mock).map((c) => [c[0], bodyOf(c)])).toEqual([
      ['/api/assistant/log-channel', { channelId: 'chan-it' }],
    ]);
  });

  it('sends two separate requests in order, and a failure keeps its draft while the other saves', async () => {
    const mock = open([
      {
        method: 'PUT',
        url: '/api/assistant/bot-tag',
        status: 409,
        body: {
          error: 'behaviour-disabled',
          title: 'That behaviour is off',
          message: 'The behaviour this needs is disabled.',
          requestId: 'req-1',
        },
      },
      { method: 'PUT', url: '/api/assistant/log-channel', body: { ok: true } },
    ]);
    await pickOption('Club assistant', TAG);
    await pickOption('#general', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant requests now log to #general');
    expect(puts(mock).map((c) => [c[0], bodyOf(c)])).toEqual([
      ['/api/assistant/bot-tag', { behaviourId: 'club' }],
      ['/api/assistant/log-channel', { channelId: 'chan-general' }],
    ]);
    expect(await screen.findByText('That behaviour is off')).toBeTruthy();
    // The refused choice is still the draft; the saved one is no longer dirty.
    expect(screen.getByRole('combobox', { name: TAG }).textContent).toContain('Club assistant');
  });

  it('shows busy while saving and blocks a second press', async () => {
    window.history.pushState({}, '', '/assistant?tab=settings');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (init?.method === 'PUT') {
          calls.push(url);
          await gate;
        }
        return new Response(JSON.stringify(init?.method === 'PUT' ? { ok: true } : FULL), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderWithSession(<AssistantPage />);
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    release();
    await screen.findByText('Assistant requests now log to #it-services');
    expect(calls).toHaveLength(1);
  });

  it('keeps the draft and the input when a save fails outside 400/409', async () => {
    const mock = open([
      { method: 'PUT', url: '/api/assistant/log-channel', status: 500, body: { error: 'boom' } },
    ]);
    await pickOption('#it-services', LOG);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Not saved\. Your choice is kept here/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#it-services');
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    expect(puts(mock)).toHaveLength(1);
  });

  it('keeps an unsaved Settings draft, and the bar, when flipping to the Behaviours tab and back', async () => {
    open();
    await pickOption('#it-services', LOG);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Behaviours' }));
    await screen.findByRole('table', { name: 'Assistant behaviours' });
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByRole('tab', { name: 'Settings', selected: true });
    expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#it-services');
  });

  it('guards a same-origin link while dirty: Stay keeps the page, Leave goes', async () => {
    open();
    await pickOption('#it-services', LOG);
    fireEvent.click(screen.getByRole('link', { name: 'Assistant history' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeTruthy();
    expect(window.location.pathname).toBe('/assistant');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(window.location.pathname).toBe('/assistant');
    expect(screen.getByRole('combobox', { name: LOG }).textContent).toContain('#it-services');
    fireEvent.click(screen.getByRole('link', { name: 'Assistant history' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/assistant/history'));
  });

  it('arms the real unload guard only while dirty', async () => {
    open();
    await screen.findByRole('combobox', { name: LOG });
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await pickOption('#it-services', LOG);
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('AssistantPage: real navigation to a behaviour page', () => {
  const both = () =>
    renderWithSession(
      <>
        <Route path="/assistant" component={AssistantPage} />
        <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />
      </>,
    );

  it('opens the behaviour page from its row and saves access with the unchanged body', async () => {
    window.history.pushState({}, '', '/assistant');
    const mock = stubFetch([{ url: '/api/assistant', body: FULL }, ...WRITES]);
    both();
    fireEvent.click(await screen.findByRole('link', { name: 'Club assistant' }));
    expect(await screen.findByRole('heading', { name: 'Club assistant' })).toBeTruthy();
    expect(window.location.pathname).toBe('/assistant/behaviours/club');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Access' }));
    const region = await screen.findByRole('region', { name: 'Caller roles' });
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByText('Club assistant access saved');
    const put = mock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe('/api/assistant/behaviours/club');
    expect((bodyOf(put) as { callerRoleIds: string[] }).callerRoleIds).toEqual([
      'role-club-member',
      'role-onboarding',
    ]);
  });

  it('after creating a behaviour, lands on its new page URL', async () => {
    const NOW = 1750000000000;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const id = `welcome-${NOW.toString(36)}`;
    window.history.pushState({}, '', '/assistant');
    stubFetch([
      { url: '/api/assistant', body: FULL },
      { method: 'PUT', url: `/api/assistant/behaviours/${id}`, body: { ok: true } },
    ]);
    both();
    fireEvent.click(await screen.findByRole('button', { name: 'New behaviour' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Welcome' },
    });
    await pickOption('@Onboarding', 'Mention role');
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
      target: { value: 'Welcome new members.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create behaviour' })[0]!);
    await waitFor(() => expect(window.location.pathname).toBe(`/assistant/behaviours/${id}`));
  });
});

describe('AssistantPage: shared resources (ADR 0067)', () => {
  it('labels preferred resources with the check-first helper', async () => {
    renderDetail('club', 'access');
    const section = await screen.findByRole('region', { name: 'Preferred resources' });
    expect(within(section).getByText('Preferred resources')).toBeTruthy();
    expect(within(section).getByText('Resources this assistant should check first.')).toBeTruthy();
  });

  it('edits preferred skills beside preferred resources and saves them whole-object', async () => {
    const mock = renderDetail('club', 'access');
    const section = await screen.findByRole('region', { name: 'Preferred skills' });
    expect(within(section).getByText('Preferred skills')).toBeTruthy();
    expect(
      within(section).getByText(
        "Skills this assistant should lean on first. This doesn't grant or block anything: who can use a skill is set on the Skills page.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(section).getByRole('checkbox', { name: /Link a club resource/ }));
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
      preferredSkillIds: ['search-club', 'create-reminder', 'open-resource'],
      resourceIds: ['handbook'],
      enabled: true,
      callerRoleIds: ['role-club-member'],
    });
  });
});

describe('AssistantPage: prompt wizard and full-prompt preview (Task 18)', () => {
  const PREVIEW = {
    sections: [
      { name: 'surface', chars: 12, estTokens: 3, text: 'surface text' },
      { name: 'behaviour-prompt', chars: 20, estTokens: 5, text: 'prompt text' },
      { name: 'safety-suffix', chars: 30, estTokens: 8, text: 'suffix text' },
      { name: 'evidence-rule', chars: 13, estTokens: 4, text: 'evidence text' },
      { name: 'server-card', chars: 11, estTokens: 3, text: 'server text' },
      { name: 'resources', chars: 15, estTokens: 4, text: 'resources text' },
      { name: 'skills', chars: 11, estTokens: 3, text: 'skills text' },
    ],
    totalChars: 122,
    totalEstTokens: 31,
  };

  it('is titled Behaviours and each behaviour page links to its wizard', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Assistant' })).toBeNull();
    cleanup();
    renderDetail('club');
    const link = await screen.findByRole('link', { name: 'Build with the wizard' });
    expect(link.getAttribute('href')).toBe('/assistant/behaviours/club/wizard');
    cleanup();
    renderDetail('it');
    expect(
      (await screen.findByRole('link', { name: 'Build with the wizard' })).getAttribute('href'),
    ).toBe('/assistant/behaviours/it/wizard');
  });

  it('previews the full prompt with plain-words labels, sizes and expandable text', async () => {
    stubFetch([
      { url: '/api/assistant', body: FULL },
      { url: '/api/assistant/behaviours/club/preview', body: PREVIEW },
    ]);
    window.history.pushState({}, '', '/assistant/behaviours/club?tab=prompt');
    renderWithSession(
      <Route path="/assistant/behaviours/:id" component={AssistantBehaviourDetailPage} />,
    );
    await screen.findByRole('heading', { name: 'Club assistant' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the full prompt' }));
    expect(await screen.findByText('How members reach it')).toBeTruthy();
    expect(screen.getByText('Your prompt')).toBeTruthy();
    expect(screen.getByText('Bananasaurs safety rules (locked)')).toBeTruthy();
    expect(screen.getByText('Evidence rule')).toBeTruthy();
    expect(screen.getByText('Server card')).toBeTruthy();
    expect(screen.getByText('Club resources')).toBeTruthy();
    expect(screen.getByText('Allowed skills')).toBeTruthy();
    expect(screen.getByText(/20 characters · ~5 tokens/)).toBeTruthy();
    expect(screen.getByText(/Total: 122 characters · ~31 tokens/)).toBeTruthy();
    expect(screen.getByText('prompt text')).toBeTruthy();
    expect(screen.getByText('Your prompt').closest('details')).toBeTruthy();
  });
});

it('behaviour toggle labels inherit bounded Button wrapping in both states', async () => {
  renderDetail('club');
  const off = await screen.findByRole('button', { name: 'Turn off - members will get no answer' });
  expect(off.classList.contains('whitespace-nowrap')).toBe(false);
  expect(off.classList.contains('whitespace-normal')).toBe(true);
  cleanup();
  renderDetail('it');
  const on = await screen.findByRole('button', { name: 'Turn on assistant' });
  expect(on.classList.contains('whitespace-nowrap')).toBe(false);
  expect(on.classList.contains('whitespace-normal')).toBe(true);
});
