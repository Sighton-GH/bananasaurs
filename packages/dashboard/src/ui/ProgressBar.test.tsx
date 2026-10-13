// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar.js';

afterEach(cleanup);

describe('ProgressBar', () => {
  it('renders role=progressbar with value, bounds and label', () => {
    render(<ProgressBar value={40} max={200} label="Uploading" />);
    const bar = screen.getByRole('progressbar', { name: 'Uploading' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('200');
  });

  it('clamps aria-valuenow to the visual fill range above max', () => {
    render(<ProgressBar value={150} max={100} label="Uploading" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('clamps aria-valuenow to the visual fill range below zero', () => {
    render(<ProgressBar value={-5} max={50} label="Uploading" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('50');
  });

  it('defaults max to 100', () => {
    render(<ProgressBar value={25} label="Loading" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });
});
