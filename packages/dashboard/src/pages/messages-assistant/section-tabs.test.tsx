import userEvent from '@testing-library/user-event';
// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useState } from 'react';
import { renderWithSession } from '../../test-support.js';
import { KeptSection, useSections } from './section-tabs.js';
const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];
function Fixture() {
  const sections = useSections(OPTIONS);
  const [draft, setDraft] = useState('');
  return sections.render(
    <>
      <KeptSection hidden={sections.value === 'b'}>
        <input
          aria-label="Draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </KeptSection>
    </>,
  );
}
afterEach(cleanup);
it('honours a deep link, preserves unrelated query fields, and retains drafts across section changes', async () => {
  const location = memoryLocation({ path: '/settings?tab=a&keep=yes', record: true });
  renderWithSession(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <Fixture />
    </Router>,
  );
  expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'retained' } });
  screen.getByRole('tab', { name: 'A' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(location.history.at(-1)).toBe('/settings?tab=b&keep=yes');
  await userEvent.keyboard('{ArrowLeft}');
  expect(screen.getByLabelText<HTMLInputElement>('Draft').value).toBe('retained');
});
it('unknown tab values safely show the all section', () => {
  const location = memoryLocation({ path: '/settings?tab=missing' });
  renderWithSession(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <Fixture />
    </Router>,
  );
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
});
