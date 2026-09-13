// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReauthDialog } from './ReauthDialog.js';

afterEach(cleanup);

describe('ReauthDialog', () => {
  it('submitting calls onSubmit with the typed password and the input is empty afterwards', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ReauthDialog open onSubmit={onSubmit} onCancel={onCancel} />);
    const input = screen.getByLabelText('Password');
    fireEvent.change(input, { target: { value: 'hunter22hunter22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hunter22hunter22');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('cancelling clears the password so reopening shows an empty input', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<ReauthDialog open onSubmit={onSubmit} onCancel={onCancel} />);
    const input = screen.getByLabelText('Password');
    fireEvent.change(input, { target: { value: 'hunter22hunter22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ReauthDialog open={false} onSubmit={onSubmit} onCancel={onCancel} />);
    rerender(<ReauthDialog open onSubmit={onSubmit} onCancel={onCancel} />);
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('escape cancels', () => {
    const onCancel = vi.fn();
    render(<ReauthDialog open onSubmit={() => undefined} onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
