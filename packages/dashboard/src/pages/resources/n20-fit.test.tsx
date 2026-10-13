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
const base = {
  guildId: '1540816150026518620',
  url: 'https://example.com/a-very-long-source-url-that-must-wrap',
  reviewedAt: '2026-09-01T12:00:00.000Z',
};
const resources = [
  {
    ...base,
    id: 'r-ready',
    title: 'Long A-very-long-unbroken-resource-title-ready',
    kind: 'document',
    enabled: true,
  },
  {
    ...base,
    id: 'r-off',
    title: 'Long B-very-long-unbroken-resource-title-off',
    kind: 'website',
    enabled: false,
  },
  {
    ...base,
    id: 'r-need',
    title: 'Long C-very-long-unbroken-resource-title-need',
    kind: 'note',
    enabled: true,
  },
  { ...base, id: 'org', title: 'Org', kind: 'github-org', enabled: true },
  {
    ...base,
    id: 'kid',
    title: 'Child-repo-with-a-long-name',
    kind: 'github-repo',
    enabled: true,
    parentId: 'org',
  },
];
const freshness = [
  { resourceId: 'r-ready', fetchedAt: Date.now() - 1000, chunks: 4, bytes: 2048 },
  { resourceId: 'r-need', chunks: 0, bytes: 0, lastError: 'boom' },
];
const badgeOf = (name: string) => {
  const el = screen.getAllByText(name)[0];
  if (el === undefined) throw new Error(name);
  return el;
};
async function setup(fresh = true) {
  stubFetch([
    { url: '/api/assistant', body: { resources } },
    { url: '/api/assistant/resources/freshness', body: { freshness: fresh ? freshness : [] } },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  await screen.findAllByText('Off');
}
// jsdom has no layout: these assert the wrapping contract (classes), not pixels.
// Native fit at 180 CSS px is verified separately.
it.each(['Ready', 'Off', 'Needs attention'])(
  'status badge %s wraps inside its container',
  async (name) => {
    await setup();
    const badge = await screen.findAllByText(name).then((all) => all[0]);
    expect(badge?.className).toContain('whitespace-normal');
    expect(badge?.className).toContain('min-w-0');
  },
);
it('status wrapper may shrink and the title row wraps', async () => {
  await setup();
  const status = badgeOf('Off').parentElement;
  expect(status?.className).toContain('min-w-0');
  expect(status?.className).toContain('max-w-full');
  expect(status?.parentElement?.className).toContain('flex-wrap');
});
it('cache-unavailable badge wraps', async () => {
  stubFetch([
    { url: '/api/assistant', body: { resources } },
    { url: '/api/assistant/resources/freshness', status: 500, body: {} },
  ]);
  renderWithSession(<AssistantResourcesPage />);
  const badge = (await screen.findAllByText('Cache status unavailable'))[0];
  expect(badge?.className).toContain('whitespace-normal');
});
it('source filter sits in a shrinkable grid cell and keeps every option label', async () => {
  await setup();
  const user = userEvent.setup();
  const trigger = screen.getByRole('combobox');
  expect(trigger.closest('.min-w-0')).not.toBeNull();
  await user.click(trigger);
  expect(screen.getByRole('option', { name: 'All source types' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'github repo' })).toBeTruthy();
});
it('keeps full titles, urls and the org children', async () => {
  await setup();
  expect(
    screen.getAllByText('Long A-very-long-unbroken-resource-title-ready').length,
  ).toBeGreaterThan(0);
  expect(screen.getAllByText(base.url).length).toBeGreaterThan(0);
});
