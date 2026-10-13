// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';

// Server rendering has no document or window; the measured header inset and
// focus capture must stay inert until hydration.
it('renders without document or window (SSR)', () => {
  for (const open of [false, true]) {
    expect(() =>
      renderToString(
        <ConfirmDialog
          open={open}
          title="T"
          scope="S"
          confirmLabel="C"
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    ).not.toThrow();
  }
});
