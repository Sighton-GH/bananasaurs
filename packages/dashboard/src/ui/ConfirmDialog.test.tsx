// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

  it('defaults to Cancel and only overrides the label for an explicit caller', () => {
    const props = {
      open: true,
      title: 'T',
      scope: 's',
      confirmLabel: 'Do it',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(<ConfirmDialog {...props} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    rerender(<ConfirmDialog {...props} cancelLabel="Stay" />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    rerender(<ConfirmDialog {...props} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
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
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Do it' });
    expect(cancel instanceof HTMLButtonElement && cancel.disabled).toBe(true);
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);
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

  it('renders children outside the ARIA description so an input stays focusable', () => {
    render(
      <ConfirmDialog
        open
        title="T"
        scope="s"
        confirmLabel="Do it"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        <div>
          <label htmlFor="slot-value">Value</label>
          <input id="slot-value" defaultValue="x" />
        </div>
      </ConfirmDialog>,
    );
    const input = screen.getByRole('textbox', { name: 'Value' });
    input.focus();
    expect(document.activeElement).toBe(input);
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const described = document.getElementById(describedBy ?? '');
    expect(described).not.toBeNull();
    expect(described?.contains(input)).toBe(false);
  });
});

// These contracts describe the responsive mechanism, not browser geometry.
describe('ConfirmDialog narrow containment', () => {
  it('stacks narrow actions, keeps the desktop row and lets long labels grow and wrap', () => {
    render(
      <ConfirmDialog
        open
        title="Turn the kill switch on?"
        scope="LOCAL DATA"
        confirmLabel="Turn kill switch on"
        danger
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Turn kill switch on' });
    const actions = cancel.parentElement;
    expect(actions?.classList.contains('flex-col')).toBe(true);
    expect(actions?.classList.contains('sm:flex-row')).toBe(true);
    for (const action of [cancel, confirm]) {
      for (const token of [
        'min-w-0',
        'max-w-full',
        'h-auto!',
        'min-h-9',
        'whitespace-normal!',
        '[overflow-wrap:anywhere]',
      ]) {
        expect(action.classList.contains(token), token).toBe(true);
      }
    }
    expect(confirm.classList.contains('border-tone-danger')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  });

  it('keeps input outside the description, traps Tab, activates each action once', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open repair fixture</button>
          <ConfirmDialog
            open={open}
            title="Turn the kill switch on?"
            scope="LOCAL DATA"
            confirmLabel="Turn kill switch on"
            danger
            onConfirm={() => {
              onConfirm();
              setOpen(false);
            }}
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
          >
            <label>
              Value
              <input defaultValue="x" />
            </label>
          </ConfirmDialog>
        </>
      );
    }
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Open repair fixture' });
    await user.click(opener);
    const input = screen.getByRole('textbox', { name: 'Value' });
    expect(document.activeElement).toBe(input);
    const description = document.getElementById(
      screen.getByRole('dialog').getAttribute('aria-describedby') ?? '',
    );
    expect(description?.contains(input)).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(opener);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Turn kill switch on' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Value' }));
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a long busy danger label named while disabling both callbacks', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Turn the kill switch on?"
        scope="LOCAL DATA"
        confirmLabel="Turn kill switch on"
        danger
        busy
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    for (const name of ['Cancel', 'Turn kill switch on']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
      await user.click(button);
    }
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Round 2 contracts: vertical containment below the measured sticky header
// and focus restore to the opener. Mechanism tests, not browser geometry.
describe('ConfirmDialog vertical containment and focus restore', () => {
  it('bounds the dialog to the viewport and makes it scrollable', () => {
    render(
      <ConfirmDialog
        open
        title="Clean up connections?"
        scope="CONNECTIONS"
        confirmLabel="Clean up"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('overflow-y-auto')).toBe(true);
    expect(dialog.classList.contains('max-h-[calc(100dvh-2rem)]')).toBe(true);
  });

  it('anchors below a measured sticky header instead of centering under it', () => {
    const header = document.createElement('header');
    document.body.appendChild(header);
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      bottom: 135,
      top: 0,
      left: 0,
      right: 360,
      width: 360,
      height: 135,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    render(
      <ConfirmDialog
        open
        title="Turn the kill switch on?"
        scope="LOCAL DATA"
        confirmLabel="Turn kill switch on"
        danger
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('top-1/2')).toBe(false);
    expect(dialog.style.top).toBe('143px');
    expect(dialog.style.maxHeight).toBe('calc(100dvh - 151px)');
    header.remove();
  });

  it('restores focus to the opener on Cancel, Confirm, Escape and backdrop', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open focus fixture</button>
          <ConfirmDialog
            open={open}
            title="Turn the kill switch on?"
            scope="LOCAL DATA"
            confirmLabel="Turn kill switch on"
            danger
            onConfirm={() => {
              onConfirm();
              setOpen(false);
            }}
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Open focus fixture' });

    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Turn kill switch on' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    const overlay = document.querySelector('[class*="bg-canvas/70"]');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('stays safe on a programmatic open with nothing focused', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open={false}
        title="Clean up connections?"
        scope="CONNECTIONS"
        confirmLabel="Clean up"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    // Programmatic open: nothing focused but <body>; close must not throw.
    rerender(
      <ConfirmDialog
        open
        title="Clean up connections?"
        scope="CONNECTIONS"
        confirmLabel="Clean up"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The parent closes the controlled dialog in response, as callers do.
    rerender(
      <ConfirmDialog
        open={false}
        title="Clean up connections?"
        scope="CONNECTIONS"
        confirmLabel="Clean up"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skips refocusing an opener detached after capture', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    let detach: () => void = () => undefined;
    // The opener stays mounted through the open (so onOpenAutoFocus captures
    // it connected) and is removed via React state while the dialog is open.
    function DetachedFixture() {
      const [open, setOpen] = useState(false);
      const [visible, setVisible] = useState(true);
      detach = () => setVisible(false);
      return (
        <>
          {visible ? <button onClick={() => setOpen(true)}>Open detachable</button> : null}
          <ConfirmDialog
            open={open}
            title="Clean up connections?"
            scope="CONNECTIONS"
            confirmLabel="Clean up"
            onConfirm={() => undefined}
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<DetachedFixture />);
    const opener = screen.getByRole('button', { name: 'Open detachable' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).not.toBeNull();
    const focus = vi.spyOn(opener, 'focus');
    act(() => detach());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Radix runs the close auto-focus after the content unmounts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  });
});

it('stacked narrow actions inherit width stretch and keep keyboard cancel/confirm behaviour', async () => {
  const cancel = vi.fn();
  const confirm = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Stacked actions"
      scope="Nothing changes in this test."
      confirmLabel="Apply change"
      onCancel={cancel}
      onConfirm={confirm}
    />,
  );
  const cancelButton = screen.getByRole('button', { name: 'Cancel' });
  const confirmButton = screen.getByRole('button', { name: 'Apply change' });
  expect(cancelButton.parentElement).toBe(confirmButton.parentElement);
  expect(cancelButton.parentElement?.classList.contains('flex-col')).toBe(true);
  expect(cancelButton.parentElement?.classList.contains('sm:flex-row')).toBe(true);
  for (const button of [cancelButton, confirmButton]) {
    expect(button.className.split(' ').filter((token) => token.startsWith('self-'))).toEqual([]);
    expect(button.classList.contains('h-auto!')).toBe(true);
    expect(button.classList.contains('whitespace-normal!')).toBe(true);
  }
  const user = userEvent.setup();
  cancelButton.focus();
  await user.keyboard('{Enter}');
  expect(cancel).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(document.activeElement).toBe(confirmButton);
  await user.keyboard('{Enter}');
  expect(confirm).toHaveBeenCalledTimes(1);
});
