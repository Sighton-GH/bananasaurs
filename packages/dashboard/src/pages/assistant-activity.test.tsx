// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AssistantActivityPage } from './assistant-activity.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const PAYLOAD = {
  behaviours: [
    {
      id: 'club',
      guildId: '1540816150026518620',
      surface: 'bananasaurs',
      name: 'Club assistant',
      systemPrompt: 'Prompt.',
      allowedSkillIds: ['search-club'],
      resourceIds: [],
      enabled: true,
    },
  ],
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
  activity: [
    {
      id: 'act-1',
      at: 1790000000000,
      behaviourId: 'club',
      skillId: 'search-club',
      outcome: 'answered',
    },
    {
      id: 'act-2',
      at: 1790000001000,
      behaviourId: 'retired-behaviour',
      skillId: 'search-club',
      outcome: 'refused',
      detail: 'missing assistant.search',
    },
  ],
};

describe('AssistantActivityPage', () => {
  it('resolves behaviour and skill names and keeps refusal reasons visible', async () => {
    stubFetch([{ url: '/api/assistant', body: PAYLOAD }]);
    renderWithSession(<AssistantActivityPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Skill activity' })).toBeTruthy();
    expect(screen.getByText('Club assistant')).toBeTruthy();
    expect(screen.getAllByText('Search club knowledge')).toHaveLength(2);
    // A row that outlives its behaviour falls back to the raw id.
    expect(screen.getByText('retired-behaviour')).toBeTruthy();
    expect(screen.getByText('refused')).toBeTruthy();
    expect(screen.getByText('missing assistant.search')).toBeTruthy();
    expect(screen.getByText('answered')).toBeTruthy();
  });

  it('renders the empty state', async () => {
    stubFetch([{ url: '/api/assistant', body: { ...PAYLOAD, activity: [] } }]);
    renderWithSession(<AssistantActivityPage />);
    expect(await screen.findByText('No skill activity yet')).toBeTruthy();
    expect(screen.getByText(/Refusals are recorded with their reason/)).toBeTruthy();
  });

  it('renders the error state when the load fails', async () => {
    stubFetch([]);
    renderWithSession(<AssistantActivityPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not load assistant skill activity/)).toBeTruthy();
  });
});
