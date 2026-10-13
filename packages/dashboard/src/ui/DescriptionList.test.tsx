// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DescriptionList } from './DescriptionList.js';
afterEach(cleanup);
it('uses dt/dd pairs and an optional responsive second column', () => {
  const { container, rerender } = render(
    <DescriptionList
      items={[
        { term: 'Team', value: <strong>Car</strong> },
        { term: 'Members', value: 5 },
      ]}
    />,
  );
  expect(container.querySelector('dl')).toBeTruthy();
  expect(Array.from(container.querySelectorAll('dt')).map((el) => el.textContent)).toEqual([
    'Team',
    'Members',
  ]);
  expect(Array.from(container.querySelectorAll('dd')).map((el) => el.textContent)).toEqual([
    'Car',
    '5',
  ]);
  expect(container.querySelector('dl')?.classList.contains('sm:grid-cols-2')).toBe(false);
  rerender(<DescriptionList items={[]} columns={2} />);
  expect(container.querySelector('dl')?.classList.contains('sm:grid-cols-2')).toBe(true);
});
