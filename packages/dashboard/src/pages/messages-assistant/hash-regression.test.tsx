// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { KeptSection, useSections } from './section-tabs.js';
const options = [
  { value: 'all', label: 'All' },
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];
let mounts = 0,
  unmounts = 0;
function Child() {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}
function Fixture() {
  const s = useSections(options);
  return s.render(
    <KeptSection hidden={s.value === 'b'}>
      <Child />
    </KeptSection>,
  );
}
afterEach(cleanup);
it('browser hook query hash Back ids and same-node persistence', async () => {
  window.history.replaceState(null, '', '/settings?tab=a&keep=one&keep=two#field-content');
  render(<Fixture />);
  const node = screen.getByLabelText('Draft');
  fireEvent.change(node, { target: { value: 'retained' } });
  const panel = screen.getByRole('tabpanel'),
    initialMounts = mounts;
  screen.getByRole('tab', { name: 'A' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.queryByRole('textbox', { name: 'Draft' })).toBeNull();
  expect(screen.getByRole('tabpanel')).toBe(panel);
  const active = screen.getByRole('tab', { name: 'B' });
  expect(active.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(active.id);
  expect(panel.getAttribute('tabindex')).toBe('0');
  expect(window.location.search).toBe('?tab=b&keep=one&keep=two');

  expect(window.location.hash).toBe('#field-content');
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
  });
  expect(window.location.hash).toBe('#field-content');
  expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByLabelText('Draft')).toBe(node);
  expect((node as HTMLInputElement).value).toBe('retained');
  expect(mounts).toBe(initialMounts);
  expect(unmounts).toBe(0);
});
