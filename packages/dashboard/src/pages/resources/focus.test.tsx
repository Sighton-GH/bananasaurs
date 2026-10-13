// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { AssistantResourcesPage } from '../assistant-resources.js';
// jsdom lacks these DOM APIs called by Radix Select.
const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
const resource = {
  id: 'handbook',
  guildId: '1540816150026518620',
  title: 'Club handbook',
  url: 'https://example.com/handbook',
  kind: 'document',
  enabled: true,
  reviewedAt: '2026-09-01T12:00:00.000Z',
};
function setup() {
  const mock = stubFetch([
    { url: '/api/assistant', body: { resources: [resource] } },
    { url: '/api/assistant/resources/freshness', body: { freshness: [] } },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  return mock;
}
it.each(['Escape', 'Cancel'])(
  'edit %s restores focus to the resource actions trigger',
  async (close) => {
    const mock = setup();
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Actions for Club handbook' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit resource' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }));
    if (close === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mock.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  },
);
it('add Cancel restores focus to Add resource', async () => {
  setup();
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Add resource' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(document.activeElement).toBe(trigger);
});

it('uses the persistent header fallback when the originating actions button is removed', async () => {
  const mock = setup();
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Actions for Club handbook' });
  await user.click(trigger);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  trigger.remove();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(document.activeElement).toBe(screen.getByLabelText('Resources header'));
  expect(mock.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
});

it('uses the header fallback after successful save reloads the originating row', async () => {
  const mock = stubFetch([
    { url: '/api/assistant', body: { resources: [resource] } },
    { url: '/api/assistant/resources/freshness', body: { freshness: [] } },
    { method: 'PUT', url: '/api/assistant/resources/handbook', body: { ok: true } },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Actions for Club handbook' }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  await user.click(screen.getByRole('button', { name: 'Save resource' }));
  await screen.findByText('Resource saved');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText('Resources header'));
  expect(
    mock.mock.calls.filter(
      (call) => call[0] === '/api/assistant/resources/handbook' && call[1]?.method === 'PUT',
    ),
  ).toHaveLength(1);
});
