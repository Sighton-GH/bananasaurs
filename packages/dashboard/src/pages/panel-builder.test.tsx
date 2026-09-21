// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PanelBuilder } from './panel-builder.js';

/**
 * The role-assignment builder (ADRs 0053 and 0054). The properties under
 * test: the role picker honestly flags the roles a panel cannot use, the
 * client catches what it can before the server has to, the review step is
 * the definition the server will receive, the server's refusals come back
 * as readable answers with the draft intact, and the reaction-role format
 * (the default) needs an emoji per option, not a label.
 */

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
      optionable: true,
    },
    {
      roleId: '777777777777777777',
      name: 'Red',
      colour: 0xe74c3c,
      position: 2,
      managed: false,
      optionable: true,
    },
    {
      roleId: '888888888888888888',
      name: 'GitHub',
      colour: 0,
      position: 9,
      managed: true,
      optionable: false,
    },
  ],
};

const stubAll = (post?: { status: number; body: unknown }) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    ...(post !== undefined
      ? [{ url: '/api/panels', method: 'POST' as const, status: post.status, body: post.body }]
      : []),
  ]);

/** Fill the minimum valid form in the buttons format: name, channel, one option. */
const fillForm = async () => {
  // Wait for the roles to load: changing the select before its options
  // render leaves the value unset.
  await screen.findAllByRole('option', { name: 'Blue' });
  // Buttons, not the default reactions format: a labelled-option path.
  fireEvent.change(screen.getByLabelText('How members pick'), { target: { value: 'button' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
  fireEvent.change(screen.getByLabelText('Option 1 role'), {
    target: { value: '666666666666666666' },
  });
  fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Blue' } });
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('PanelBuilder', () => {
  it('disables the roles a panel cannot use, with the reason in the label', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    const select = await screen.findByLabelText('Option 1 role');
    const github = [...select.querySelectorAll('option')].find((o) =>
      o.textContent?.includes('GitHub'),
    );
    expect(github?.disabled).toBe(true);
    expect(github?.textContent).toContain('Discord-managed');
    const blue = [...select.querySelectorAll('option')].find((o) => o.textContent === 'Blue');
    expect(blue?.disabled).toBe(false);
  });

  it('answers client-side when nothing usable is configured yet', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Add at least one option');
    // Still on the configure step.
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('walks configure, review and create; the posted body is the assembled definition', async () => {
    const mock = stubAll({
      status: 201,
      body: { ok: true, panelId: 'colour-roles', published: false },
    });
    const onCreated = vi.fn();
    renderWithSession(<PanelBuilder onCreated={onCreated} onCancel={() => undefined} />);
    await fillForm();
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: '🍌' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    // The review step shows what will be sent.
    expect(await screen.findByText('colour-roles')).toBeTruthy();
    expect(screen.getByText('Toggle')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();

    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toEqual({
      panelId: 'colour-roles',
      kind: 'managed',
      channelId: '333333333333333333',
      behaviour: 'toggle',
      component: 'button',
      blockedRoleIds: [],
      options: [
        {
          optionId: 'blue',
          roleId: '666666666666666666',
          label: 'Blue',
          emojiKey: 'u:1f34c',
          position: 0,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(onCreated).toHaveBeenCalledWith('colour-roles');
  });

  it("shows the server's unmanaged-role answer and keeps the draft", async () => {
    stubAll({
      status: 400,
      body: { error: 'unmanaged-role', roleIds: ['666666666666666666'] },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not managed by Bananasaurs: 666666666666666666');
    // The draft survived: going back shows the filled form.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'colour-roles');
  });

  it('shows the already-exists answer for a duplicate id', async () => {
    stubAll({ status: 409, body: { error: 'already-exists' } });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already taken');
  });

  it('defaults to emoji reactions: emoji required, label optional, content and gates sent', async () => {
    const mock = stubAll({
      status: 201,
      body: { ok: true, panelId: 'colour-roles', published: false },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await screen.findAllByRole('option', { name: 'Blue' });

    // The default format is reactions.
    expect(screen.getByLabelText('How members pick')).toHaveProperty('value', 'reaction');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message text'), {
      target: { value: 'Pick your colour below!' },
    });
    fireEvent.change(screen.getByLabelText('Require a role first'), {
      target: { value: '777777777777777777' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'GitHub' }));

    fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
    fireEvent.change(screen.getByLabelText('Option 1 role'), {
      target: { value: '666666666666666666' },
    });
    // No label: fine on reactions. But no emoji yet — the form says so first.
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Every option needs an emoji');

    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: '🍌' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    // The review shows the message text and the format in plain words.
    expect(await screen.findByText('Pick your colour below!')).toBeTruthy();
    expect(screen.getByText('Emoji reactions')).toBeTruthy();
    expect(screen.getByText(/only members with the Red role/)).toBeTruthy();
    expect(screen.getByText(/blocked: GitHub/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();

    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toEqual({
      panelId: 'colour-roles',
      kind: 'managed',
      channelId: '333333333333333333',
      behaviour: 'toggle',
      component: 'reaction',
      content: 'Pick your colour below!',
      requiredRoleId: '777777777777777777',
      blockedRoleIds: ['888888888888888888'],
      options: [
        { optionId: 'blue', roleId: '666666666666666666', emojiKey: 'u:1f34c', position: 0 },
      ],
    });
  });

  it('accepts a keycap emoji: 1\uFE0F\u20E3 normalizes to u:31-20e3 (audit B3)', async () => {
    const mock = stubAll({
      status: 201,
      body: { ok: true, panelId: 'colour-roles', published: false },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await screen.findAllByRole('option', { name: 'Blue' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
    fireEvent.change(screen.getByLabelText('Option 1 role'), {
      target: { value: '666666666666666666' },
    });
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), {
      target: { value: '1\uFE0F\u20E3' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();

    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toEqual({
      panelId: 'colour-roles',
      kind: 'managed',
      channelId: '333333333333333333',
      behaviour: 'toggle',
      component: 'reaction',
      blockedRoleIds: [],
      options: [
        { optionId: 'blue', roleId: '666666666666666666', emojiKey: 'u:31-20e3', position: 0 },
      ],
    });
  });

  it('still rejects plain ASCII text as an emoji', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await screen.findAllByRole('option', { name: 'Blue' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
    fireEvent.change(screen.getByLabelText('Option 1 role'), {
      target: { value: '666666666666666666' },
    });
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: 'banana' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('emoji');
  });
});
