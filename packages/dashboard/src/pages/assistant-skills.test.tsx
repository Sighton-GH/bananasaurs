// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantSkillsPage } from './assistant-skills.js';

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
  activity: [],
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
  it('renders the catalogue without Discord permission claims', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    const catalogue = screen.getByRole('heading', { name: 'Skill catalogue' }).closest('section')!;
    expect(within(catalogue).getAllByText('Search club knowledge').length).toBeGreaterThan(0);
    expect(within(catalogue).queryByText(/Needs the Discord permission/)).toBeNull();
    expect(within(catalogue).queryByText('assistant.search')).toBeNull();
    expect(within(catalogue).getByText('Asks an operator first')).toBeTruthy();
    expect(within(catalogue).getAllByText('Can do automatically').length).toBeGreaterThan(0);
    expect(within(catalogue).getByText('owner only')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Assistant history' }).length).toBeGreaterThan(0);
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

  it('saves a skill grant and keeps owner-only skills unwidened', async () => {
    const mock = renderPage();
    const grants = (await screen.findByRole('heading', { name: 'Skill grants' })).closest(
      'section',
    )!;
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
    const ownerRow = within(grants).getByText('Deliver a reminder').closest('li')!;
    expect(within(ownerRow).queryByRole('checkbox')).toBeNull();
    expect(within(ownerRow).getByText(/Always restricted to the server owner/)).toBeTruthy();
  });

  it('fails closed when the server build does not expose skill grants', async () => {
    const body = { ...FULL } as Record<string, unknown>;
    delete body['skillGrants'];
    renderPage(body);
    expect(
      await screen.findByText(/Skill grants are not exposed by this server build yet/),
    ).toBeTruthy();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantSkillsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant skills/)).toBeTruthy();
  });
});
