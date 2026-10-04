// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomodStateView } from '../api/automod.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AutomodSwitch } from './automod-switch.js';

afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function view(overrides: Partial<AutomodStateView> = {}): AutomodStateView {
  return {
    state: 'off',
    dryRun: false,
    killswitch: false,
    enabledRules: [
      { ruleId: 'kw-one', name: 'Slurs' },
      { ruleId: 'inv', name: 'Invite links' },
    ],
    ...overrides,
  };
}

const DRY_RUN_NOTE =
  'Dry run is on for this server, so matches are logged, not acted on, until dry run is turned off on the Configuration page.';
const CARL_BOT =
  "Turn off the matching Carl-bot or Dyno automod first, so two bots don't act on the same message.";

describe('AutomodSwitch', () => {
  it('renders the Automod group with three buttons and the Off meaning', async () => {
    stubFetch([{ url: '/api/automod/state', body: view() }]);
    renderWithSession(<AutomodSwitch />);
    const group = await screen.findByRole('group', { name: 'Automod' });
    expect(group.textContent ?? '').toContain('Off');
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Watch' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('false');
    expect(
      screen.getByText('Automod is off. It does not check messages and records nothing.'),
    ).toBeTruthy();
  });

  it('clicking On opens the dialog and Cancel sends no PUT', async () => {
    const mock = stubFetch([{ url: '/api/automod/state', body: view() }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent ?? '').toContain('Turn automod on?');
    expect(dialog.textContent ?? '').toContain('Slurs');
    expect(dialog.textContent ?? '').toContain('Invite links');
    expect(dialog.textContent ?? '').toContain(CARL_BOT);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      mock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);
  });

  it('confirming the On dialog sends PUT and re-reads state', async () => {
    const mock = stubFetch([
      { url: '/api/automod/state', body: view() },
      { method: 'PUT', url: '/api/automod/state', body: { ok: true, state: 'on' } },
    ]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }));
    });
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn automod on' }));
    });
    const put = mock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(bodyOf(put!)).toEqual({ state: 'on' });
    const gets = mock.mock.calls.filter(
      (c) =>
        (c[0] as string) === '/api/automod/state' &&
        (c[1] as RequestInit | undefined)?.method !== 'PUT',
    );
    expect(gets).toHaveLength(2);

  it('shows the dry-run note in the On dialog when dryRun is true', async () => {
    stubFetch([{ url: '/api/automod/state', body: view({ dryRun: true }) }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent ?? '').toContain(DRY_RUN_NOTE);
  });

  it('shows the dry-run note on the card when on with dryRun', async () => {
    stubFetch([{ url: '/api/automod/state', body: view({ state: 'on', dryRun: true }) }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    expect(screen.getByText(DRY_RUN_NOTE)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the kill-switch note on the card', async () => {
    stubFetch([{ url: '/api/automod/state', body: view({ state: 'on', killswitch: true }) }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    expect(screen.getByText('The kill switch is on: nothing is sent to Discord.')).toBeTruthy();
  });

  it('clicking the button for the current state opens no dialog', async () => {
    stubFetch([{ url: '/api/automod/state', body: view() }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking Off from On opens the off dialog', async () => {
    stubFetch([{ url: '/api/automod/state', body: view({ state: 'on' }) }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent ?? '').toContain('Turn automod off?');
    expect(screen.getByRole('button', { name: 'Turn automod off' })).toBeTruthy();
  });

  it('shows the empty-rules sentence when no rules are enabled', async () => {
    stubFetch([{ url: '/api/automod/state', body: view({ enabledRules: [] }) }]);
    renderWithSession(<AutomodSwitch />);
    await screen.findByRole('group', { name: 'Automod' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent ?? '').toContain(
      'No rules are enabled, so nothing will happen until you enable one.',
    );
  });
  });
});
