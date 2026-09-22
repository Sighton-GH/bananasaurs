// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PanelBuilder } from './panel-builder.js';

/**
 * The self-granted roles builder (ADRs 0053 and 0054, Bryan's roles lane).
 * The properties under test: the first question is the type (reaction role
 * vs role panel), the reaction-role path attaches to an existing message by
 * id with a live check before review, the role picker honestly flags the
 * roles a panel cannot use, the review step is the definition the server
 * will receive, and the server's refusals come back as readable answers
 * with the draft intact.
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
      manageable: true,
      allowlisted: false,
      optionable: true,
    },
    {
      roleId: '777777777777777777',
      name: 'Red',
      colour: 0xe74c3c,
      position: 2,
      managed: false,
      manageable: true,
      allowlisted: false,
      optionable: true,
    },
    {
      roleId: '888888888888888888',
      name: 'GitHub',
      colour: 0,
      position: 9,
      managed: true,
      manageable: false,
      allowlisted: false,
      optionable: false,
    },
  ],
};

const MESSAGE_ID = '424242424242424242';

const stubAll = (opts?: { lookup?: string; post?: { status: number; body: unknown } }) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    {
      url: `/api/guild/channels/333333333333333333/messages/${MESSAGE_ID}`,
      body: { lookup: opts?.lookup ?? 'ok' },
    },
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

/** Pick the role-panel type and fill the minimum valid form. */
const fillPanelForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
  // Wait for the roles to load: changing the select before its options
  // render leaves the value unset.
  await screen.findAllByRole('option', { name: 'Blue' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
  fireEvent.change(screen.getByLabelText('Option 1 role'), {
    target: { value: '666666666666666666' },
  });
  fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Blue' } });
};

/** Pick the reaction-role type and fill the minimum valid form, checking the message. */
const fillReactionForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
  await screen.findAllByRole('option', { name: 'Blue' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await screen.findByText(/the bot can see that message/);
  fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
  fireEvent.change(screen.getByLabelText('Option 1 role'), {
    target: { value: '666666666666666666' },
  });
  fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: '🍌' } });
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('PanelBuilder', () => {
  it('asks which type first, then shows that type’s form', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: /^Reaction role/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Role panel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findAllByRole('option', { name: 'Blue' });
    // The reaction form asks for the existing message and no message text.
    expect(screen.getByLabelText('Message ID')).toBeTruthy();
    expect(screen.queryByLabelText('Message text')).toBeNull();
  });

  it('disables the roles a panel cannot use, with the reason in the label', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    await screen.findAllByRole('option', { name: 'Blue' });
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

  it('panel: walks configure, review and create; the posted body is the assembled definition', async () => {
    const mock = stubAll({
      post: {
        status: 201,
        body: {
          ok: true,
          panelId: 'colour-roles',
          published: false,
          newlyAllowlistedRoleIds: ['666666666666666666'],
        },
      },
    });
    const onCreated = vi.fn();
    renderWithSession(<PanelBuilder onCreated={onCreated} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: '🍌' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('colour-roles')).toBeTruthy();
    expect(screen.getByText(/Creating will add these roles/).textContent).toContain(
      'Blue (666666666666666666)',
    );
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

  it('reaction role: checks the message live, then posts an adopted definition', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillReactionForm();
    // single_choice is not offered on someone else’s message.
    const behaviour = screen.getByLabelText('Behaviour');
    expect(behaviour.textContent).not.toContain('Single choice');

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(new RegExp(`the existing message ${MESSAGE_ID}`))).toBeTruthy();
    expect(screen.getByText('Emoji reactions on that message')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();

    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toEqual({
      panelId: 'colour-roles',
      kind: 'adopted',
      channelId: '333333333333333333',
      behaviour: 'toggle',
      component: 'reaction',
      messageId: MESSAGE_ID,
      blockedRoleIds: [],
      options: [
        { optionId: 'blue', roleId: '666666666666666666', emojiKey: 'u:1f34c', position: 0 },
      ],
    });
  });

  it('reaction role: a failed message check blocks review with a readable answer', async () => {
    stubAll({ lookup: 'message-not-found' });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findAllByRole('option', { name: 'Blue' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const checkAlert = await screen.findByRole('alert');
    expect(checkAlert.textContent).toContain('Not found in the picked channel');

    fireEvent.change(screen.getByLabelText('Option 1 id'), { target: { value: 'blue' } });
    fireEvent.change(screen.getByLabelText('Option 1 role'), {
      target: { value: '666666666666666666' },
    });
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: '🍌' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('run the check again'))).toBe(true);
    // Still on the configure step.
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it("shows the server's unmanageable-role answer and keeps the draft", async () => {
    stubAll({
      post: { status: 400, body: { error: 'unmanageable-role', roleIds: ['666666666666666666'] } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('cannot manage these roles in Discord: Blue');
    // The draft survived: going back shows the filled form.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'colour-roles');
  });

  it('shows the already-exists answer for a duplicate id', async () => {
    stubAll({ post: { status: 409, body: { error: 'already-exists' } } });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already taken');
  });

  it('reaction role: emoji required per option, label optional, gates sent', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findAllByRole('option', { name: 'Blue' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText(/the bot can see that message/);
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
    expect(await screen.findByText(/only members with the Red role/)).toBeTruthy();
    expect(screen.getByText(/blocked: GitHub/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();

    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toEqual({
      panelId: 'colour-roles',
      kind: 'adopted',
      channelId: '333333333333333333',
      behaviour: 'toggle',
      component: 'reaction',
      messageId: MESSAGE_ID,
      requiredRoleId: '777777777777777777',
      blockedRoleIds: ['888888888888888888'],
      options: [
        { optionId: 'blue', roleId: '666666666666666666', emojiKey: 'u:1f34c', position: 0 },
      ],
    });
  });

  it('accepts a keycap emoji: 1\uFE0F\u20E3 normalizes to u:31-20e3 (audit B3)', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
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
      component: 'button',
      blockedRoleIds: [],
      options: [
        {
          optionId: 'blue',
          roleId: '666666666666666666',
          label: 'Blue',
          emojiKey: 'u:31-20e3',
          position: 0,
        },
      ],
    });
  });

  it('still rejects plain ASCII text as an emoji', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.change(screen.getByLabelText('Option 1 emoji'), { target: { value: 'banana' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('emoji');
  });
});
