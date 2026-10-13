// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../../test-support.js';
import { PanelBuilder } from './index.js';

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

const CHANNELS = {
  channels: [{ channelId: '333333333333333333', name: 'general', kind: 'text' }],
};

const ROLES = {
  roles: [
    {
      roleId: '666666666666666666',
      name: 'Blue',
      colour: 0x3498db,
      position: 3,
      managed: false,
      manageable: true,
      allowlisted: false,
      optionable: true,
    },
  ],
};

const EMOJIS = { emojis: [] };

const stubAll = (opts?: { post?: { status: number; body: unknown } }) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    { url: '/api/guild/emojis', body: EMOJIS },
    ...(opts?.post !== undefined
      ? [
          {
            url: '/api/panels',
            method: 'POST' as const,
            status: opts.post.status,
            body: opts.post.body,
          },
        ]
      : []),
  ]);

const pickRole = async (label: string, name: string) => {
  const trigger = await screen.findByRole('combobox', { name: new RegExp(`^${label}`) });
  await vi.waitFor(() => expect(trigger).toBeTruthy());
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name }));
};

/** Pick the role-panel type and fill the minimum valid form. */
const fillPanelForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
  await screen.findByRole('combobox', { name: 'Option 1 role' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  await pickRole('Option 1 role', 'Blue');
  fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Blue' } });
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('panel builder step focus (d3 L02)', () => {
  it('does not move focus on first mount', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await screen.findByRole('button', { name: /^Role panel/ });
    expect(document.activeElement).toBe(document.body);
  });

  it('advancing to review focuses the new step heading', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Review before creating',
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('going back to edit focuses the edit heading', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByRole('heading', { level: 1, name: 'Review before creating' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'New role panel' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('creating focuses the saved heading', async () => {
    stubAll({
      post: {
        status: 201,
        body: { ok: true, panelId: 'colour-roles', published: false },
      },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const heading = await screen.findByRole('heading', { name: 'Saved' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });
});
