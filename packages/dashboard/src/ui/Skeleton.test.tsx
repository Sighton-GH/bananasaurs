// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton.js';

afterEach(cleanup);

describe('Skeleton', () => {
  it('renders one pulsing aria-hidden block per line, the last at 60% width', () => {
    const { container } = render(<Skeleton lines={3} />);
    const root = container.firstElementChild;
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    const blocks = Array.from(root?.children ?? []);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.className).toContain('animate-pulse');
      expect(block.className).toContain('motion-reduce:animate-none');
      expect(block.className).toContain('bg-sunk');
    }
    expect(blocks[0]?.className).not.toContain('w-3/5');
    expect(blocks[2]?.className).toContain('w-3/5');
  });

  it('defaults to 3 lines and accepts a className', () => {
    const { container } = render(<Skeleton className="mt-4" />);
    const root = container.firstElementChild;
    expect(root?.children).toHaveLength(3);
    expect(root?.className).toContain('mt-4');
  });
});
