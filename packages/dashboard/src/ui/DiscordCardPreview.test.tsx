// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { renderTaskCard, type TaskCardView } from '@bananasaurs/core';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscordCardPreview } from './DiscordCardPreview.js';

afterEach(cleanup);

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const view: TaskCardView = {
  taskId: 'task-1',
  version: 1,
  title: 'Print *the* body_v2 \\ [x](https://e.co)',
  description: 'Use the **v3** file.\n> quoted\n# heading',
  teamName: 'Tech *team*',
  status: 'not_started',
  priority: 'urgent',
  dueAt: Date.UTC(2026, 9, 14, 17, 30, 0),
  now: NOW,
  audience: { kind: 'users', userIds: ['123456789012345678'] },
  links: [
    { label: 'Spec', url: 'https://example.com/spec' },
    { label: 'Bad', url: 'javascript:alert(1)' },
  ],
  updatedAt: NOW,
  variant: 'announce',
};
const clock = { now: NOW, timeZone: 'UTC' };
const real = (v: TaskCardView = view) => renderTaskCard(v);

it('renders the real P1 card: eyebrow, strong title, links, disabled button, art stand-in', () => {
  const { container } = render(<DiscordCardPreview components={real().components} {...clock} />);
  expect(container.textContent).toContain('NEW TASK · Tech *team* · URGENT');
  const strong = container.querySelector('strong');
  expect(strong?.textContent).toBe('Print *the* body_v2 \\ [x](https://e.co)');
  const spec = screen.getByRole('link', { name: 'Spec' });
  expect(spec.getAttribute('href')).toBe('https://example.com/spec');
  expect(spec.getAttribute('rel')).toBe('noopener noreferrer');
  const on = screen.getByRole('button', { name: /I'm on it/ });
  expect(on.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: /Post update/ }).hasAttribute('disabled')).toBe(true);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/bananasaur.png');
  expect(container.textContent).toContain(
    'Art shown here is a stand-in; Discord shows the card art.',
  );
});

it('does not turn escaped title or description markup into elements', () => {
  const { container } = render(<DiscordCardPreview components={real().components} {...clock} />);
  expect(container.querySelectorAll('em')).toHaveLength(0);
  expect(container.querySelector('a[href="https://e.co"]')).toBeNull();
  expect(container.textContent).toContain('# heading');
  expect(container.textContent).toContain('quoted');
});

it('shows an escaped description quote marker as literal text, not a quote block', () => {
  const { container } = render(<DiscordCardPreview components={real().components} {...clock} />);
  expect(container.querySelectorAll('blockquote')).toHaveLength(0);
  expect(container.textContent).toContain('> quoted');
});

it('renders timestamps deterministically from the clock input', () => {
  const { container } = render(<DiscordCardPreview components={real().components} {...clock} />);
  expect(container.textContent).toContain('October 14, 2026 at 5:30 PM');
  expect(container.textContent).toContain('in 2 days');
  expect(container.textContent).toContain('@member');
});

it('an unsafe card link renders as a disabled control, never an anchor', () => {
  render(<DiscordCardPreview components={real().components} {...clock} />);
  expect(screen.queryByRole('link', { name: 'Bad' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Bad' }).hasAttribute('disabled')).toBe(true);
});

it('sets the accent border from the integer wire colour', () => {
  const { container } = render(<DiscordCardPreview components={real().components} {...clock} />);
  const card = container.querySelector('[data-discord-card]') as HTMLElement;
  expect(card.style.getPropertyValue('--discord-accent')).toBe('#2f5bd3');
  const danger = renderTaskCard({ ...view, dueAt: NOW - 1 });
  const again = render(<DiscordCardPreview components={danger.components} {...clock} />);
  const c2 = again.container.querySelector('[data-discord-card]') as HTMLElement;
  expect(c2.style.getPropertyValue('--discord-accent')).toBe('#d64545');
});

it('clicking or pressing a button issues no network call', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  render(<DiscordCardPreview components={real().components} {...clock} />);
  screen.getByRole('button', { name: /I'm on it/ }).click();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('walks every supported V2 type', () => {
  const components = [
    {
      type: 17,
      accent_color: 0x00ff00,
      components: [
        { type: 10, content: 'hello **there**' },
        { type: 14, divider: true, spacing: 1 },
        {
          type: 12,
          items: [{ media: { url: 'attachment://banner-tasks.png' }, description: 'Leaves' }],
        },
        {
          type: 9,
          components: [{ type: 10, content: 'in section' }],
          accessory: { type: 2, style: 5, url: 'https://example.com/x', label: 'Open' },
        },
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'a', label: 'Primary' },
            { type: 2, style: 2, custom_id: 'b', label: 'Second' },
            { type: 2, style: 3, custom_id: 'c', label: 'Good' },
            { type: 2, style: 4, custom_id: 'd', label: 'Bad' },
          ],
        },
      ],
    },
  ];
  const { container } = render(<DiscordCardPreview components={components} {...clock} />);
  expect(container.textContent).toContain('in section');
  expect(container.querySelector('hr')).not.toBeNull();
  expect(container.querySelector('img')?.getAttribute('alt')).toBe('Leaves');
  expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
  expect(screen.getAllByRole('button')).toHaveLength(4);
});

it('handles malformed and unknown wire values without throwing or casting through', () => {
  const junk: unknown[] = [
    null,
    1,
    'x',
    [],
    {},
    { type: 99 },
    { type: 17 },
    { type: 17, accent_color: 'red', components: 'no' },
    { type: 17, accent_color: -5, components: [{ type: 10, content: 7 }] },
    {
      type: 17,
      accent_color: 0x1000000,
      components: [{ type: 9, components: null, accessory: 4 }],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 77, label: {} },
        { type: 2, style: 5, url: 3 },
      ],
    },
    { type: 11, media: { url: 'https://evil.example/x.png' } },
  ];
  const { container } = render(<DiscordCardPreview components={junk} {...clock} />);
  expect(container.querySelector('img')).toBeNull();
});

it('never renders a remote image from the wire', () => {
  const components = [
    {
      type: 17,
      accent_color: 1,
      components: [
        {
          type: 9,
          components: [{ type: 10, content: 'x' }],
          accessory: {
            type: 11,
            media: { url: 'https://evil.example/t.png' },
            description: 'Remote art',
          },
        },
        { type: 12, items: [{ media: { url: 'attachment://../../etc/passwd' } }] },
        { type: 12, items: [{ media: { url: '//evil.example/x.png' } }] },
      ],
    },
  ];
  const { container } = render(<DiscordCardPreview components={components} {...clock} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('Remote art');
});

it('maps attachment names through the art registry only', () => {
  const components = [
    {
      type: 17,
      accent_color: 1,
      components: [
        { type: 12, items: [{ media: { url: 'attachment://mine.png' }, description: 'Mine' }] },
      ],
    },
  ];
  const { container } = render(
    <DiscordCardPreview
      components={components}
      art={{ 'mine.png': '/brand/leaves.svg' }}
      {...clock}
    />,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/leaves.svg');
});

it('keeps <script> as literal text', () => {
  const components = [
    { type: 17, accent_color: 1, components: [{ type: 10, content: '<script>x()</script>' }] },
  ];
  const { container } = render(<DiscordCardPreview components={components} {...clock} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>x()</script>');
});

it('is not host-zone dependent', () => {
  const a = render(<DiscordCardPreview components={real().components} {...clock} />).container
    .innerHTML;
  cleanup();
  const prev = process.env['TZ'];
  process.env['TZ'] = 'Pacific/Auckland';
  const b = render(<DiscordCardPreview components={real().components} {...clock} />).container
    .innerHTML;
  if (prev === undefined) delete process.env['TZ'];
  else process.env['TZ'] = prev;
  expect(b).toBe(a);
});

it('looks art up by own registry keys only, never inherited ones', () => {
  const components = [
    {
      type: 17,
      accent_color: 1,
      components: [
        { type: 12, items: [{ media: { url: 'attachment://constructor' }, description: 'A' }] },
        { type: 12, items: [{ media: { url: 'attachment://toString' }, description: 'B' }] },
      ],
    },
  ];
  const { container } = render(<DiscordCardPreview components={components} {...clock} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelectorAll('[data-art-fallback]')).toHaveLength(2);
});

it.each([-1, 0x1000000, 1.5, Number.NaN, '#fff', null])(
  'ignores an invalid accent colour %j',
  (accent) => {
    const components = [{ type: 17, accent_color: accent, components: [] }];
    const { container } = render(<DiscordCardPreview components={components} {...clock} />);
    const card = container.querySelector('[data-discord-card]') as HTMLElement;
    expect(card.style.getPropertyValue('--discord-accent')).toBe('');
  },
);

it('draws accent 0 and the maximum colour', () => {
  for (const [accent, hex] of [
    [0, '#000000'],
    [0xffffff, '#ffffff'],
  ] as const) {
    const { container } = render(
      <DiscordCardPreview
        components={[{ type: 17, accent_color: accent, components: [] }]}
        {...clock}
      />,
    );
    const card = container.querySelector('[data-discord-card]') as HTMLElement;
    expect(card.style.getPropertyValue('--discord-accent')).toBe(hex);
    cleanup();
  }
});

it('every button in a card is disabled or a link, none is an enabled control', () => {
  render(
    <DiscordCardPreview
      components={
        renderTaskCard({
          ...view,
          status: 'in_progress',
          pickedUp: { userId: '123456789012345678', at: NOW },
        }).components
      }
      {...clock}
    />,
  );
  for (const b of screen.getAllByRole('button')) expect(b.hasAttribute('disabled')).toBe(true);
});

it('draws no button for a button without a text label', () => {
  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 1, custom_id: 'a', label: 7 },
        { type: 2, style: 1, custom_id: 'b' },
      ],
    },
  ];
  render(<DiscordCardPreview components={components} {...clock} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
