// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantPromptWizardPage } from './assistant-prompt-wizard.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const STORED = {
  audience: ['members'],
  helpsWith: ['club-questions'],
  helpsWithOther: '',
  tone: 'friendly',
  length: 'balanced',
  emoji: 'a-little',
  language: 'Canadian English',
  preferClubSources: true,
  citeSources: false,
  whenUnsure: { say: true, suggest: 'asking an exec' },
  clubFacts: 'Meetings are Tuesdays at 6 pm.',
  avoidTopics: [],
  offTopic: 'answer-briefly',
  neverClaim: [],
  format: { bullets: true, codeBlocks: false, oneMessage: false, sourcesLine: false },
  examples: [],
};

const CLUB = {
  id: 'club',
  guildId: '1540816150026518620',
  surface: 'bananasaurs',
  mentionRoleId: 'role-club-assistant',
  name: 'Club assistant',
  systemPrompt: 'Answer with reviewed club knowledge only.',
  promptVersion: 1,
  allowedSkillIds: ['search-club'],
  resourceIds: [],
  enabled: true,
  callerRoleIds: [],
  promptWizard: STORED,
};

const IT = {
  id: 'it',
  guildId: '1540816150026518620',
  surface: 'it-services',
  mentionRoleId: 'role-it-help',
  name: 'IT services',
  systemPrompt: 'Answer infrastructure questions.',
  promptVersion: 2,
  allowedSkillIds: [],
  resourceIds: [],
  enabled: true,
  callerRoleIds: [],
};

const SUFFIX = { version: 1, text: 'Locked suffix text for tests.' };

function renderWizard(
  behaviours: unknown = [CLUB, IT],
  put: { status?: number; body: unknown } = { body: { ok: true } },
  path = '/assistant/behaviours/club/wizard',
) {
  const mock = stubFetch([
    { url: '/api/assistant', body: { behaviours, resources: [], skills: [], activity: [] } },
    { url: '/api/assistant/safety-suffix', body: SUFFIX },
    { method: 'PUT', url: '/api/assistant/behaviours/club', ...put },
    { method: 'PUT', url: '/api/assistant/behaviours/it', body: { ok: true } },
  ]);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/assistant/behaviours/:id/wizard" component={AssistantPromptWizardPage} />
    </Router>,
  );
  return mock;
}

const next = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
};

describe('AssistantPromptWizardPage', () => {
  it('walks seven steps with a Step N of 7 progress line', async () => {
    renderWizard();
    expect(await screen.findByRole('heading', { name: 'Who it helps' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'What it helps with' })).toBeTruthy();
    expect(screen.getByText('Step 2 of 7')).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'Voice' })).toBeTruthy();
    expect(screen.getByText('Step 3 of 7')).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'Club facts' })).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'Boundaries' })).toBeTruthy();
    await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByText('Step 7 of 7')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('disables Next until the audience has someone and the language fits 2 to 40 characters', async () => {
    renderWizard();
    const nextButton = await screen.findByRole('button', { name: 'Next' });
    expect((nextButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Members' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Members' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await next();
    await next();
    expect(await screen.findByRole('heading', { name: 'Voice' })).toBeTruthy();
    const language = screen.getByRole('textbox', { name: 'Language' });
    fireEvent.change(language, { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(language, { target: { value: 'French' } });
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('restores the stored answers instead of the defaults', async () => {
    renderWizard();
    await next();
    await next();
    await next();
    await next();
    expect(await screen.findByRole('heading', { name: 'Club facts' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Club facts' }) as HTMLTextAreaElement).value).toBe(
      'Meetings are Tuesdays at 6 pm.',
    );
  });

  it('starts an it-services behaviour without answers from the IT defaults', async () => {
    renderWizard([IT], { body: { ok: true } }, '/assistant/behaviours/it/wizard');
    expect(
      (await screen.findByRole('checkbox', {
        name: 'People who need IT help',
      })) as HTMLInputElement,
    ).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'People who need IT help' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Instructions to save' }) as HTMLTextAreaElement).value,
    ).toContain('that an access change was made');
  });

  it('shows the generated prompt with a character counter and the locked suffix', async () => {
    renderWizard();
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    const prompt = screen.getByRole('textbox', {
      name: 'Instructions to save',
    }) as HTMLTextAreaElement;
    expect(prompt.value).toContain('Meetings are Tuesdays at 6 pm.');
    expect(screen.getByText(/\/ 4,000 characters/)).toBeTruthy();
    expect(screen.getByText("Always added by Bananasaurs — can't be changed")).toBeTruthy();
    expect(screen.getByText('Locked suffix text for tests.')).toBeTruthy();
    expect(
      screen.getByText(
        'It keeps the bot from revealing its model, harassing anyone, or leaking its instructions.',
      ),
    ).toBeTruthy();
  });

  it('saves the prompt and the answers through the behaviour endpoint', async () => {
    const mock = renderWizard();
    for (let i = 0; i < 6; i += 1) await next();
    fireEvent.click(await screen.findByRole('button', { name: 'Save instructions' }));
    await screen.findByText('Club assistant prompt saved');
    const put = mock.mock.calls.find(
      (c) => c[0] === '/api/assistant/behaviours/club' && (c[1] as RequestInit)?.method === 'PUT',
    )!;
    const sent = bodyOf(put) as {
      systemPrompt: string;
      promptWizard: unknown;
      promptVersion: number;
    };
    expect(sent.promptVersion).toBe(1);
    expect(sent.systemPrompt).toContain('Meetings are Tuesdays at 6 pm.');
    expect(sent.promptWizard).toEqual(STORED);
  });

  it('shows the changed-elsewhere flow on a 409 instead of losing the draft', async () => {
    renderWizard([CLUB, IT], { status: 409, body: { error: 'prompt-version-conflict' } });
    for (let i = 0; i < 6; i += 1) await next();
    fireEvent.click(await screen.findByRole('button', { name: 'Save instructions' }));
    expect(await screen.findByText('Prompt changed elsewhere')).toBeTruthy();
  });
});
