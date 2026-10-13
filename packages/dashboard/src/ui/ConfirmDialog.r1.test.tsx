// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';
afterEach(cleanup);
it('optional returnFocus resolves a live target on close instead of a transient opener', async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Transient opener</button>
        <button id="stable">Stable target</button>
        <ConfirmDialog
          open={open}
          title="Archive?"
          scope="One task"
          confirmLabel="Archive"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          returnFocus={() => document.getElementById('stable')}
        />
      </>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole('button', { name: 'Transient opener' }));
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stable target' })),
  );
});
