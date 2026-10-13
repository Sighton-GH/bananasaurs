// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NotFoundPage } from './not-found.js';

afterEach(cleanup);

describe('NotFoundPage (7c)', () => {
  it('uses the kit NotFound state with a way home and makes no request', () => {
    const { hook } = memoryLocation({ path: '/nope' });
    render(
      <Router hook={hook}>
        <NotFoundPage />
      </Router>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.getByText(/This page doesn't exist or was deleted/)).toBeTruthy();
    const home = screen.getByRole('link', { name: 'Go to the overview' });
    expect(home.getAttribute('href')).toBe('/');
    expect(home.className).toContain('text-accent');
    expect(document.querySelector('.text-sm')).toBeNull();
  });
});
