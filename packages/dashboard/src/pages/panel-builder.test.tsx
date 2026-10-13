// @vitest-environment jsdom
import userEvent from '@testing-library/user-event';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { PanelBuilder } from './panel-builder.js';

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

const EMOJIS = {
  emojis: [
    {
      emojiId: '123456789012345678',
      name: 'party-blob',
      animated: false,
      url: 'https://cdn.discordapp.com/emojis/123456789012345678.webp',
    },
  ],
};

const stubAll = (opts?: { lookup?: string; post?: { status: number; body: unknown } }) =>
  stubFetch([
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    { url: '/api/guild/emojis', body: EMOJIS },
    {
      url: `/api/guild/channels/333333333333333333/messages/${MESSAGE_ID}`,
      body: {
        lookup: opts?.lookup ?? 'ok',
        ...((opts?.lookup ?? 'ok') === 'ok'
          ? { message: { authorName: 'Ada', content: 'React to pick a colour!' } }
          : {}),
      },
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

const pickRole = async (label: string, id: string) => {
  const trigger = await screen.findByRole('combobox', { name: new RegExp(`^${label}`) });
  // Resource fetches settle before opening the menu.
  await vi.waitFor(() => expect(trigger).toBeTruthy());
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard('{Enter}');
  const name = id === '666666666666666666' ? 'Blue' : 'Red';
  await user.click(await screen.findByRole('option', { name }));
};

/** Open an option's emoji picker, search, and choose the named result. */
const pickEmoji = async (option: number, search: string, name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Option ${String(option)} emoji` }));
  fireEvent.change(await screen.findByLabelText('Search emoji'), { target: { value: search } });
  fireEvent.click(await screen.findByRole('button', { name }));
};

/** Pick the role-panel type and fill the minimum valid form. */
const fillPanelForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
  // Wait for the roles to load: changing the select before its options
  // render leaves the value unset.
  await screen.findByRole('combobox', { name: 'Option 1 role' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  await pickRole('Option 1 role', '666666666666666666');
  fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Blue' } });
};

/** Pick the reaction-role type and fill the minimum valid form, checking the message. */
const fillReactionForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
  await screen.findByRole('combobox', { name: 'Option 1 role' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await screen.findByText(/the bot can see that message/);
  await pickRole('Option 1 role', '666666666666666666');
  await pickEmoji(1, 'banana', 'banana');
};

// Each emoji pick mounts the whole ~1,900-emoji catalogue; jsdom is slow at that.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('PanelBuilder', () => {
  it('asks which type first, then shows that type’s form', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: /^Reaction role/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Role panel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findByRole('combobox', { name: 'Option 1 role' });
    // The reaction form asks for the existing message and no message text.
    expect(screen.getByLabelText('Message ID')).toBeTruthy();
    expect(screen.queryByLabelText('Message text')).toBeNull();
    // A reaction has no label, and option ids are numbered for you.
    expect(screen.queryByLabelText('Option 1 label')).toBeNull();
    expect(screen.queryByLabelText('Option 1 id')).toBeNull();
    expect(screen.getByRole('button', { name: 'Option 1 emoji' })).toBeTruthy();
  });

  it('role panel: keeps the label field, still without an option id box', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    await screen.findByRole('combobox', { name: 'Option 1 role' });
    expect(screen.getByLabelText('Option 1 label')).toBeTruthy();
    expect(screen.queryByLabelText('Option 1 id')).toBeNull();
  });

  it('turns spaces in the name into dashes as you type, and lowercases it', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Colour roles' } });
    expect(name).toHaveProperty('value', 'colour-roles');
    fireEvent.change(name, { target: { value: 'colour roles!' } });
    expect(name).toHaveProperty('value', 'colour-roles');
    fireEvent.change(name, { target: { value: 'a  b' } });
    expect(name).toHaveProperty('value', 'a-b');
  });

  it('numbers new options for you and never reuses a removed number', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillReactionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    // Remove the middle row (option-2); the next added row is option-4, not option-2.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    await pickRole('Option 2 role', '777777777777777777');
    await pickEmoji(2, 'red heart', 'red heart');
    // Row 3 (option-4) is left blank: an untouched row is ignored, not an error.

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();
    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    const body = bodyOf(post ?? []) as { options: { optionId: string; position: number }[] };
    expect(body.options.map((o) => [o.optionId, o.position])).toEqual([
      ['option-1', 0],
      ['option-3', 1],
    ]);
  });

  it('reaction role: previews the real message and the chosen reactions beside the form', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findByRole('combobox', { name: 'Option 1 role' });
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview.textContent).toContain('press Check');

    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText(/the bot can see that message/);
    expect(preview.textContent).toContain('Ada');
    expect(preview.textContent).toContain('React to pick a colour!');
    expect(preview.textContent).toContain('#general');

    await pickEmoji(1, 'banana', 'banana');
    const reactions = screen.getByLabelText('Reactions');
    expect(reactions.textContent).toContain('🍌');
  });

  it("offers the server's custom emoji and previews them as images", async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillReactionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Option 1 emoji' }));
    fireEvent.click(await screen.findByRole('button', { name: ':party-blob:' }));
    const reactions = screen.getByLabelText('Reactions');
    expect(reactions.querySelector('img')?.getAttribute('alt')).toBe(':party-blob:');

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/nothing is live yet/)).toBeTruthy();
    const post = mock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'POST');
    expect(bodyOf(post ?? [])).toMatchObject({
      options: [{ optionId: 'option-1', emojiKey: 'c:123456789012345678' }],
    });
  });

  it('disables the roles a panel cannot use, with the reason in the label', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    const roleTrigger = await screen.findByRole('combobox', { name: 'Option 1 role' });
    roleTrigger.focus();
    await userEvent.setup().keyboard('{Enter}');
    const github = await screen.findByRole('option', { name: /GitHub/ });
    expect(github.getAttribute('data-disabled')).not.toBeNull();
    expect(github.textContent).toContain('Discord-managed');
    const blue = screen.getByRole('option', { name: 'Blue' });
    expect(blue.getAttribute('data-disabled')).toBeNull();
  });

  it('answers client-side when nothing usable is configured yet', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    await screen.findByRole('combobox', { name: 'Option 1 role' });
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
    await pickEmoji(1, 'banana', 'banana');

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
          optionId: 'option-1',
          roleId: '666666666666666666',
          label: 'Blue',
          emojiKey: 'u:1f34c',
          position: 0,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onCreated).toHaveBeenCalledWith('colour-roles');
  });

  it('reaction role: checks the message live, then posts an adopted definition', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillReactionForm();
    // single_choice is not offered on someone else’s message.
    const behaviour = screen.getByRole('group', { name: 'Behaviour' });
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
        { optionId: 'option-1', roleId: '666666666666666666', emojiKey: 'u:1f34c', position: 0 },
      ],
    });
  });

  it('reaction role: a failed message check blocks review with a readable answer', async () => {
    stubAll({ lookup: 'message-not-found' });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
    await screen.findByRole('combobox', { name: 'Option 1 role' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const checkAlert = await screen.findByRole('alert');
    expect(checkAlert.textContent).toContain('Not found in the picked channel');

    await pickRole('Option 1 role', '666666666666666666');
    await pickEmoji(1, 'banana', 'banana');
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
    await screen.findByRole('combobox', { name: 'Option 1 role' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), {
      target: { value: '333333333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText(/the bot can see that message/);
    await pickRole('Require a role first', '777777777777777777');
    fireEvent.click(screen.getByRole('checkbox', { name: 'GitHub' }));

    await pickRole('Option 1 role', '666666666666666666');
    // No label on reactions. But no emoji yet — the form says so first.
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('Every option needs an emoji'))).toBe(
      true,
    );

    await pickEmoji(1, 'banana', 'banana');
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
        { optionId: 'option-1', roleId: '666666666666666666', emojiKey: 'u:1f34c', position: 0 },
      ],
    });
  });

  it('accepts a keycap emoji: 1\uFE0F\u20E3 normalizes to u:31-20e3 (audit B3)', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    await pickEmoji(1, 'keycap', 'keycap: 1');

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
          optionId: 'option-1',
          roleId: '666666666666666666',
          label: 'Blue',
          emojiKey: 'u:31-20e3',
          position: 0,
        },
      ],
    });
  });

  it('role panel: an emoji is optional and can be cleared', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    await pickEmoji(1, 'banana', 'banana');
    fireEvent.click(screen.getByRole('button', { name: 'Option 1 emoji' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No emoji' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('button', { name: 'Create' })).toBeTruthy();
  });
});

describe('PanelBuilder draft safety', () => {
  it('sections the draft and routes Save through review without posting', async () => {
    const mock = stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    for (const name of ['Where', 'Options', 'Behaviour', 'Limits']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Create' })).toBeTruthy();
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'colour-roles');
  });

  it('guards links and unload, and deliberately discards only the draft', async () => {
    stubAll();
    renderWithSession(
      <>
        <a href="/tasks">Tasks</a>
        <PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />
      </>,
    );
    await fillReactionForm();
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(await screen.findByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Message ID')).toHaveProperty('value', MESSAGE_ID);
    expect(screen.getByText(/the bot can see that message/)).toBeTruthy();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Message ID')).toHaveProperty('value', '');
    expect(screen.queryByText(/the bot can see that message/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    // Loaded role data is not discarded with the draft.
    expect(screen.getByLabelText('Option 1 role')).toBeTruthy();
  });

  it('focuses a linked error summary, retains input, and keeps preview after the form at narrow widths', async () => {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'kept' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const summary = (await screen.findAllByRole('alert')).find(
      (alert) => alert.querySelector('h2')?.textContent === "There's a problem",
    );
    expect(document.activeElement).toBe(summary);
    expect(summary?.querySelector('a[href^="#field-"]')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'kept');
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview.closest('aside')?.previousElementSibling?.tagName).toBe('FORM');
  });
});

describe('PanelBuilder saved and field states', () => {
  it('saved Publish only opens the saved panel and build-another clears all prior limits', async () => {
    const mock = stubAll({
      post: { status: 201, body: { ok: true, panelId: 'colour-roles', published: false } },
    });
    const onCreated = vi.fn();
    renderWithSession(<PanelBuilder onCreated={onCreated} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.change(screen.getByLabelText(/Max roles per member/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const saved = await screen.findByRole('alert');
    expect(saved.textContent).toContain('nothing is live yet');
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onCreated).toHaveBeenCalledWith('colour-roles');
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);
    expect(mock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('/publish'))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Build another' }));
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    expect(screen.getByLabelText(/Max roles per member/)).toHaveProperty('value', '');
    expect(screen.getByLabelText('Channel')).toHaveProperty('value', '');
  });

  it('maps server fields to the edit controls without losing the draft', async () => {
    stubAll({
      post: {
        status: 400,
        body: {
          error: 'bad-request',
          fields: [{ path: 'panelId', problem: 'Choose a different name.' }],
        },
      },
    });
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    await fillPanelForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    const summaryLink = await screen.findByRole('link', { name: 'Choose a different name.' });
    fireEvent.click(summaryLink);
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'colour-roles');
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows role-list failure honestly and never calls it empty', async () => {
    stubFetch([
      { url: '/api/guild/channels', body: CHANNELS },
      { url: '/api/guild/roles', status: 503, body: { error: 'offline' } },
      { url: '/api/guild/emojis', body: EMOJIS },
    ]);
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No roles are available in this server.')).toBeNull();
    expect(screen.queryByText(/can still paste role IDs/)).toBeNull();
  });
});

it('ignores an in-flight message check after Discard', async () => {
  stubAll();
  let finish: ((value: Response) => void) | undefined;
  const prior = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.endsWith(`/messages/${MESSAGE_ID}`)) {
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return prior(input, init);
    }),
  );
  renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: /^Reaction role/ }));
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
  fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: MESSAGE_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await vi.waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await act(async () => {
    finish?.(
      new Response(
        JSON.stringify({
          lookup: 'ok',
          message: { authorName: 'Ada', content: 'Old draft target' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText(/the bot can see that message/)).toBeNull();
  expect(screen.getByRole('region', { name: 'Preview' }).textContent).not.toContain(
    'Old draft target',
  );
});

it('groups simultaneous option problems at a real focus target and updates when one is fixed', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    stubAll();
    renderWithSession(<PanelBuilder onCreated={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /^Role panel/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'colour-roles' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '333333333333333333' } });
    await pickRole('Option 1 role', '666666666666666666');
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    fireEvent.change(screen.getByLabelText('Option 2 label'), { target: { value: 'Red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '#field-options');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('Every option needs a role.');
    expect(links[0]?.textContent).toContain('Every option needs a label');
    const target = document.getElementById('field-options');
    expect(target).not.toBeNull();
    fireEvent.click(links[0] as HTMLElement);
    expect(document.activeElement).toBe(target);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => typeof value === 'string' && value.includes('same key')),
      ),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const updated = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '#field-options');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.textContent).toContain('Every option needs a role.');
    expect(updated[0]?.textContent).not.toContain('Every option needs a label');
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => typeof value === 'string' && value.includes('same key')),
      ),
    ).toBe(false);
  } finally {
    consoleError.mockRestore();
  }
});
