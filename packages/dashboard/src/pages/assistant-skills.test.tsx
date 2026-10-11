// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantSkillsPage } from './assistant-skills.js';
import { scopeLabel } from './assistant-shared.js';

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
  resources: [],
  reminders: [],
  skills: SKILLS,
  skillScopes: {
    'search-club': { mode: 'everyone', roleIds: [], isDefault: true },
    'create-reminder': { mode: 'roles', roleIds: ['role-club-member'], isDefault: false },
    'send-reminder': { mode: 'owner', roleIds: [], isDefault: true },
  },
  skillItemCounts: { 'create-reminder': 3 },
  activity: [
    {
      id: 'a1',
      at: 1790000000000,
      behaviourId: 'club',
      skillId: 'create-reminder',
      outcome: 'completed',
    },
    {
      id: 'a2',
      at: 1790000100000,
      behaviourId: 'club',
      skillId: 'search-club',
      outcome: 'denied',
      detail: 'x',
    },
  ],
  aiStatus: {
    provider: 'gemini',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'free',
    secretSource: 'file',
  },
  roles: [
    { id: 'role-club-member', name: 'Club Member', position: 10 },
    { id: 'role-onboarding', name: 'Onboarding', position: 5 },
  ],
  members: [
    { id: 'user-bryan', name: 'Bryan' },
    { id: 'user-aston', name: 'Aston' },
  ],
  channels: [],
  skillGrants: [{ skillId: 'create-reminder', roleIds: [], userIds: ['user-bryan'] }],
  tickets: [],
  decisions: [],
};

function renderPage(body: unknown = FULL) {
  const mock = stubFetch([{ url: '/api/assistant', body }]);
  renderWithSession(<AssistantSkillsPage />);
  return mock;
}

describe('AssistantSkillsPage', () => {
  it('states its purpose sentence (Task 9)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(screen.getByText('What the assistant can do and who can use it.')).toBeTruthy();
  });

  it('renders the catalogue with scope and live-count badges and no confirm-first text', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    const catalogue = screen.getByRole('heading', { name: 'Skill catalogue' }).closest('section')!;
    expect(within(catalogue).getAllByText('Search club knowledge').length).toBeGreaterThan(0);
    expect(within(catalogue).queryByText(/Needs the Discord permission/)).toBeNull();
    expect(within(catalogue).queryByText('assistant.search')).toBeNull();
    expect(within(catalogue).getByText('Everyone who can ask')).toBeTruthy();
    expect(within(catalogue).getByText('Roles: @Club Member')).toBeTruthy();
    expect(within(catalogue).getByText('Owner only')).toBeTruthy();
    expect(within(catalogue).getByText('3 active')).toBeTruthy();
    expect(screen.queryByText(/confirm first/i)).toBeNull();
    expect(screen.queryByText('Runs without asking')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Assistant history' }).length).toBeGreaterThan(0);
  });

  it('lists the web-search skill with its scope control', async () => {
    renderPage({
      ...FULL,
      skills: [
        ...FULL.skills,
        {
          id: 'web-search',
          name: 'Search the web',
          description:
            'Search the public web for general and current questions when club sources have nothing.',
          effect: 'read',
          requiredPermission: 'assistant.search',
          requiresConfirmation: false,
        },
      ],
      skillScopes: {
        ...FULL.skillScopes,
        'web-search': { mode: 'everyone', roleIds: [], isDefault: true },
      },
    });
    const catalogue = (await screen.findByRole('heading', { name: 'Skill catalogue' })).closest(
      'section',
    )!;
    const link = within(catalogue).getByRole('link', { name: 'Search the web' });
    expect(link.getAttribute('href')).toBe('/assistant/skills/web-search');
    expect(within(link).getByText('Search the web')).toBeTruthy();
    expect(within(link).getByText('Everyone who can ask')).toBeTruthy();
  });

  it('does not edit per-behaviour skills: preferences live on the Behaviours tab', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Allowlists per behaviour' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save allowlist' })).toBeNull();
    expect(screen.queryByText(/Nothing is allowed/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Allowlist for Club assistant' })).toBeNull();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantSkillsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant skills/)).toBeTruthy();
  });

  it('states that each skill scope decides who can use it (ADR 0086)', async () => {
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Who can use skills' })).closest(
      'section',
    )!;
    expect(
      within(card).getByText(
        "Each skill's scope decides who can use it; the owner can always use every skill.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Skill grants' })).toBeNull();
  });

  it('links each skill card to its own detail page instead of expanding inline', async () => {
    renderPage();
    const catalogue = (await screen.findByRole('heading', { name: 'Skill catalogue' })).closest(
      'section',
    )!;
    const link = within(catalogue).getByRole('link', { name: 'Set a reminder' });
    expect(link.getAttribute('href')).toBe('/assistant/skills/create-reminder');
    expect(screen.queryByRole('region', { name: 'Set a reminder details' })).toBeNull();
  });

  it('lists the look-up tools, with web search off until it is set up', async () => {
    renderPage();
    const tools = (await screen.findByRole('heading', { name: 'Look-up tools' })).closest(
      'section',
    )!;
    for (const name of [
      'Search the Discord archive',
      'Open a club resource',
      'Search the web',
      'Server and channels',
      'Date and time',
      'My reminders',
    ])
      expect(within(tools).getByText(name)).toBeTruthy();
    const web = within(tools).getByText('Search the web').closest('li')!;
    expect(within(web).getByText('Off')).toBeTruthy();
    expect(within(web).getByRole('link', { name: 'Set up web search' })).toBeTruthy();
  });

  it('labels each scope mode in plain words', () => {
    expect(scopeLabel({ mode: 'everyone', roleIds: [] }, () => undefined)).toBe(
      'Everyone who can ask',
    );
    expect(scopeLabel({ mode: 'owner', roleIds: [] }, () => undefined)).toBe('Owner only');
    expect(
      scopeLabel({ mode: 'roles', roleIds: ['r1', 'r2'] }, (id) =>
        id === 'r1' ? 'Mods' : id === 'r2' ? 'Helpers' : undefined,
      ),
    ).toBe('Roles: @Mods, @Helpers');
  });

  it('shows web search on when AI setup turned it on', async () => {
    renderPage({
      ...FULL,
      aiStatus: { ...FULL.aiStatus, webSearch: { keyConfigured: true, enabled: true } },
    });
    const tools = (await screen.findByRole('heading', { name: 'Look-up tools' })).closest(
      'section',
    )!;
    const web = within(tools).getByText('Search the web').closest('li')!;
    expect(within(web).getByText('On')).toBeTruthy();
  });

  it('names the Brave API until Tavily is chosen', async () => {
    renderPage({
      ...FULL,
      aiStatus: {
        ...FULL.aiStatus,
        webSearch: { keyConfigured: true, enabled: true, source: 'brave' },
      },
    });
    const tools = (await screen.findByRole('heading', { name: 'Look-up tools' })).closest(
      'section',
    )!;
    const web = within(tools).getByText('Search the web').closest('li')!;
    expect(
      within(web).getByText(
        'Sends a short query to the Brave Search API. Queries that look like they carry personal data are refused.',
      ),
    ).toBeTruthy();
  });

  it('names the Tavily API when the owner chose Tavily', async () => {
    renderPage({
      ...FULL,
      aiStatus: {
        ...FULL.aiStatus,
        webSearch: { keyConfigured: true, enabled: true, source: 'tavily' },
      },
    });
    const tools = (await screen.findByRole('heading', { name: 'Look-up tools' })).closest(
      'section',
    )!;
    const web = within(tools).getByText('Search the web').closest('li')!;
    expect(
      within(web).getByText(
        'Sends a short query to the Tavily search API. Queries that look like they carry personal data are refused.',
      ),
    ).toBeTruthy();
  });
});

it('lists ping and task scopes and the member look-up tool', async () => {
  renderPage({
    ...FULL,
    skills: [
      ...FULL.skills,
      {
        id: 'ping',
        name: 'Ping members and roles',
        description: 'Ping only permitted names.',
        effect: 'send',
        requiredPermission: 'assistant.ask',
        requiresConfirmation: false,
      },
      {
        id: 'tasks',
        name: 'Club tasks',
        description: 'Manage club tasks.',
        effect: 'write',
        requiredPermission: 'assistant.ask',
        requiresConfirmation: false,
      },
    ],
    skillScopes: {
      ...FULL.skillScopes,
      ping: { mode: 'everyone', roleIds: [], isDefault: true },
      tasks: { mode: 'owner', roleIds: [], isDefault: true },
    },
  });
  const catalogue = (await screen.findByRole('heading', { name: 'Skill catalogue' })).closest(
    'section',
  )!;
  for (const [name, id, scope] of [
    ['Ping members and roles', 'ping', 'Everyone who can ask'],
    ['Club tasks', 'tasks', 'Owner only'],
  ]) {
    const link = within(catalogue).getByRole('link', { name: name! });
    expect(link.getAttribute('href')).toBe(`/assistant/skills/${id}`);
    expect(within(link).getByText(scope!)).toBeTruthy();
  }
  expect(screen.getByText('Find a member')).toBeTruthy();
});

it('describes Parallel queries and its training disclosure in look-up tools', async () => {
  renderPage({
    ...FULL,
    aiStatus: { ...FULL.aiStatus, webSearch: { enabled: true, source: 'parallel' } },
  });
  await screen.findByRole('heading', { name: 'Look-up tools' });
  expect(
    screen.getByText(
      'Sends a short query to the Parallel search API. Parallel may use queries to train its models.',
    ),
  ).toBeTruthy();
});
