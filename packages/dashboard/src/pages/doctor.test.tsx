// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
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
    await screen.findByText(/^fine/);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }));
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/doctor')).toHaveLength(2);
    expect(
      mock.mock.calls.filter((c) => (c[0] as string) === '/api/doctor/public-surface'),
    ).toHaveLength(2);
  });
});

describe('Doctor sweep', () => {
  it('keeps structured problem rows and copied reports inside Advanced', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    stubFetch([
      { url: '/api/doctor', body: DOCTOR },
      { url: '/api/doctor/public-surface', body: PUBLIC },
    ]);
    const { container } = renderWithSession(<DoctorPage />);
    await screen.findByText('Role panel welcome-roles is disabled');
    expect(screen.getByRole('table', { name: 'Doctor problems' })).toBeTruthy();
    expect(screen.getAllByText('Needs attention')).toHaveLength(2);
    expect(screen.getAllByText('Advisory').length).toBeGreaterThan(0);
    for (const pre of container.querySelectorAll('pre')) {
      expect(pre.closest('details')?.querySelector('summary')?.textContent).toBe('Advanced');
    }
    fireEvent.click(container.querySelector('summary')!);
    const report = screen.getByRole('region', { name: 'Bot and server report' });
    fireEvent.click(within(report).getByRole('button', { name: 'Copy' }));
    await within(report).findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith(
      DOCTOR.text + '\n\n' + JSON.stringify(DOCTOR.data, null, 2),
    );
  });

  it('does not invent checks for a legacy report or green health for an unconfigured probe', async () => {
    stubFetch([
      { url: '/api/doctor', body: { ok: false, text: 'old server report', data: {} } },
      { url: '/api/doctor/public-surface', body: { probed: false, ok: true, text: '', data: {} } },
    ]);
    renderWithSession(<DoctorPage />);
    expect(
      await screen.findByText('The structured fix is unavailable in this report.'),
    ).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Doctor problems' })).toBeNull();
    expect(screen.queryByText('as intended')).toBeNull();
    expect(
      screen.getByText('not checked - the public connector URL is not configured'),
    ).toBeTruthy();
  });

  it('shows a report load failure without hiding the working public result', async () => {
    stubFetch([
      {
        url: '/api/doctor',
        status: 500,
        body: { error: 'unavailable', message: 'Doctor is offline' },
      },
      { url: '/api/doctor/public-surface', body: PUBLIC },
    ]);
    renderWithSession(<DoctorPage />);
    expect(await screen.findByText('Doctor is offline')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText('as intended')).toBeTruthy();
  });
});

it('reports a probed public failure without fabricating a structured check', async () => {
  stubFetch([
    { url: '/api/doctor', body: { ok: true, text: 'ready', data: {} } },
    {
      url: '/api/doctor/public-surface',
      body: {
        probed: true,
        ok: false,
        text: 'Access policy exposes private routes',
        data: { status: 200 },
      },
    },
  ]);
  renderWithSession(<DoctorPage />);
  expect(await screen.findByText('Internet access is not configured as intended')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open connector settings' }).getAttribute('href')).toBe(
    '/mcp',
  );
  expect(screen.queryByText('as intended')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Doctor problems' })).toBeNull();
});
