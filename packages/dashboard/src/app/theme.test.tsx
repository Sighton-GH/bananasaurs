// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { ThemeProvider, useTheme } from './theme.js';

describe('theme toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('a first visit is light, then the operator pins a choice', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // No saved choice: light (ADR 0142).
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    const button = screen.getByRole('button', { name: /Switch to (light|dark) mode/ });
    const first = button.getAttribute('aria-label') ?? '';
    fireEvent.click(button);
    const pinned = document.documentElement.getAttribute('data-theme');
    expect(pinned === 'light' || pinned === 'dark').toBe(true);
    expect(window.localStorage.getItem('bananasaurs-theme')).toBe(pinned);
    // The label now offers the opposite scheme.
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toBe(first);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      pinned === 'light' ? 'dark' : 'light',
    );
  });

  it('a stored "system" still reports choice system and follows the OS', () => {
    window.localStorage.setItem('bananasaurs-theme', 'system');
    let seen = '';
    function Probe() {
      seen = useTheme().choice;
      return null;
    }
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(seen).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('an unknown saved choice falls back to light', () => {
    window.localStorage.setItem('bananasaurs-theme', 'garbage');
    let seen = '';
    function Probe() {
      seen = useTheme().choice;
      return null;
    }
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(seen).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('a storage read that throws still gives light', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    let seen = '';
    function Probe() {
      seen = useTheme().choice;
      return null;
    }
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(seen).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it.each(['light', 'dark'])('restores a persisted %s choice on load', (saved) => {
    window.localStorage.setItem('bananasaurs-theme', saved);
    let seen = '';
    function Probe() {
      seen = useTheme().choice;
      return null;
    }
    render(
      <ThemeProvider>
        <Probe />
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(seen).toBe(saved);
    expect(document.documentElement.getAttribute('data-theme')).toBe(saved);
    expect(
      screen.getByRole('button', {
        name: saved === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
      }),
    ).toBeDefined();
  });
});
