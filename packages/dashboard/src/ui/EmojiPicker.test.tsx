// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker.js';

const CUSTOM = [
  {
    emojiId: '123456789012345678',
    name: 'party-blob',
    animated: false,
    url: 'https://cdn.discordapp.com/emojis/123456789012345678.webp',
  },
];

function Harness({ clearable = false }: { readonly clearable?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <>
      <EmojiPicker
        label="Option 1 emoji"
        value={value}
        onChange={setValue}
        customEmojis={CUSTOM}
        clearable={clearable}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

// Opening the picker mounts the whole ~1,900-emoji catalogue; jsdom is slow at that.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Option 1 emoji' }));

describe('EmojiPicker', () => {
  it('searches the whole Unicode set by name and returns the chosen emoji', async () => {
    render(<Harness />);
    open();
    fireEvent.change(await screen.findByLabelText('Search emoji'), { target: { value: 'banana' } });
    fireEvent.click(await screen.findByRole('button', { name: 'banana' }));
    expect(screen.getByTestId('value').textContent).toBe('🍌');
    // Choosing closes the picker.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reaches emoji a trimmed list would lack: flags and keycaps', async () => {
    render(<Harness />);
    open();
    fireEvent.change(await screen.findByLabelText('Search emoji'), { target: { value: 'canada' } });
    expect(await screen.findByRole('button', { name: 'flag: Canada' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'keycap' } });
    fireEvent.click(await screen.findByRole('button', { name: 'keycap: 1' }));
    expect(screen.getByTestId('value').textContent).toBe('1️⃣');
  });

  it('applies the chosen skin tone to emoji that have one', async () => {
    render(<Harness />);
    open();
    fireEvent.change(await screen.findByLabelText('Search emoji'), { target: { value: 'waving' } });
    await screen.findByRole('button', { name: 'waving hand' });
    fireEvent.change(screen.getByLabelText('Skin tone'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'waving hand' }));
    expect(screen.getByTestId('value').textContent).toBe('👋🏿');
  });

  it("offers the server's custom emoji and returns the snowflake", async () => {
    render(<Harness />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: ':party-blob:' }));
    expect(screen.getByTestId('value').textContent).toBe('123456789012345678');
    // The trigger now shows the custom emoji's image.
    expect(screen.getByRole('img', { name: ':party-blob:' })).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    render(<Harness />);
    open();
    fireEvent.change(await screen.findByLabelText('Search emoji'), {
      target: { value: 'zzzznotanemoji' },
    });
    expect(await screen.findByText(/No emoji match/)).toBeTruthy();
  });

  it('closes on Escape without choosing, and can clear when optional', async () => {
    render(<Harness clearable />);
    open();
    await screen.findByLabelText('Search emoji');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('');

    open();
    fireEvent.change(await screen.findByLabelText('Search emoji'), { target: { value: 'banana' } });
    fireEvent.click(await screen.findByRole('button', { name: 'banana' }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'No emoji' }));
    expect(screen.getByTestId('value').textContent).toBe('');
  });
});
