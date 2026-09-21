// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrintOnceDialog } from './PrintOnceDialog.js';

afterEach(cleanup);

describe('PrintOnceDialog', () => {
  it('shows the secret and says it is shown once', () => {
    render(
      <PrintOnceDialog
        open
        title="Password reset"
        secretLabel="New password for bryan"
        secret="s3cret-once"
        onDone={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Password reset' });
    expect(dialog.textContent).toContain('s3cret-once');
    expect(dialog.textContent).toContain('Shown once');
    expect(dialog.textContent).toContain('New password for bryan');
  });

  it('escape does not dismiss it — the only way out is the done button', () => {
    const onDone = vi.fn();
    render(
      <PrintOnceDialog
        open
        title="Password reset"
        secretLabel="New password"
        secret="s3cret-once"
        onDone={onDone}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('copy writes the secret to the clipboard when the API is available', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <PrintOnceDialog
        open
        title="Password reset"
        secretLabel="New password"
        secret="s3cret-once"
        onDone={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('s3cret-once');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
