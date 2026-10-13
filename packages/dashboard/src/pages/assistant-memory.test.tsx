// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch, bodyOf } from '../test-support.js';
import { AssistantMemoryPage } from './assistant-memory.js';
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
const DATA = {
  serverCard: 'Club facts',
  memories: [{ id: 'm1', section: 'Goals', content: 'Old goal', subjectId: 'u1' }],
  members: [],
};
describe('Memory recipe', () => {
  it('labels the server card editor', async () => {
    stubFetch([{ url: '/api/assistant', body: DATA }]);
    renderWithSession(<AssistantMemoryPage />);
    expect(await screen.findByRole('textbox', { name: 'Server card' })).toBeTruthy();
  });
  it('keeps an edited memory open and does not claim success on a refused save', async () => {
    const mock = stubFetch([
      { url: '/api/assistant', body: DATA },
      {
        method: 'PUT',
        url: '/api/assistant/memories/m1',
        status: 500,
        body: { error: 'unavailable' },
      },
    ]);
    renderWithSession(<AssistantMemoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Memory'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(mock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PUT')).toBe(true),
    );
    await screen.findByRole('alert');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Memory').value).toBe('Keep my draft');
    expect(screen.queryByText('Memory saved')).toBeNull();
    const call = mock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PUT');
    expect(bodyOf(call!)).toEqual({
      id: 'm1',
      section: 'Goals',
      content: 'Keep my draft',
      subjectId: 'u1',
    });
  });
  it('keeps empty memory distinct from unavailable', async () => {
    stubFetch([{ url: '/api/assistant', status: 500, body: { error: 'unavailable' } }]);
    renderWithSession(<AssistantMemoryPage />);
    expect(await screen.findByText(/Couldn't load assistant memory/)).toBeTruthy();
    expect(screen.queryByText('No memory yet')).toBeNull();
  });
});

it('maps schema errors to the edited memory and focuses a summary without losing input', async () => {
  stubFetch([
    { url: '/api/assistant', body: DATA },
    {
      method: 'PUT',
      url: '/api/assistant/memories/m1',
      status: 400,
      body: {
        error: 'bad-request',
        fields: [{ path: 'content', problem: 'Enter a shorter memory.' }],
      },
    },
  ]);
  renderWithSession(<AssistantMemoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Memory'), { target: { value: 'Draft fact' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const link = await screen.findByRole('link', { name: 'Enter a shorter memory.' });
  expect(link.getAttribute('href')).toBe('#field-content');
  expect(screen.getByLabelText<HTMLInputElement>('Memory').value).toBe('Draft fact');
  await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('alert'));
});
