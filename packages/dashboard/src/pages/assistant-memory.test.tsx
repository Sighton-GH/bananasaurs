// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AssistantMemoryPage } from './assistant-memory.js';

const MEMORY = { members: [], serverCard: 'card', memories: [] };
const tuningSettings = (values: Record<string, unknown>) => ({
  url: '/api/assistant/tuning',
  body: {
    settings: Object.entries(values).map(([key, value]) => ({
      key,
      group: 'Assistant context',
      label: key,
      help: 'help',
      display: 'count',
      value,
      defaultValue: value,
      isDefault: true,
    })),
  },
});
const DIGEST_VALUES = {
  'assistant.digestEnabled': 1,
  'assistant.digestHour': 4,
  'assistant.digestInputChars': 40000,
  'assistant.digestMaxProposals': 10,
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantMemoryPage digest controls (spec §4.7)', () => {
  it('renders the digest controls with current values', async () => {
    stubFetch([{ url: '/api/assistant', body: MEMORY }, tuningSettings(DIGEST_VALUES)]);
    renderWithSession(<AssistantMemoryPage />);
    expect(await screen.findByRole('heading', { name: 'Daily digest' })).toBeTruthy();
    expect(
      (await screen.findByLabelText<HTMLInputElement>('Digest on or off (1 or 0)')).value,
    ).toBe('1');
  });
  it('saves the digest hour', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: MEMORY },
      tuningSettings(DIGEST_VALUES),
      {
        method: 'PUT',
        url: '/api/assistant/tuning/assistant.digestHour',
        body: { setting: { key: 'assistant.digestHour', value: 5 } },
      },
    ]);
    renderWithSession(<AssistantMemoryPage />);
    const input = await screen.findByLabelText<HTMLInputElement>('Digest hour (local time)');
    await act(async () => {
      fireEvent.change(input, { target: { value: '5' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save digest settings' }));
    });
    const call = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/assistant/tuning/assistant.digestHour' &&
        (c[1] as RequestInit)?.method === 'PUT',
    );
    expect(call).toBeTruthy();
    expect(bodyOf(call!)).toEqual({ value: 5 });
  });
});

it('sends no writes for unchanged, blank or non-integer values', async () => {
  const mock = stubFetch([{ url: '/api/assistant', body: MEMORY }, tuningSettings(DIGEST_VALUES)]);
  renderWithSession(<AssistantMemoryPage />);
  const hour = await screen.findByLabelText('Digest hour (local time)');
  fireEvent.change(hour, { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Digest max proposals'), { target: { value: '1.5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save digest settings' }));
  });
  expect(mock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PUT')).toHaveLength(0);
});

it('stops on a failed write without a success toast and reloads partial changes', async () => {
  const mock = stubFetch([
    { url: '/api/assistant', body: MEMORY },
    tuningSettings(DIGEST_VALUES),
    {
      method: 'PUT',
      url: '/api/assistant/tuning/assistant.digestEnabled',
      body: { setting: { key: 'assistant.digestEnabled', value: 0 } },
    },
    {
      method: 'PUT',
      url: '/api/assistant/tuning/assistant.digestHour',
      status: 500,
      body: { error: 'internal-error' },
    },
  ]);
  const fallback = mock.getMockImplementation()!;
  let enabledSaved = false;
  mock.mockImplementation((input, init) => {
    if (input === '/api/assistant/tuning/assistant.digestEnabled' && init?.method === 'PUT')
      enabledSaved = true;
    if (input === '/api/assistant/tuning' && enabledSaved)
      return Promise.resolve(
        new Response(
          JSON.stringify(tuningSettings({ ...DIGEST_VALUES, 'assistant.digestEnabled': 0 }).body),
        ),
      );
    return fallback(input, init);
  });
  renderWithSession(<AssistantMemoryPage />);
  fireEvent.change(await screen.findByLabelText('Digest on or off (1 or 0)'), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByLabelText('Digest hour (local time)'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Digest max proposals'), { target: { value: '9' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save digest settings' }));
  });
  expect(screen.queryByText('Saved digest settings.')).toBeNull();
  expect(mock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PUT')).toHaveLength(2);
  expect((await screen.findByLabelText<HTMLInputElement>('Digest on or off (1 or 0)')).value).toBe(
    '0',
  );
  expect(screen.getByLabelText<HTMLInputElement>('Digest hour (local time)').value).toBe('4');
});
