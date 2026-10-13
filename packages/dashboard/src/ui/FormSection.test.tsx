// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormSection } from './FormSection.js';

afterEach(cleanup);
describe('FormSection', () => {
  it('names each section from its own h2 and groups fields in a bounded grid', () => {
    render(
      <>
        <FormSection title="What" description="Describe the task">
          <input aria-label="Title" />
        </FormSection>
        <FormSection title="Who">
          <input aria-label="People" />
        </FormSection>
      </>,
    );
    const section = screen.getByRole('region', { name: 'What' });
    const heading = screen.getByRole('heading', { name: 'What', level: 2 });
    expect(section.tagName).toBe('SECTION');
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.className).toContain('text-section');
    expect(screen.getByText('Describe the task').className).toContain('text-small text-ink-muted');
    const grid = screen.getByRole('textbox', { name: 'Title' }).parentElement;
    expect(grid?.className).toContain('grid gap-4 max-w-[720px]');
    expect(screen.getByRole('region', { name: 'Who' }).getAttribute('aria-labelledby')).not.toBe(
      heading.id,
    );
    expect(screen.queryAllByText('Describe the task')).toHaveLength(1);
  });
});
