// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { DEFAULT_PERSONALITY, promptWizardAnswers } from '@bananasaurs/core';
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

const buttonOf = (element: HTMLElement): HTMLButtonElement => {
  if (!(element instanceof HTMLButtonElement)) throw new Error('expected a <button>');
  return element;
};
const inputOf = (element: HTMLElement): HTMLInputElement => {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an <input>');
  return element;
};
const textAreaOf = (element: HTMLElement): HTMLTextAreaElement => {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('expected a <textarea>');
  return element;
};

const next = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
};

describe('AssistantPromptWizardPage', () => {
  it('walks seven steps with a Step N of 7 progress line', async () => {
    renderWizard();
    expect(
      await screen.findByRole('heading', { name: 'Your server and who it helps' }),
    ).toBeTruthy();
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
    expect(await screen.findByRole('heading', { name: 'Club facts and terms' })).toBeTruthy();
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
    expect(buttonOf(nextButton).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Members' }));
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Members' }));
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(false);
    await next();
    await next();
    expect(await screen.findByRole('heading', { name: 'Voice' })).toBeTruthy();
    const language = screen.getByRole('textbox', { name: 'Language' });
    fireEvent.change(language, { target: { value: '' } });
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(true);
    fireEvent.change(language, { target: { value: 'French' } });
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(false);
  });

  it('disables Next when any identity field exceeds its limit', async () => {
    renderWizard();
    await screen.findByRole('textbox', { name: 'Club or server name' });
    for (const [name, value] of [
      ['Club or server name', 'x'.repeat(81)],
      ['Bot name', 'x'.repeat(41)],
      ['Personality in one line', 'x'.repeat(161)],
    ] as const) {
      fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
      expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(true);
      fireEvent.change(screen.getByRole('textbox', { name }), { target: { value: '' } });
    }
  });

  it('disables Next when channel guidance or the glossary exceeds its limit', async () => {
    renderWizard();
    await next();
    await next();
    await next();
    await next();
    fireEvent.change(screen.getByRole('textbox', { name: 'What the main channels are for' }), {
      target: { value: 'x'.repeat(601) },
    });
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(true);

    cleanup();
    const glossary = Array.from({ length: 11 }, (_, index) => ({
      term: `term-${index}`,
      meaning: `meaning-${index}`,
    }));
    renderWizard([{ ...CLUB, promptWizard: { ...STORED, glossary } }]);
    for (let i = 0; i < 4; i += 1) await next();
    expect(buttonOf(screen.getByRole('button', { name: 'Next' })).disabled).toBe(true);
  });

  it('restores the stored answers instead of the defaults', async () => {
    renderWizard();
    await next();
    await next();
    await next();
    await next();
    expect(await screen.findByRole('heading', { name: 'Club facts and terms' })).toBeTruthy();
    expect(textAreaOf(screen.getByRole('textbox', { name: 'Club facts' })).value).toBe(
      'Meetings are Tuesdays at 6 pm.',
    );
  });

  it('starts an it-services behaviour without answers from the IT defaults', async () => {
    renderWizard([IT], { body: { ok: true } }, '/assistant/behaviours/it/wizard');
    expect(
      await screen.findByRole('checkbox', {
        name: 'People who need IT help',
      }),
    ).toBeTruthy();
    expect(inputOf(screen.getByRole('checkbox', { name: 'People who need IT help' })).checked).toBe(
      true,
    );
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(
      textAreaOf(screen.getByRole('textbox', { name: 'Instructions to save' })).value,
    ).toContain('that an access change was made');
  });

  it('shows the generated prompt with a character counter and the locked suffix', async () => {
    renderWizard();
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    const prompt = textAreaOf(screen.getByRole('textbox', { name: 'Instructions to save' }));
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
    expect(sent.promptWizard).toEqual(promptWizardAnswers.parse(STORED));
  });

  it('captures server identity and reflects it in the generated prompt', async () => {
    renderWizard();
    expect(await screen.findByRole('textbox', { name: 'Club or server name' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'A club' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Bot name' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Personality in one line' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Club or server name' }), {
      target: { value: 'Maker House' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), {
      target: { value: 'Milo' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Personality in one line' }), {
      target: { value: 'warm and concise' },
    });
    for (let i = 0; i < 6; i += 1) await next();
    const prompt = textAreaOf(await screen.findByRole('textbox', { name: 'Instructions to save' }));
    expect(prompt.value).toContain('Maker House');
    expect(prompt.value).toContain('Milo');
    expect(prompt.value).toContain('warm and concise');
  });

  it('uses the friends personality default and supports the casual tone', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('radio', { name: 'A group of friends' }));
    expect(
      inputOf(screen.getByRole('textbox', { name: 'Personality in one line' })).placeholder,
    ).toBe(DEFAULT_PERSONALITY.friends);
    await next();
    await next();
    expect(screen.getByRole('radio', { name: 'Casual, like chatting with friends' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Casual, like chatting with friends' }));
    for (let i = 0; i < 4; i += 1) await next();
    const prompt = textAreaOf(await screen.findByRole('textbox', { name: 'Instructions to save' }));
    expect(prompt.value).toContain(DEFAULT_PERSONALITY.friends);
    expect(prompt.value).toContain('np!');
  });

  it('adds, replaces, caps and removes glossary terms and previews channel guidance', async () => {
    renderWizard();
    for (let i = 0; i < 4; i += 1) await next();
    fireEvent.change(screen.getByRole('textbox', { name: 'What the main channels are for' }), {
      target: { value: '#help is for questions' },
    });
    const term = screen.getByRole('textbox', { name: 'Term' });
    const meaning = screen.getByRole('textbox', { name: 'Meaning' });
    fireEvent.change(term, { target: { value: 'AGM' } });
    fireEvent.change(meaning, { target: { value: 'annual general meeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('AGM — annual general meeting')).toBeTruthy();
    fireEvent.change(term, { target: { value: 'AGM' } });
    fireEvent.change(meaning, { target: { value: 'updated meeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('AGM — updated meeting')).toBeTruthy();
    expect(screen.queryByText('AGM — annual general meeting')).toBeNull();
    for (let i = 0; i < 9; i += 1) {
      fireEvent.change(term, { target: { value: `term-${i}` } });
      fireEvent.change(meaning, { target: { value: `meaning-${i}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
    }
    expect(buttonOf(screen.getByRole('button', { name: 'Add term' })).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove AGM' }));
    expect(screen.queryByText('AGM — updated meeting')).toBeNull();
    for (let i = 0; i < 2; i += 1) await next();
    const prompt = textAreaOf(await screen.findByRole('textbox', { name: 'Instructions to save' }));
    expect(prompt.value).toContain('CHANNELS\n#help is for questions');
    expect(prompt.value).toContain('GLOSSARY');
  });

  it('loads an old stored prompt wizard without the new fields', async () => {
    renderWizard([{ ...CLUB, promptWizard: STORED }]);
    expect(await screen.findByRole('textbox', { name: 'Club or server name' })).toBeTruthy();
    expect(inputOf(screen.getByRole('textbox', { name: 'Club or server name' })).value).toBe('');
  });

  it('does not show a Sources-line checkbox in Format', async () => {
    renderWizard();
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'End with a Sources line' })).toBeNull();
  });

  it('shows the changed-elsewhere flow on a 409 instead of losing the draft', async () => {
    renderWizard([CLUB, IT], { status: 409, body: { error: 'prompt-version-conflict' } });
    for (let i = 0; i < 6; i += 1) await next();
    fireEvent.click(await screen.findByRole('button', { name: 'Save instructions' }));
    expect(await screen.findByText('Prompt changed elsewhere')).toBeTruthy();
  });

  it('counts the trimmed prompt and disables Save for a whitespace-only draft', async () => {
    renderWizard();
    for (let i = 0; i < 6; i += 1) await next();
    const prompt = await screen.findByRole('textbox', {
      name: 'Instructions to save',
    });
    fireEvent.change(prompt, { target: { value: '   ' } });
    expect(screen.getByText('0 / 4,000 characters')).toBeTruthy();
    expect(buttonOf(screen.getByRole('button', { name: 'Save instructions' })).disabled).toBe(true);
  });

  it('tries the behaviour from the Review step and links to history', async () => {
    const mock = stubFetch([
      {
        url: '/api/assistant',
        body: { behaviours: [CLUB, IT], resources: [], skills: [], activity: [] },
      },
      { url: '/api/assistant/safety-suffix', body: SUFFIX },
      {
        method: 'POST',
        url: '/api/assistant/behaviours/club/try',
        body: { answer: 'Wizard tried.', traceId: 'try_9', conversationId: 'try_c9' },
      },
    ]);
    const { hook } = memoryLocation({ path: '/assistant/behaviours/club/wizard' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/assistant/behaviours/:id/wizard" component={AssistantPromptWizardPage} />
      </Router>,
    );
    for (let i = 0; i < 6; i += 1) await next();
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Try it question' }), {
      target: { value: 'does it work?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByText('Wizard tried.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View details' }).getAttribute('href')).toBe(
      '/assistant/history/try_9',
    );
    const call = mock.mock.calls.find((c) => c[0] === '/api/assistant/behaviours/club/try');
    expect(bodyOf(call!)).toEqual({ question: 'does it work?' });
  });
});
