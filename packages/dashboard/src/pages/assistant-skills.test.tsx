// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
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
    allowedSkillIds: ['search-club', 'create-reminder'],
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
  const mock = stubFetch([
    { url: '/api/assistant', body },
    { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/skill-grants/create-reminder', body: { ok: true } },
  ]);
  renderWithSession(<AssistantSkillsPage />);
  return mock;
}

describe('AssistantSkillsPage', () => {
  it('states its purpose sentence (Task 9)', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(
      screen.getByText('What the assistant can do, where each skill is on, and who can use it.'),
    ).toBeTruthy();
  });

  it('renders the catalogue without Discord permission claims', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    const catalogue = screen.getByRole('heading', { name: 'Skill catalogue' }).closest('section')!;
    expect(within(catalogue).getAllByText('Search club knowledge').length).toBeGreaterThan(0);
    expect(within(catalogue).queryByText(/Needs the Discord permission/)).toBeNull();
    expect(within(catalogue).queryByText('assistant.search')).toBeNull();
    expect(within(catalogue).getByText('You confirm first')).toBeTruthy();
    expect(within(catalogue).getAllByText('Runs without asking').length).toBeGreaterThan(0);
    expect(within(catalogue).getByText('owner only')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Assistant history' }).length).toBeGreaterThan(0);
  });

  it('labels allowlist effects in the same plain words as the create form', async () => {
    renderPage();
    const region = await screen.findByRole('region', { name: 'Allowlist for Club assistant' });
    expect(within(region).getByText('Reads')).toBeTruthy();
    expect(within(region).getByText('Schedules · you confirm first')).toBeTruthy();
  });

  it('saves a per-behaviour allowlist as the whole behaviour object', async () => {
    const mock = renderPage();
    const region = await screen.findByRole('region', { name: 'Allowlist for Club assistant' });
    fireEvent.click(within(region).getByRole('checkbox', { name: /Set a reminder/ }));
    fireEvent.click(within(region).getByRole('button', { name: 'Save allowlist' }));
    await screen.findByText('Club assistant allowlist saved');
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
      allowedSkillIds: ['search-club'],
      resourceIds: ['handbook'],
      enabled: true,
      callerRoleIds: ['role-club-member'],
    });
  });

  it('warns when an allowlist is emptied to nothing', async () => {
    renderPage();
    const region = await screen.findByRole('region', { name: 'Allowlist for Club assistant' });
    expect(within(region).queryByText(/Nothing is allowed/)).toBeNull();
    fireEvent.click(within(region).getByRole('checkbox', { name: /Search club knowledge/ }));
    fireEvent.click(within(region).getByRole('checkbox', { name: /Set a reminder/ }));
    expect(within(region).getByText(/Nothing is allowed/)).toBeTruthy();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantSkillsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant skills/)).toBeTruthy();
  });

  it('states the one rule for who can use skills (ADR 0064)', async () => {
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Who can use skills' })).closest(
      'section',
    )!;
    expect(
      within(card).getByText(
        'Anyone a behaviour lets ask (its Who can ask roles on the Assistant page) can use every skill that behaviour allows. Owner-only skills stay with the server owner.',
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
});
