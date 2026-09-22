// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { DoctorPage } from './doctor.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const DOCTOR = {
  ok: false,
  text: 'PROBLEMS FOUND\n- stale panel: welcome',
  data: {
    stale: 1,
    problems: [
      {
        title: 'Role panel welcome-roles is disabled',
        impact: 'Members cannot get roles from it.',
        fix: 'Enable the panel, or delete it if it is no longer needed.',
        route: '/panels',
        details: 'panel welcome-roles  status disabled',
      },
      {
        title: 'The bot is missing required permissions in Club (123)',
        impact: 'Every feature that needs one of these silently fails.',
        fix: "Discord: Server Settings -> Roles -> the bot's role -> enable Manage Messages.",
      },
    ],
    advisories: ['Club (123): the bot holds extra permissions (Administrator) - safe to remove.'],
  },
};
const PUBLIC = { probed: true, ok: true, text: 'public surface as intended', data: {} };

describe('DoctorPage', () => {
  it('renders both halves with their ok state and text', async () => {
    const mock = stubFetch([
      { url: '/api/doctor', body: DOCTOR },
      { url: '/api/doctor/public-surface', body: PUBLIC },
    ]);
    renderWithSession(<DoctorPage />);
    // Problems lead, each with its fix and direct route; raw text is
    // secondary inside the collapsed diagnostics.
    expect(await screen.findByText('Role panel welcome-roles is disabled')).toBeTruthy();
    expect(screen.getAllByText(/Enable the panel, or delete it/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open /panels' }).getAttribute('href')).toBe('/panels');
    expect(screen.getByText('The bot is missing required permissions in Club (123)')).toBeTruthy();
    expect(screen.getAllByText(/extra permissions \(Administrator\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/stale panel: welcome/)).toBeTruthy();
    expect(screen.getByText('problems found')).toBeTruthy();
    expect(screen.getByText('as intended')).toBeTruthy();
    expect(screen.getByText(/public surface as intended/)).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/doctor',
      '/api/doctor/public-surface',
    ]);
  });

  it('says so when the public surface was not probed', async () => {
    stubFetch([
      { url: '/api/doctor', body: { ok: true, text: 'no problems found', data: {} } },
      { url: '/api/doctor/public-surface', body: { probed: false, ok: true, text: '', data: {} } },
    ]);
    renderWithSession(<DoctorPage />);
    expect(
      await screen.findByText('not checked - the public connector URL is not configured'),
    ).toBeTruthy();
  });

  it('re-run checks refetches both reports', async () => {
    const mock = stubFetch([
      { url: '/api/doctor', body: { ok: true, text: 'fine', data: {} } },
      { url: '/api/doctor/public-surface', body: PUBLIC },
    ]);
    renderWithSession(<DoctorPage />);
    await screen.findByText('fine');
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }));
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/doctor')).toHaveLength(2);
    expect(
      mock.mock.calls.filter((c) => (c[0] as string) === '/api/doctor/public-surface'),
    ).toHaveLength(2);
  });
});
