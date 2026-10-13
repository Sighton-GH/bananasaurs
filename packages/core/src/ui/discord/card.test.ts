import { describe, expect, it } from 'vitest';
import { card, toOutgoingMessage } from './card.js';
import { CardBudgetError } from './budget.js';
import { actionRow, button, section, text } from './kit.js';

describe('card()', () => {
  it('wraps children in one toned container and never parses mentions', () => {
    const c = card({ tone: 'ok', children: [text('done')] });
    expect(c.components).toEqual([
      { type: 17, accent_color: 0x2e9a62, components: [{ type: 10, content: 'done' }] },
    ]);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('lists only the pings it was given, de-duplicated', () => {
    const c = card({
      tone: 'accent',
      children: [text('x')],
      pingUsers: ['1', '1', '2'],
      pingRoles: ['3'],
    });
    expect(c.allowedMentions).toEqual({ parse: [], users: ['1', '2'], roles: ['3'] });
  });

  it('de-duplicates art and keeps replyTo', () => {
    const c = card({
      tone: 'neutral',
      children: [text('x')],
      art: ['saurThumb', 'saurThumb'],
      replyTo: '9',
    });
    expect(c.art).toEqual(['saurThumb']);
    expect(c.replyTo).toBe('9');
  });

  it('refuses a card over budget', () => {
    expect(() => card({ tone: 'neutral', children: [text('x'.repeat(4001))] })).toThrow(
      CardBudgetError,
    );
  });
});

describe('card() primary button rule (fix round 1)', () => {
  const primary = (id: string) => button({ customId: id, label: 'Go', style: 'primary' });

  it('allows one primary button and any number of others', () => {
    expect(() =>
      card({
        tone: 'accent',
        children: [
          actionRow([
            primary('a'),
            button({ customId: 'b', label: 'B' }),
            button({ customId: 'c', label: 'C', style: 'success' }),
          ]),
        ],
      }),
    ).not.toThrow();
  });

  it('rejects two primary buttons in one row', () => {
    expect(() =>
      card({ tone: 'accent', children: [actionRow([primary('a'), primary('b')])] }),
    ).toThrow(RangeError);
  });

  it('counts a section accessory and buttons in separate rows', () => {
    expect(() =>
      card({
        tone: 'accent',
        children: [section([text('x')], primary('a')), actionRow([primary('b')])],
      }),
    ).toThrow(RangeError);
  });
});

import type { ArtKey } from './art.js';
import type { OutgoingFile } from '../../discord/port.js';
describe('toOutgoingMessage', () => {
  const thumb: OutgoingFile = {
    name: 'saur-thumb.png',
    contentType: 'image/png',
    data: new Uint8Array([1, 2, 3]),
    description: 'The Bananasaurs banana-saur',
  };

  it('sets the V2 flag and copies components, mentions and replyTo', () => {
    const out = toOutgoingMessage(
      card({ tone: 'neutral', children: [text('x')], pingUsers: ['1'], replyTo: '9' }),
    );
    expect(out.flags).toBe(1 << 15);
    expect(out.components).toHaveLength(1);
    expect(out.allowedMentions).toEqual({ parse: [], users: ['1'] });
    expect(out.replyTo).toBe('9');
    expect(out.files).toBeUndefined();
    expect(out.content).toBeUndefined();
  });

  it('attaches art through the loader', () => {
    const out = toOutgoingMessage(
      card({ tone: 'accent', children: [text('x')], art: ['saurThumb'] }),
      () => thumb,
    );
    expect(out.files).toEqual([thumb]);
  });

  it('throws when a card needs art and no loader was given', () => {
    expect(() =>
      toOutgoingMessage(card({ tone: 'accent', children: [text('x')], art: ['saurThumb'] })),
    ).toThrow(/art/);
  });
});

it('toOutgoingMessage forwards explicit role pings without parsing mentions', () => {
  const out = toOutgoingMessage(
    card({ tone: 'neutral', children: [text('x')], pingRoles: ['3', '4'] }),
  );
  expect(out.allowedMentions).toEqual({ parse: [], roles: ['3', '4'] });
});

it('toOutgoingMessage loads each distinct art key in card order', () => {
  const keys: ArtKey[] = [];
  const files: Record<ArtKey, OutgoingFile> = {
    saurThumb: { name: 'saur-thumb.png', contentType: 'image/png', data: new Uint8Array([1]) },
    bannerTasks: { name: 'banner-tasks.png', contentType: 'image/png', data: new Uint8Array([2]) },
    bannerDigest: {
      name: 'banner-digest.png',
      contentType: 'image/png',
      data: new Uint8Array([3]),
    },
    bannerPanel: { name: 'banner-panel.png', contentType: 'image/png', data: new Uint8Array([4]) },
  };
  const out = toOutgoingMessage(
    card({
      tone: 'accent',
      children: [text('x')],
      art: ['saurThumb', 'bannerDigest', 'bannerTasks', 'bannerPanel', 'saurThumb'],
    }),
    (key) => {
      keys.push(key);
      return files[key];
    },
  );
  expect(keys).toEqual(['saurThumb', 'bannerDigest', 'bannerTasks', 'bannerPanel']);
  expect(out.files).toEqual([
    files.saurThumb,
    files.bannerDigest,
    files.bannerTasks,
    files.bannerPanel,
  ]);
});
