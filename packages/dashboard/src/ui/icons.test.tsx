// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, IconSun } from './icons.js';

describe('Icon (docs/28 §5.2)', () => {
  it('is decorative by default', () => {
    const { container } = render(<Icon icon={IconSun} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
  });
  it('takes a label when it stands alone', () => {
    const { getByRole } = render(<Icon icon={IconSun} size="md" label="Light mode" />);
    expect(getByRole('img', { name: 'Light mode' }).getAttribute('width')).toBe('20');
  });
});
