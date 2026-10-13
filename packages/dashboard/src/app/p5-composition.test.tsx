// @vitest-environment jsdom
import { cleanup, screen, within, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { Shell } from './Shell.js';
import { ThemeProvider } from './theme.js';
import { activeNavPath, NAV, pageTitle } from './routes.js';

const behaviour = {
  id: 'club',
  guildId: '1540816150026518620',
  surface: 'bananasaurs',
  mentionRoleId: 'role-club-assistant',
  name: 'Club assistant',
  systemPrompt: 'Reviewed club knowledge only.',
  promptVersion: 1,
  preferredSkillIds: [],
  resourceIds: [],
  enabled: true,
  callerRoleIds: [],
};
function open(path: string) {
  const mock = stubFetch([
    {
      url: '/api/health',
      body: {
        guildId: behaviour.guildId,
        guildName: 'Local composition',
        gateway: { connected: true, pingMs: 42, guildCount: 1 },
        safety: { killswitch: false, dryRun: false, breakerOpen: false },
        jobCounts: {},
      },
    },
    {
      url: '/api/assistant',
      body: { behaviours: [behaviour], resources: [], skills: [], activity: [], roles: [] },
    },
    { url: '/api/assistant/safety-suffix', body: { version: 1, text: 'Local locked suffix.' } },
  ]);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <ThemeProvider>
      <Router hook={hook}>
        <Shell />
      </Router>
    </ThemeProvider>,
  );
  return mock;
}
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('P5 composed behaviour routes', () => {
  it('opens detail in Shell with its breadcrumb and existing navigation/title owner, without a write', async () => {
    const mock = open('/assistant/behaviours/club');
    expect(await screen.findByRole('heading', { level: 1, name: 'Club assistant' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Full prompt' }).textContent).toContain(
      behaviour.systemPrompt,
    );
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
        .getByRole('link', { name: 'Behaviours' })
        .getAttribute('href'),
    ).toBe('/assistant');
    expect(
      screen.getByRole('link', { name: 'Behaviours', current: 'page' }).getAttribute('href'),
    ).toBe('/assistant');
    expect(screen.getByRole('link', { name: 'Build with the wizard' }).getAttribute('href')).toBe(
      '/assistant/behaviours/club/wizard',
    );
    await waitFor(() => expect(document.title).toBe('Behaviours · Bananasaurs'));
    expect(mock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('keeps the wizard route more specific than detail and makes no write on load', async () => {
    const mock = open('/assistant/behaviours/club/wizard');
    expect(await screen.findByRole('heading', { level: 1, name: 'Club assistant' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Full prompt' })).toBeNull();
    expect(await screen.findByText('Step 1 of 7')).toBeTruthy();
    expect(mock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('unknown behaviour stays NotFound instead of selecting the first behaviour', async () => {
    const mock = open('/assistant/behaviours/missing');
    expect(await screen.findByText("This behaviour doesn't exist or was deleted")).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Club assistant' })).toBeNull();
    expect(mock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('detail belongs to the existing Behaviours rail/palette entry, not an invented navigation item', () => {
    expect(activeNavPath('/assistant/behaviours/club')).toBe('/assistant');
    expect(activeNavPath('/assistant/behaviours/club/wizard')).toBe('/assistant');
    expect(pageTitle('/assistant/behaviours/club')).toBe('Behaviours');
    expect(NAV.filter((entry) => entry.path === '/assistant')).toHaveLength(1);
    expect(NAV.some((entry) => entry.path.includes('/behaviours/'))).toBe(false);
  });
});
