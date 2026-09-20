// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { DoctorPage } from './doctor.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const DOCTOR = { ok: false, text: 'PROBLEMS FOUND\n- stale panel: welcome', data: { stale: 1 } };
const PUBLIC = { probed: true, ok: true, text: 'public surface as intended', data: {} };

describe('DoctorPage', () => {
  it('renders both halves with their ok state and text', async () => {
    const mock = stubFetch([
      { url: '/api/doctor', body: DOCTOR },
      { url: '/api/doctor/public-surface', body: PUBLIC },
    ]);
    renderWithSession(<DoctorPage />);
    expect(await screen.findByText(/stale panel: welcome/)).toBeTruthy();
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
    expect(await screen.findByText('not probed — MCP_PUBLIC_URL is unset')).toBeTruthy();
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
