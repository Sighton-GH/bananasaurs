// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { ThemeProvider } from './theme.js';

describe('theme toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => cleanup());

  it('follows the system until the operator picks, then pins the choice', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // No choice yet: no attribute, the media query rules.
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
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

  it('restores a persisted choice on load', () => {
    window.localStorage.setItem('bananasaurs-theme', 'light');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeDefined();
  });
});
