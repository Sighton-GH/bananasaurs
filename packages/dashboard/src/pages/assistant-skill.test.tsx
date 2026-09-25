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
    allowedSkillIds: ['search-club'],
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
    allowedSkillIds: [],
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
};

const SKILL_DETAIL = {
  skill: {
    id: 'search-club',
    name: 'Search club knowledge',
    description: 'Search enabled Discord archive and reviewed resources.',
    effect: 'read',
    requiredPermission: 'assistant.search',
    requiresConfirmation: false,
  },
  instructionLine:
    'search-club: Search enabled Discord archive and reviewed resources. Effect=read. Confirmation=not required.',
  behaviours: [
    { id: 'club', name: 'Club assistant', allowed: true },
    { id: 'help', name: 'IT help', allowed: false },
  ],
  whoCanUse: '@Club Member, and the server owner',
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
  command: {
    name: 'find',
    options: [{ name: 'query', required: true, description: 'What to find' }],
  },
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

function renderPage() {
  const mock = stubFetch([
    { url: '/api/assistant/skills/search-club', body: SKILL_DETAIL },
    { url: '/api/assistant', body: ASSISTANT_DATA },
    { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    { method: 'PUT', url: '/api/assistant/behaviours/help', body: { ok: true } },
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
  it('renders every section: overview, where it is on, who can use it, the instruction, tools, command and recent runs', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Skill' });

    const overview = screen.getByRole('heading', { name: 'Overview' }).closest('section')!;
    expect(within(overview).getByText('Search club knowledge')).toBeTruthy();
    expect(within(overview).getByText('Reads')).toBeTruthy();

    const whereOn = screen.getByRole('heading', { name: "Where it's on" }).closest('section')!;
    expect(await within(whereOn).findByRole('checkbox', { name: 'Club assistant' })).toBeTruthy();
    const clubCheckbox = inputOf(within(whereOn).getByRole('checkbox', { name: 'Club assistant' }));
    const helpCheckbox = inputOf(within(whereOn).getByRole('checkbox', { name: 'IT help' }));
    expect(clubCheckbox.checked).toBe(true);
    expect(helpCheckbox.checked).toBe(false);

    const who = screen.getByRole('heading', { name: 'Who can use it' }).closest('section')!;
    expect(within(who).getByText('@Club Member, and the server owner')).toBeTruthy();

    const told = screen.getByRole('heading', { name: 'What the AI is told' }).closest('section')!;
    expect(within(told).getByText(SKILL_DETAIL.instructionLine).tagName).toBe('PRE');

    const tools = screen.getByRole('heading', { name: 'Tools' }).closest('section')!;
    expect(within(tools).getByText('search_archive')).toBeTruthy();
    expect(within(tools).getByText('query')).toBeTruthy();
    expect(within(tools).getByText('1–200 characters')).toBeTruthy();
    expect(within(tools).getByText('Yes', { selector: 'td' })).toBeTruthy();
    expect(within(tools).getAllByText('First round only').length).toBeGreaterThan(0);
    expect(within(tools).getByText('No parameters.')).toBeTruthy();

    const command = screen.getByRole('heading', { name: 'Slash command' }).closest('section')!;
    expect(within(command).getByText('/find')).toBeTruthy();
    expect(within(command).getByText('query', { selector: 'td' })).toBeTruthy();
    expect(within(command).getByText('What to find')).toBeTruthy();

    const runs = screen.getByRole('heading', { name: 'Recent runs' }).closest('section')!;
    expect(within(runs).getByText(/completed/)).toBeTruthy();
    expect(within(runs).getByRole('link', { name: 'Assistant history' }).getAttribute('href')).toBe(
      '/assistant/history',
    );
  });

  it('toggles a behaviour off by writing the whole behaviour object with the skill removed', async () => {
    const mock = renderPage();
    const whereOn = (await screen.findByRole('heading', { name: "Where it's on" })).closest(
      'section',
    )!;
    fireEvent.click(within(whereOn).getByRole('checkbox', { name: 'Club assistant' }));
    const put = await new Promise<[string, RequestInit]>((resolve) => {
      const check = () => {
        const call = mock.mock.calls.find(
          (c) =>
            c[0] === '/api/assistant/behaviours/club' && (c[1] as RequestInit)?.method === 'PUT',
        );
        if (call !== undefined) resolve(call as [string, RequestInit]);
        else setTimeout(check, 5);
      };
      check();
    });
    expect(bodyOf(put)).toMatchObject({ id: 'club', allowedSkillIds: [] });
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
    expect(await screen.findByText("That skill doesn't exist.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Skills' }).getAttribute('href')).toBe(
      '/assistant/skills',
    );
  });

  it('says a skill has no slash command when none is mapped', async () => {
    stubFetch([
      {
        url: '/api/assistant/skills/search-club',
        body: { ...SKILL_DETAIL, command: undefined },
      },
      { url: '/api/assistant', body: ASSISTANT_DATA },
    ]);
    const { hook } = memoryLocation({ path: '/assistant/skills/search-club' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/skills/:skillId" component={AssistantSkillPage} />
      </Router>,
    );
    expect(await screen.findByText('No slash command triggers this skill directly.')).toBeTruthy();
  });
});
