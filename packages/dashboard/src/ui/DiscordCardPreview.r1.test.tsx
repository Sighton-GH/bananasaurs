// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DiscordCardPreview } from './DiscordCardPreview.js';
afterEach(cleanup);
const components = [
  {
    type: 17,
    components: [
      {
        type: 10,
        content: '<@555555555555555555> <@666666666666666666> [Docs](https://example.com)',
      },
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'Guide', url: 'https://example.com/guide' }],
      },
    ],
  },
];
it('keeps default mention/link presentation unchanged', () => {
  render(<DiscordCardPreview components={components} />);
  expect(screen.getAllByText('@member')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'Docs' }).textContent).toBe('Docs');
  expect(screen.getByRole('link', { name: 'Guide' }).textContent).toBe('Guide');
});
it('opt-in shows known names, explicit unresolved IDs and visible new-tab text', () => {
  render(
    <DiscordCardPreview
      components={components}
      userNames={{ '555555555555555555': 'Alex' }}
      indicateExternalLinks
    />,
  );
  expect(screen.getByText('Alex')).toBeTruthy();
  expect(screen.getByText('Unresolved user 666666666666666666')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Docs (opens in a new tab)' }).getAttribute('target'),
  ).toBe('_blank');
  expect(
    screen.getByRole('link', { name: 'Guide (opens in a new tab)' }).getAttribute('target'),
  ).toBe('_blank');
});
