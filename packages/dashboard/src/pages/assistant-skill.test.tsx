// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantSkillPage } from './assistant-skill.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const inputOf = (element: HTMLElement): HTMLInputElement => {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an <input>');
  return element;
};

const BEHAVIOURS = [
  {
    id: 'club',
    guildId: '1540816150026518620',
    surface: 'bananasaurs',
    mentionRoleId: 'role-club-assistant',
    name: 'Club assistant',
    systemPrompt: 'Answer with reviewed club knowledge only.',
    promptVersion: 1,
    preferredSkillIds: ['search-club'],
    resourceIds: ['handbook'],
    enabled: true,
    callerRoleIds: ['role-club-member'],
  },
  {
    id: 'help',
    guildId: '1540816150026518620',
    surface: 'help',
    mentionRoleId: 'role-it',
    name: 'IT help',
    systemPrompt: 'Answer IT questions.',
    promptVersion: 0,
    preferredSkillIds: [],
    resourceIds: [],
    enabled: true,
    callerRoleIds: [],
  },
];

const ASSISTANT_DATA = {
  behaviours: BEHAVIOURS,
  resources: [],
  reminders: [],
  skills: [
    {
      id: 'search-club',
      name: 'Search club knowledge',
      description: 'Search enabled Discord archive and reviewed resources.',
      effect: 'read',
      requiredPermission: 'assistant.search',
      requiresConfirmation: false,
    },
  ],
  activity: [],
  roles: [
    { id: 'role-club-member', name: 'Club Member', position: 10 },
    { id: 'role-onboarding', name: 'Onboarding', position: 5 },
  ],
};

const SKILL_DETAIL = {
  skill: {
    id: 'search-club',
    name: 'Search club knowledge',
    description: 'Search enabled Discord archive and reviewed resources.',
    effect: 'read',
    requiredPermission: 'assistant.search',
    requiresConfirmation: false,
    acts: false,
  },
  instructionLine:
    'search-club: Search enabled Discord archive and reviewed resources. Effect=read. Confirmation=not required.',
  behaviours: [
    { id: 'club', name: 'Club assistant', preferred: true },
    { id: 'help', name: 'IT help', preferred: false },
  ],
  scope: { mode: 'everyone', roleIds: [], isDefault: true },
  whoCanUse: '@Club Member, and the server owner',
  items: { kind: 'none' },
  tools: [
    {
      name: 'search_archive',
      description: "Search past messages in this Discord server's archived channels.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for.',
            minLength: 1,
            maxLength: 200,
          },
        },
        required: ['query'],
      },
      rounds: 'first',
      outputLimit: 'Up to 6,000 characters of results.',
    },
    {
      name: 'current_time',
      description: "Today's date and the current time in the club's time zone.",
      parameters: { type: 'object', properties: {} },
      rounds: 'first',
      outputLimit: 'Up to 6,000 characters of results.',
    },
  ],
  recentRuns: [
    {
      id: 'a1',
      at: 1790000000000,
      behaviourId: 'club',
      skillId: 'search-club',
      outcome: 'completed',
    },
  ],
};

function renderPage(detail: unknown = SKILL_DETAIL, assistant: unknown = ASSISTANT_DATA) {
  const mock = stubFetch([
    { url: '/api/assistant/skills/search-club', body: detail },
    { url: '/api/assistant', body: assistant },
    {
      method: 'PUT',
      url: '/api/assistant/skills/search-club/scope',
      body: { ok: true, scope: { mode: 'owner', roleIds: [], isDefault: false } },
    },
  ]);
  const { hook } = memoryLocation({ path: '/assistant/skills/search-club' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/skills/:skillId" component={AssistantSkillPage} />
    </Router>,
  );
  return mock;
}

describe('AssistantSkillPage', () => {
  it('renders every section: overview, who can use this, the instruction, tools and recent runs, with no per-behaviour toggles', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Search club knowledge' });

    const overview = screen.getByRole('heading', { name: 'Overview' }).closest('section')!;
    expect(within(overview).getByText('Search club knowledge')).toBeTruthy();
    expect(within(overview).getByText('Reads')).toBeTruthy();

    expect(screen.queryByRole('heading', { name: "Where it's on" })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Club assistant' })).toBeNull();

    const who = screen.getByRole('heading', { name: 'Who can use this' }).closest('section')!;
    expect(within(who).getByText('@Club Member, and the server owner')).toBeTruthy();
    expect(
      within(who).getByText(
        'Any assistant can use this skill for people allowed above. Assistants can prefer it on the Behaviours tab.',
      ),
    ).toBeTruthy();

    const told = screen.getByRole('heading', { name: 'What the AI is told' }).closest('section')!;
    expect(within(told).getByText(SKILL_DETAIL.instructionLine).tagName).toBe('CODE');

    const tools = screen.getByRole('heading', { name: 'Tools' }).closest('section')!;
    expect(within(tools).getByText('search_archive')).toBeTruthy();
    expect(within(tools).getByText('query')).toBeTruthy();
    expect(within(tools).getByText('1–200 characters')).toBeTruthy();
    expect(within(tools).getByText('Yes', { selector: 'td' })).toBeTruthy();
    expect(within(tools).getAllByText('First round only').length).toBeGreaterThan(0);
    expect(within(tools).getByText('No parameters.')).toBeTruthy();

    const runs = screen.getByRole('heading', { name: 'Recent runs' }).closest('section')!;
    expect(within(runs).getByText(/completed/)).toBeTruthy();
    expect(within(runs).getByRole('link', { name: 'Assistant history' }).getAttribute('href')).toBe(
      '/assistant/history',
    );

    expect(screen.queryByText('Slash command')).toBeNull();
    expect(screen.queryByText(/you confirm first/i)).toBeNull();
    expect(screen.queryByText('You confirm first')).toBeNull();
    expect(screen.queryByText('Runs without asking')).toBeNull();
  });

  it('labels a returned-id tool as round 1, or later with a returned id', async () => {
    renderPage({
      ...SKILL_DETAIL,
      tools: [
        {
          name: 'read_chunk',
          description: 'Read one chunk of a reviewed resource.',
          parameters: { type: 'object', properties: {} },
          rounds: 'returned-id',
          outputLimit: 'Up to 6,000 characters of results.',
        },
      ],
    });
    expect(await screen.findByText('Round 1, or later with a returned id')).toBeTruthy();
  });

  it('renders the current scope mode selected, with the default note', async () => {
    renderPage();
    const who = (await screen.findByRole('heading', { name: 'Who can use this' })).closest(
      'section',
    )!;
    const everyone = within(who).getByRole('radio', { name: /Everyone who can ask/ });
    expect(inputOf(everyone).checked).toBe(true);
    expect(within(who).getByText(/Default for this skill\./)).toBeTruthy();
    expect(within(who).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('keeps Save disabled for Specific roles until at least one role is picked', async () => {
    renderPage();
    const who = (await screen.findByRole('heading', { name: 'Who can use this' })).closest(
      'section',
    )!;
    fireEvent.click(within(who).getByRole('radio', { name: /Specific roles/ }));
    const save = within(who).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(within(who).getByRole('checkbox', { name: 'Club Member' }));
    expect(within(who).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('saves the scope with the right body and toasts Saved', async () => {
    const mock = renderPage();
    const who = (await screen.findByRole('heading', { name: 'Who can use this' })).closest(
      'section',
    )!;
    fireEvent.click(within(who).getByRole('radio', { name: /Owner only/ }));
    fireEvent.click(within(who).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    const put = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/skills/search-club/scope' &&
        (c[1] as RequestInit)?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({ mode: 'owner', roleIds: [] });
  });

  it('saves specific roles with both picked role ids', async () => {
    const mock = renderPage();
    const who = (await screen.findByRole('heading', { name: 'Who can use this' })).closest(
      'section',
    )!;
    fireEvent.click(within(who).getByRole('radio', { name: /Specific roles/ }));
    fireEvent.click(within(who).getByRole('checkbox', { name: 'Club Member' }));
    fireEvent.click(within(who).getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(within(who).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    const put = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/skills/search-club/scope' &&
        (c[1] as RequestInit)?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      mode: 'roles',
      roleIds: ['role-club-member', 'role-onboarding'],
    });
  });

  it('notes that an acting skill runs with no confirmation step, and stays silent otherwise', async () => {
    renderPage({
      ...SKILL_DETAIL,
      skill: { ...SKILL_DETAIL.skill, acts: true },
    });
    expect(
      await screen.findByText(
        'This skill acts (it sets reminders or files proposals). It runs as soon as someone allowed asks, with no confirmation step.',
      ),
    ).toBeTruthy();
  });

  it('shows no acts note for a skill that does not act', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Search club knowledge' });
    expect(screen.queryByText(/This skill acts/)).toBeNull();
  });

  it('renders the skill live items under the scope card', async () => {
    renderPage({
      ...SKILL_DETAIL,
      items: {
        kind: 'reminders',
        reminders: [
          {
            id: 'rem-1',
            creatorId: 'user-bryan',
            creatorName: 'Bryan',
            destinationId: 'chan-general',
            destinationName: 'general',
            text: 'Standup time',
            dueAt: 1890000000000,
            status: 'scheduled',
            mentions: { userIds: [], roleIds: [], everyone: false, here: false },
            deliveredCount: 0,
          },
        ],
      },
    });
    const scope = await screen.findByRole('heading', { name: 'Who can use this' });
    const items = await screen.findByRole('heading', { name: 'Reminders' });
    expect(screen.getByText('Standup time')).toBeTruthy();
    expect((scope.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    );
  });

  it("shows a 404 empty state with a link back for a skill that doesn't exist", async () => {
    stubFetch([
      { url: '/api/assistant/skills/no-such-skill', status: 404, body: { error: 'not-found' } },
      { url: '/api/assistant', body: ASSISTANT_DATA },
    ]);
    const { hook } = memoryLocation({ path: '/assistant/skills/no-such-skill' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/skills/:skillId" component={AssistantSkillPage} />
      </Router>,
    );
    expect(await screen.findByText("Skill doesn't exist or was deleted")).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Skill' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Skills' }).getAttribute('href')).toBe(
      '/assistant/skills',
    );
  });
});
