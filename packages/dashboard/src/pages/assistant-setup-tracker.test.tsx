// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { useSession, type Session } from '../app/session.js';
import type { AssistantData, AssistantSetup } from '../api/assistant.js';
import { DEFAULT_PROMPT, SetupTracker } from './assistant-setup-tracker.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const ROLES = [
  { id: 'role-member', name: 'Member', position: 10 },
  { id: 'role-helper', name: 'Helper', position: 5 },
];

function steps(
  overrides: Partial<Record<string, { state: 'done' | 'todo' | 'blocked'; detail: string }>> = {},
): AssistantSetup {
  const get = (id: 'connect' | 'terms' | 'cost' | 'who' | 'skills' | 'on') =>
    overrides[id] ?? { state: 'todo' as const, detail: `${id} detail.` };
  return {
    answering: false,
    steps: [
      { id: 'connect', ...get('connect') },
      { id: 'terms', ...get('terms') },
      { id: 'cost', ...get('cost') },
      { id: 'who', ...get('who') },
      { id: 'skills', ...get('skills') },
      { id: 'on', ...get('on') },
    ],
  };
}

function baseData(overrides: Partial<AssistantData> = {}): AssistantData {
  const { setup, ...rest } = overrides;
  const fallback = steps({
    connect: { state: 'done', detail: 'A provider is connected.' },
    terms: { state: 'done', detail: 'Terms are recorded.' },
    cost: { state: 'todo', detail: 'Confirm the model costs nothing.' },
    who: { state: 'todo', detail: 'No behaviour has caller roles yet.' },
    skills: { state: 'todo', detail: 'No everyday skills granted yet.' },
    on: { state: 'todo', detail: 'Nothing is turned on yet.' },
  });
  return {
    behaviours: [],
    resources: [],
    reminders: [],
    skills: [
      {
        id: 's-old',
        name: 'Search club knowledge',
        description: 'Search.',
        effect: 'read',
        requiredPermission: 'assistant.search',
        requiresConfirmation: false,
      },
    ],
    activity: [],
    roles: ROLES,
    aiStatus: {
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: true,
      keyReadable: true,
      costClass: 'free',
      secretSource: 'env',
    },
    ...rest,
    setup: setup ?? fallback,
  };
}

function renderTracker(data: AssistantData) {
  const reload = vi.fn();
  function Capture() {
    const session: Session = useSession();
    return <SetupTracker data={data} session={session} reload={reload} />;
  }
  const rendered = renderWithSession(<Capture />);
  return { ...rendered, reload };
}

const TITLES = [
  'Connect an AI service',
  'Record what its terms say',
  "Confirm it's free to use",
  'Choose who can ask',
  'Choose what it can do',
  'Turn it on',
];

describe('SetupTracker', () => {
  it('renders six rows in order with the server details and n of 6 done', async () => {
    stubFetch([]);
    renderTracker(baseData());
    expect(await screen.findByText('Set up the assistant')).toBeTruthy();
    expect(screen.getByText('2 of 6 done')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Setup steps' });
    const items = Array.from(list.children).filter((el) => el.tagName === 'LI');
    expect(items).toHaveLength(6);
    TITLES.forEach((title, i) => {
      expect(within(items[i]! as HTMLElement).getByText(title)).toBeTruthy();
    });
    expect(within(items[0]! as HTMLElement).getByText('A provider is connected.')).toBeTruthy();
    expect(
      within(items[3]! as HTMLElement).getByText('No behaviour has caller roles yet.'),
    ).toBeTruthy();
  });

  it('shows the hidden word Needs attention for a blocked step', () => {
    stubFetch([]);
    renderTracker(
      baseData({
        setup: steps({
          connect: { state: 'done', detail: 'Connected.' },
          terms: { state: 'blocked', detail: 'Terms need review.' },
        }),
      }),
    );
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getAllByText('To do')).toHaveLength(4);
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('with no behaviours, Save who can ask creates the disabled club assistant', async () => {
    const mock = stubFetch([
      { method: 'PUT', url: '/api/assistant/behaviours/default', body: { ok: true } },
    ]);
    const { reload } = renderTracker(baseData({ behaviours: [] }));
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const whoRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Choose who can ask') !== null)!;
    fireEvent.click(within(whoRow).getByRole('checkbox', { name: 'Member' }));
    fireEvent.click(within(whoRow).getByRole('button', { name: 'Save who can ask' }));
    await screen.findByText('Saved who can ask');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/default' && c[1]?.method === 'PUT',
    )!;
    expect(bodyOf(put)).toEqual({
      id: 'default',
      surface: 'direct-command',
      name: 'Club assistant',
      systemPrompt: DEFAULT_PROMPT,
      promptVersion: 0,
      allowedSkillIds: [],
      resourceIds: [],
      callerRoleIds: ['role-member'],
      enabled: false,
    });
    expect(reload).toHaveBeenCalled();
  });

  it('grants the everyday skills with the union of caller roles and skill ids', async () => {
    const behaviour = {
      id: 'club',
      guildId: 'g1',
      surface: 'direct-command',
      name: 'Club assistant',
      systemPrompt: 'Prompt.',
      promptVersion: 1,
      allowedSkillIds: ['s-old'],
      resourceIds: [],
      reviewerRoleIds: [],
      enabled: false,
      callerRoleIds: ['role-member', 'role-helper'],
    } as const;
    const mock = stubFetch([
      {
        method: 'POST',
        url: '/api/assistant/skill-grants/starter',
        body: { skillIds: ['s-new'] },
      },
      { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    ]);
    const { reload } = renderTracker(
      baseData({
        behaviours: [{ ...behaviour, surface: 'direct-command' as const }],
        setup: steps({
          connect: { state: 'done', detail: 'Connected.' },
          terms: { state: 'done', detail: 'Terms recorded.' },
          cost: { state: 'done', detail: 'Free.' },
          who: { state: 'done', detail: 'Roles chosen.' },
          skills: { state: 'todo', detail: 'No everyday skills granted yet.' },
          on: { state: 'todo', detail: 'Nothing is turned on yet.' },
        }),
      }),
    );
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const skillsRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Choose what it can do') !== null)!;
    fireEvent.click(
      within(skillsRow).getByRole('button', { name: 'Let them use the everyday skills' }),
    );
    await screen.findByText('Everyday skills turned on');
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/skill-grants/starter' && c[1]?.method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({ roleIds: ['role-member', 'role-helper'] });
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { allowedSkillIds: string[] }).allowedSkillIds).toEqual([
      's-old',
      's-new',
    ]);
    expect(reload).toHaveBeenCalled();
  });

  it('disables the skills button with Choose who can ask first when no behaviour has roles', async () => {
    stubFetch([]);
    renderTracker(
      baseData({
        behaviours: [
          {
            id: 'club',
            guildId: 'g1',
            surface: 'direct-command',
            name: 'Club assistant',
            systemPrompt: 'Prompt.',
            promptVersion: 1,
            allowedSkillIds: [],
            resourceIds: [],
            reviewerRoleIds: [],
            enabled: false,
            callerRoleIds: [],
          },
        ],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const skillsRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Choose what it can do') !== null)!;
    const button = within(skillsRow).getByRole('button', {
      name: 'Let them use the everyday skills',
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(within(skillsRow).getByText('Choose who can ask first')).toBeTruthy();
  });

  it('Turn on writes enabled true and shows the inline conflict sentence on 409', async () => {
    stubFetch([
      {
        method: 'PUT',
        url: '/api/assistant/behaviours/club',
        status: 409,
        body: { error: 'behaviour-conflict' },
      },
    ]);
    renderTracker(
      baseData({
        behaviours: [
          {
            id: 'club',
            guildId: 'g1',
            surface: 'direct-command',
            name: 'Club assistant',
            systemPrompt: 'Prompt.',
            promptVersion: 1,
            allowedSkillIds: [],
            resourceIds: [],
            reviewerRoleIds: [],
            enabled: false,
            callerRoleIds: ['role-member'],
          },
        ],
        setup: steps({
          connect: { state: 'done', detail: 'Connected.' },
          terms: { state: 'done', detail: 'Terms recorded.' },
          cost: { state: 'done', detail: 'Free.' },
          who: { state: 'done', detail: 'Roles chosen.' },
          skills: { state: 'done', detail: 'Skills granted.' },
          on: { state: 'todo', detail: 'Nothing is turned on yet.' },
        }),
      }),
    );
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const onRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Turn it on') !== null)!;
    fireEvent.click(within(onRow).getByRole('button', { name: 'Turn on Club assistant' }));
    expect(
      await within(onRow).findByText(
        'Another behaviour already answers that mention role. Turn that one off first.',
      ),
    ).toBeTruthy();
  });

  it('turns on successfully with a toast and reload', async () => {
    const mock = stubFetch([
      { method: 'PUT', url: '/api/assistant/behaviours/club', body: { ok: true } },
    ]);
    const { reload } = renderTracker(
      baseData({
        behaviours: [
          {
            id: 'club',
            guildId: 'g1',
            surface: 'direct-command',
            name: 'Club assistant',
            systemPrompt: 'Prompt.',
            promptVersion: 1,
            allowedSkillIds: [],
            resourceIds: [],
            reviewerRoleIds: [],
            enabled: false,
            callerRoleIds: ['role-member'],
          },
        ],
        setup: steps({
          connect: { state: 'done', detail: 'Connected.' },
          terms: { state: 'done', detail: 'Terms recorded.' },
          cost: { state: 'done', detail: 'Free.' },
          who: { state: 'done', detail: 'Roles chosen.' },
          skills: { state: 'done', detail: 'Skills granted.' },
          on: { state: 'todo', detail: 'Nothing is turned on yet.' },
        }),
      }),
    );
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const onRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Turn it on') !== null)!;
    fireEvent.click(within(onRow).getByRole('button', { name: 'Turn on Club assistant' }));
    await screen.findByText('Club assistant turned on');
    const put = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/assistant/behaviours/club' && c[1]?.method === 'PUT',
    )!;
    expect((bodyOf(put) as { enabled: boolean }).enabled).toBe(true);
    expect(reload).toHaveBeenCalled();
  });

  it('links to AI setup from the on step with no turn-on button when AI is off', async () => {
    stubFetch([]);
    renderTracker(
      baseData({
        aiStatus: {
          provider: 'off',
          enabled: false,
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          costClass: 'unknown',
          secretSource: 'missing',
        },
        behaviours: [
          {
            id: 'club',
            guildId: 'g1',
            surface: 'direct-command',
            name: 'Club assistant',
            systemPrompt: 'Prompt.',
            promptVersion: 1,
            allowedSkillIds: [],
            resourceIds: [],
            reviewerRoleIds: [],
            enabled: false,
            callerRoleIds: ['role-member'],
          },
        ],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Setup steps' });
    const onRow = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Turn it on') !== null)!;
    expect(within(onRow).getByText('Open AI setup')).toBeTruthy();
    expect(within(onRow).queryByRole('button', { name: /Turn on/ })).toBeNull();
  });

  it('collapses to the Answering summary when answering until Show setup steps', async () => {
    stubFetch([]);
    renderTracker(
      baseData({
        setup: {
          answering: true,
          steps: [
            { id: 'connect', state: 'done', detail: 'Connected.' },
            { id: 'terms', state: 'done', detail: 'Terms recorded.' },
            { id: 'cost', state: 'done', detail: 'Free.' },
            { id: 'who', state: 'done', detail: 'Roles chosen.' },
            { id: 'skills', state: 'done', detail: 'Skills granted.' },
            { id: 'on', state: 'done', detail: 'On.' },
          ],
        },
      }),
    );
    expect(await screen.findByText('Answering')).toBeTruthy();
    expect(
      screen.getByText(
        "Members can ask in Discord with /ask, or by mentioning a behaviour's role.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Setup steps' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show setup steps' }));
    expect(screen.getByRole('list', { name: 'Setup steps' })).toBeTruthy();
  });

  it('renders nothing when setup is undefined', () => {
    stubFetch([]);
    const data = baseData() as unknown as Record<string, unknown>;
    delete data['setup'];
    const { container } = renderTracker(data as unknown as AssistantData);
    expect(container.textContent).toBe('');
  });
});
