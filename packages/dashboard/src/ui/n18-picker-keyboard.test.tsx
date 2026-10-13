// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { ChannelPicker } from './ChannelPicker.js';
import { RolePicker } from './RolePicker.js';

const DIRECTORY = {
  roles: [
    { roleId: '123456789012345678', name: 'Engineering', managed: false },
    { roleId: '223456789012345678', name: 'Engineering bot', managed: true },
  ],
  channels: [
    { channelId: '333333333333333333', name: 'engineering', kind: 'text' },
    { channelId: '444444444444444444', name: 'engineering-log', kind: 'announcement' },
    { channelId: '555555555555555555', name: 'private-category', kind: 'category' },
  ],
} as const;

function Harness({
  kind,
  change,
  submit,
}: {
  readonly kind: 'role' | 'channel';
  readonly change: (value: string) => void;
  readonly submit: () => void;
}) {
  const [value, setValue] = useState('');
  const Picker = kind === 'role' ? RolePicker : ChannelPicker;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Picker
        label="Directory"
        value={value}
        onChange={(next) => {
          change(next);
          setValue(next);
        }}
      />
      <button type="submit">Add</button>
      <output data-testid="value">{value}</output>
    </form>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

for (const kind of ['role', 'channel'] as const) {
  const id = kind === 'role' ? DIRECTORY.roles[0].roleId : DIRECTORY.channels[0].channelId;
  const secondId = kind === 'role' ? DIRECTORY.roles[1].roleId : DIRECTORY.channels[1].channelId;
  const optionName = kind === 'role' ? /^@Engineering(?! bot)/ : /#engineering text/;
  const secondName = kind === 'role' ? /@Engineering bot/ : /#engineering-log/;
  describe(`${kind} directory activation`, () => {
    function setup(body: unknown = DIRECTORY, status = 200) {
      const fetch = stubFetch([{ url: `/api/guild/${kind}s`, body, status }]);
      const change = vi.fn();
      const submit = vi.fn();
      const user = userEvent.setup();
      renderWithSession(<Harness kind={kind} change={change} submit={submit} />);
      return { user, change, submit, fetch };
    }

    for (const query of ['', 'engineer']) {
      for (const key of ['{Enter}', ' '] as const) {
        it(`selects exactly once via Tab and ${key} with query ${JSON.stringify(query)}`, async () => {
          const { user, change, submit, fetch } = setup();
          await screen.findByRole('button', { name: optionName });
          await user.tab();
          const input = screen.getByRole('textbox', { name: 'Directory' });
          expect(document.activeElement).toBe(input);
          if (query !== '') await user.type(input, query);
          change.mockClear();
          await user.tab();
          const option = screen.getByRole('button', { name: optionName });
          expect(document.activeElement).toBe(option);
          await user.keyboard(key);
          expect(change.mock.calls).toEqual([[id]]);
          expect(screen.getByTestId('value').textContent).toBe(id);
          expect(input).toHaveProperty('value', kind === 'role' ? id : `#engineering (${id})`);
          expect(document.activeElement).toBe(input);
          expect(screen.queryByRole('list', { name: 'Directory choices' })).toBeNull();
          expect(submit).not.toHaveBeenCalled();
          expect(fetch.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET')).toBe(true);
          await user.tab();
          expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }));
        });
      }
    }

    it('keeps the list open between choices and returns focus after choosing the second', async () => {
      const { user, change } = setup();
      await screen.findByRole('button', { name: optionName });
      await user.tab();
      await user.type(screen.getByRole('textbox'), 'engineer');
      change.mockClear();
      await user.tab();
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: secondName }));
      await user.keyboard('{Enter}');
      expect(change.mock.calls).toEqual([[secondId]]);
      expect(document.activeElement).toBe(screen.getByRole('textbox'));
      if (kind === 'role')
        expect(screen.getByText('Selected: @Engineering bot (Discord-managed)')).toBeTruthy();
    });

    for (const pointer of ['[MouseLeft]', '[TouchA]'] as const) {
      it(`selects once on ${pointer} release, not press, without submitting`, async () => {
        const { user, change, submit } = setup();
        await screen.findByRole('button', { name: optionName });
        await user.click(screen.getByRole('textbox'));
        await user.type(screen.getByRole('textbox'), 'engineer');
        change.mockClear();
        const option = screen.getByRole('button', { name: optionName });
        const device = pointer === '[MouseLeft]' ? 'MouseLeft' : 'TouchA';
        await user.pointer({ keys: `[${device}>]`, target: option });
        expect(change).not.toHaveBeenCalled();
        await user.pointer({ keys: `[/${device}]`, target: option });
        expect(change.mock.calls).toEqual([[id]]);
        expect(document.activeElement).toBe(screen.getByRole('textbox'));
        expect(submit).not.toHaveBeenCalled();
      });
    }

    it('reopens choices by clicking the focused input after a pick', async () => {
      const { user, change } = setup();
      await user.click(await screen.findByRole('button', { name: optionName }));
      expect(document.activeElement).toBe(screen.getByRole('textbox'));
      await user.click(screen.getByRole('textbox'));
      // Role IDs narrow the role query, while selected channels offer all kinds.
      if (kind === 'role') await user.clear(screen.getByRole('textbox'));
      change.mockClear();
      await user.click(screen.getByRole('button', { name: secondName }));
      expect(change.mock.calls).toEqual([[secondId]]);
    });

    it('closes typed-query choices when tabbing out without choosing', async () => {
      const { user } = setup();
      await screen.findByRole('button', { name: optionName });
      await user.tab();
      await user.type(screen.getByRole('textbox'), 'engineer');
      await user.tab();
      await user.tab();
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }));
      expect(screen.queryByRole('list')).toBeNull();
    });

    for (const unavailable of ['empty', 'error'] as const) {
      it(`accepts a pasted unknown ID with ${unavailable} directory`, async () => {
        const { user } = setup({ [`${kind}s`]: [] }, unavailable === 'error' ? 403 : 200);
        await screen.findByText(
          unavailable === 'error'
            ? /list is unavailable/
            : kind === 'role'
              ? /No roles have reached/
              : /No channels are available/,
        );
        await user.click(screen.getByRole('textbox'));
        await user.paste('999999999999999999');
        expect(screen.getByTestId('value').textContent).toBe('999999999999999999');
        expect(screen.queryByRole('list')).toBeNull();
      });
    }
  });
}
