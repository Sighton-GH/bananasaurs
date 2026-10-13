// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bootTheme, THEME_STORAGE_KEY } from './theme-boot.js';

const store = (value: string | null) => ({
  getItem: (k: string) => (k === THEME_STORAGE_KEY ? value : null),
});

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('bootTheme (ADR 0142 decision 2)', () => {
  it('a first visit is light', () => {
    bootTheme(store(null), document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
  it.each(['light', 'dark'])('a saved %s is kept', (saved) => {
    bootTheme(store(saved), document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe(saved);
  });
  it('a saved "system" sets no attribute, so the media query decides', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    bootTheme(store('system'), document.documentElement);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
  it('an unknown saved choice falls back to light', () => {
    bootTheme(store('garbage'), document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
  it('a storage that throws (private mode) still gives light', () => {
    bootTheme(
      {
        getItem: () => {
          throw new Error('denied');
        },
      },
      document.documentElement,
    );
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});
