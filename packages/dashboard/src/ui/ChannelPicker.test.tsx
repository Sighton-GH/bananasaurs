// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { ChannelPicker } from './ChannelPicker.js';

const CHANNELS = {
  channels: [
    { channelId: '333333333333333333', name: 'general', kind: 'text' },
    { channelId: '444444444444444444', name: 'mod-log', kind: 'text' },
    { channelId: '555555555555555555', name: 'announcements', kind: 'announcement' },
  ],
};

function Harness({ label = 'Enable archiving for a channel' }: { readonly label?: string }) {
  const [value, setValue] = useState('');
  return (
    <>
      <ChannelPicker label={label} value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ChannelPicker', () => {
  it('offers named channels and fills the snowflake when one is clicked', async () => {
    stubFetch([{ url: '/api/guild/channels', body: CHANNELS }]);
    renderWithSession(<Harness />);
    const option = await screen.findByRole('button', { name: /#general/ });
    fireEvent.mouseDown(option);
    expect(screen.getByTestId('value').textContent).toBe('333333333333333333');
    expect(await screen.findByText(/Selected: #general/)).toBeTruthy();
  });

  it('lists every matching channel, not a capped few', async () => {
    // The archive picker's six-option cap hid channels the bot could see
    // (owner report 2026-09-21). Twelve channels must all be offered.
    const many = {
      channels: Array.from({ length: 12 }, (_, index) => ({
        channelId: `3333333333333333${String(index).padStart(2, '0')}`,
        name: `channel-${index}`,
        kind: 'text',
      })),
    };
    stubFetch([{ url: '/api/guild/channels', body: many }]);
    renderWithSession(<Harness />);
    expect(await screen.findByRole('button', { name: /#channel-11/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /#channel-/ })).toHaveLength(12);
  });

  it('filters the options by name or id as you type', async () => {
    stubFetch([{ url: '/api/guild/channels', body: CHANNELS }]);
    renderWithSession(<Harness />);
    await screen.findByRole('button', { name: /#general/ });
    const input = screen.getByLabelText('Enable archiving for a channel');
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: 'mod' },
    });
    expect(screen.queryByRole('button', { name: /#general/ })).toBeNull();
    expect(screen.getByRole('button', { name: /#mod-log/ })).toBeTruthy();
    fireEvent.change(input, {
      target: { value: '555555' },
    });
    expect(screen.getByRole('button', { name: /#announcements/ })).toBeTruthy();
  });

  it('stays a usable id input when the list request fails', async () => {
    stubFetch([{ url: '/api/guild/channels', status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<Harness />);
    expect(await screen.findByText(/channel list is unavailable/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Enable archiving for a channel'), {
      target: { value: '999999999999999999' },
    });
    expect(screen.getByTestId('value').textContent).toBe('999999999999999999');
  });

  it('says when no channels have reached the cache yet', async () => {
    stubFetch([{ url: '/api/guild/channels', body: { channels: [] } }]);
    renderWithSession(<Harness />);
    expect(await screen.findByText(/No channels have reached the bot/)).toBeTruthy();
  });
});
