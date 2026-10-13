// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../test-support.js';
import { ArchivePage } from './archive.js';
import { AssistantTuningPage } from './assistant-tuning.js';
import { useSession, type Session } from '../../app/session.js';
import type { AssistantData, AssistantSetup } from '../../api/assistant.js';
import { SetupTracker } from './assistant-setup-tracker.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('tab history focus (d3 L12)', () => {
  it('archive: browser Back moves focus to the restored tab trigger', async () => {
    stubFetch([
      { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
    ]);
    renderWithSession(
      <Router>
        <ArchivePage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    const user = userEvent.setup();
    const channelsTab = await screen.findByRole('tab', { name: 'Channels and browse' });
    await user.click(channelsTab);
    expect(channelsTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(channelsTab);
    await act(async () => {
      window.history.back();
    });
    const allTab = await screen.findByRole('tab', { name: 'All sections' });
    await vi.waitFor(() => expect(allTab.getAttribute('aria-selected')).toBe('true'));
    await vi.waitFor(() => expect(document.activeElement).toBe(allTab));
  });

  it('tuning: browser Back moves focus to the restored tab trigger', async () => {
    stubFetch([
      {
        url: '/api/assistant/tuning',
        body: {
          settings: [
            {
              key: 'assistant.maxToolRounds',
              group: 'Assistant tool loop',
              label: 'Max tool rounds',
              help: 'How many rounds of tool use one question may take.',
              display: 'count',
              bounds: { min: 1, max: 8 },
              value: 4,
              defaultValue: 4,
              isDefault: true,
            },
          ],
        },
      },
    ]);
    renderWithSession(
      <Router>
        <AssistantTuningPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    const user = userEvent.setup();
    const assistantTab = await screen.findByRole('tab', { name: 'Assistant' });
    await user.click(assistantTab);
    expect(assistantTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(assistantTab);
    await act(async () => {
      window.history.back();
    });
    const allTab = await screen.findByRole('tab', { name: 'All settings' });
    await vi.waitFor(() => expect(allTab.getAttribute('aria-selected')).toBe('true'));
    await vi.waitFor(() => expect(document.activeElement).toBe(allTab));
  });

  it('does not move focus when it was not on a tab trigger', async () => {
    stubFetch([
      { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
    ]);
    renderWithSession(
      <Router>
        <ArchivePage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    const user = userEvent.setup();
    const channelsTab = await screen.findByRole('tab', { name: 'Channels and browse' });
    await user.click(channelsTab);
    expect(channelsTab.getAttribute('aria-selected')).toBe('true');
    // Focus lives on a control outside the tab list when history moves.
    const updateButton = screen.getByRole('button', { name: 'Update search results' });
    updateButton.focus();
    expect(document.activeElement).toBe(updateButton);
    await act(async () => {
      window.history.back();
    });
    const allTab = await screen.findByRole('tab', { name: 'All sections' });
    await vi.waitFor(() => expect(allTab.getAttribute('aria-selected')).toBe('true'));
    await vi.waitFor(() => expect(document.activeElement).not.toBe(allTab));
  });
});

const TRACKER_ROLES = [
  { id: 'role-member', name: 'Member', position: 10 },
  { id: 'role-helper', name: 'Helper', position: 5 },
];

function trackerSteps(): AssistantSetup {
  const state = (id: 'connect' | 'terms' | 'cost' | 'who' | 'skills' | 'on') =>
    id === 'connect' || id === 'terms'
      ? { state: 'done' as const, detail: `${id} detail.` }
      : { state: 'todo' as const, detail: `${id} detail.` };
  return {
    answering: false,
    steps: [
      { id: 'connect', ...state('connect') },
      { id: 'terms', ...state('terms') },
      { id: 'cost', ...state('cost') },
      { id: 'who', ...state('who') },
      { id: 'skills', ...state('skills') },
      { id: 'on', ...state('on') },
    ],
  };
}

function trackerData(): AssistantData {
  return {
    behaviours: [],
    resources: [],
    reminders: [],
    skills: [],
    activity: [],
    roles: TRACKER_ROLES,
    aiStatus: {
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: true,
      keyReadable: true,
      costClass: 'free',
      secretSource: 'env',
    },
    setup: trackerSteps(),
  };
}

describe('who-can-ask discard focus (d3 L14)', () => {
  it('Discard lands focus on the draft field, not body', async () => {
    stubFetch([]);
    function Capture() {
      const session: Session = useSession();
      return <SetupTracker data={trackerData()} session={session} reload={() => undefined} />;
    }
    renderWithSession(<Capture />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Member' }));
    const discard = await screen.findByRole('button', { name: 'Discard' });
    await user.click(discard);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    const member = screen.getByRole('checkbox', { name: 'Member' });
    await vi.waitFor(() => expect(document.activeElement).toBe(member));
    expect(document.activeElement).not.toBe(document.body);
  });
});
