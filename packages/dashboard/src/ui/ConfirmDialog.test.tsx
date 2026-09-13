// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('is a labelled dialog that states the scope and names the effect on its confirm button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Turn the kill switch on?"
        scope={<p>Stops every Discord side effect for guild 123.</p>}
        confirmLabel="Turn kill switch on"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn the kill switch on?' });
    expect(dialog.textContent).toContain('Stops every Discord side effect for guild 123.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch on' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('escape cancels', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        scope="s"
        confirmLabel="Do it"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy disables both buttons', () => {
    render(
      <ConfirmDialog
        open
        title="T"
        scope="s"
        confirmLabel="Do it"
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="T"
        scope="s"
        confirmLabel="Do it"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
