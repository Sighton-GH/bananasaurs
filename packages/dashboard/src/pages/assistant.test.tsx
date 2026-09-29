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
  it('states its purpose sentence (Task 9)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    expect(
      screen.getByText('Behaviours decide who answers, how they sound, and who may ask.'),
    ).toBeTruthy();
  });

  it('renders behaviours with their tag mapping, prompt editor and records', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    const club = screen.getByRole('button', { name: /Club assistant/ });
    expect(club.getAttribute('aria-pressed')).toBe('true');
    expect(within(club).getByText('Members mention @Club Assistant')).toBeTruthy();
    expect(screen.getByDisplayValue('Answer with reviewed club knowledge only.')).toBeTruthy();
    expect(screen.getByText('Buy two spare batteries')).toBeTruthy();
  });

  it('labels a direct command without repeating the words and badges On and Off', async () => {
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
    const card = await screen.findByRole('button', { name: /Club Q and A/ });
    expect(within(card).getByText('Direct command')).toBeTruthy();
    expect(within(card).getByText('Members tag @Bananasaurs')).toBeTruthy();
    expect(within(card).getByText('On')).toBeTruthy();
    const itCard = screen.getByRole('button', { name: /IT services/ });
    expect(within(itCard).getByText('Off')).toBeTruthy();
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
      preferredSkillIds: ['search-club', 'create-reminder'],
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
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
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
    renderPage();
    expect(
      await screen.findByText(
        /These are the instructions this behaviour follows\. Bananasaurs adds its own safety rules/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Ambiguous tags are refused rather than mixed/)).toBeNull();
  });

  it('offers no owner-only skill in the create form and labels effects plainly', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a behaviour' }));
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
    renderPage({ ...FULL, behaviours: [direct, BEHAVIOURS[1]!] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ticket routing' })).toBeNull();
    expect(screen.queryByText(/Ticket routing is not exposed/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /IT services/ }));
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
    expect(await screen.findByText('A mention role is needed')).toBeTruthy();
    expect(screen.getByText('Missing or the wrong kind of value.')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Create a behaviour' }));
    expect(await screen.findByRole('heading', { name: 'Create a behaviour' })).toBeTruthy();
  });

  it('offers no control without a backing endpoint', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Behaviours' });
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

describe('AssistantPage: Try it (Task 20)', () => {
  const TRY = { answer: 'Tried answer.', traceId: 'try_1', conversationId: 'try_c1' };
  const renderTry = (tryRoute: { status?: number; body: unknown } = { body: TRY }) => {
    const mock = stubFetch([
      { url: '/api/assistant', body: FULL },
      { method: 'POST', url: '/api/assistant/behaviours/club/try', ...tryRoute },
    ]);
    renderWithSession(<AssistantPage />);
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
    const select = await screen.findByLabelText(LABEL);
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Nobody', 'Club assistant', 'IT services']);
    expect(select).toHaveProperty('value', 'it');
    cleanup();
    render(withFlag(undefined));
    const again = await screen.findByLabelText(LABEL);
    // IT services is disabled in FULL, so it is not offered.
    expect(
      within(again)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Nobody', 'Club assistant']);
    expect(again).toHaveProperty('value', '');
    expect(
      screen.getByText('Tagging the bot does nothing until you pick a behaviour.'),
    ).toBeTruthy();
  });

  it('saves the chosen behaviour, then Nobody, through PUT /api/assistant/bot-tag', async () => {
    const mock = render(withFlag(undefined));
    const select = await screen.findByLabelText(LABEL);
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'club' } });
    fireEvent.click(save);
    expect(
      await screen.findByText('Tag @Bananasaurs now answers with Club assistant'),
    ).toBeTruthy();
    expect(bodyOf(putCalls(mock)[0]!)).toEqual({ behaviourId: 'club' });
    cleanup();
    const mock2 = render(withFlag('club'));
    const select2 = await screen.findByLabelText(LABEL);
    fireEvent.change(select2, { target: { value: '' } });
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
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: 'club' } });
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
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: 'club' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The request was not valid')).toBeTruthy();
  });

  it('badges only the behaviour that answers the bot tag', async () => {
    render(withFlag('club'));
    const club = await screen.findByRole('button', { name: /Club assistant/ });
    expect(within(club).getByText('Tag @Bananasaurs')).toBeTruthy();
    const it = screen.getByRole('button', { name: /IT services/ });
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
    renderWithSession(<AssistantPage />);
    return mock;
  };
  const putCall = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.find(
      (c) => c[0] === '/api/assistant/log-channel' && (c[1] as RequestInit)?.method === 'PUT',
    );

  it('offers Nobody and the live channels, preselecting the saved one', async () => {
    render({ logChannelId: 'chan-it' });
    const select = await screen.findByLabelText(LABEL);
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['No log channel', '#it-services', '#general']);
    expect(select).toHaveProperty('value', 'chan-it');
    expect(screen.getByText(/staff-only channel/)).toBeTruthy();
  });

  it('saves a channel and turns logging off with null', async () => {
    const mock = render({});
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: 'chan-general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save log channel' }));
    expect(await screen.findByText('Assistant requests now log to #general')).toBeTruthy();
    expect(bodyOf(putCall(mock)!)).toEqual({ channelId: 'chan-general' });
    cleanup();
    const mock2 = render({ logChannelId: 'chan-general' });
    fireEvent.change(await screen.findByLabelText(LABEL), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save log channel' }));
    expect(await screen.findByText('Assistant logging is off')).toBeTruthy();
    expect(bodyOf(putCall(mock2)!)).toEqual({ channelId: null });
  });
});

describe('AssistantPage: shared resources (ADR 0067)', () => {
  it('labels preferred resources with the check-first helper', async () => {
    renderPage();
    const section = await screen.findByRole('region', { name: 'Preferred resources' });
    expect(within(section).getByText('Preferred resources')).toBeTruthy();
    expect(within(section).getByText('Resources this assistant should check first.')).toBeTruthy();
  });

  it('edits preferred skills beside preferred resources and saves them whole-object', async () => {
    const mock = renderPage();
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

  it('is titled Behaviours and links each behaviour card to its wizard', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Behaviours' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Assistant' })).toBeNull();
    const links = screen.getAllByRole('link', { name: 'Build with the wizard' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      expect.arrayContaining([
        '/assistant/behaviours/club/wizard',
        '/assistant/behaviours/it/wizard',
      ]),
    );
    expect(links).toHaveLength(2);
  });

  it('previews the full prompt with plain-words labels, sizes and expandable text', async () => {
    stubFetch([
      { url: '/api/assistant', body: FULL },
      { url: '/api/assistant/behaviours/club/preview', body: PREVIEW },
    ]);
    renderWithSession(<AssistantPage />);
    await screen.findByRole('heading', { level: 1, name: 'Behaviours' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview the full prompt' })[0]!);
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
