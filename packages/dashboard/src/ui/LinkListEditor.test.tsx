// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { cleanLinks, LinkListEditor, validateLinks } from './LinkListEditor.js';

afterEach(cleanup);

describe('validateLinks', () => {
  it('rejects https: without slashes even though URL parses it', () => {
    expect(new URL('https:example.com').href).toBe('https://example.com/');
    expect(validateLinks([{ label: 'Docs', url: 'https:example.com' }])).toEqual([
      'Link 1: enter a URL that starts with https://',
    ]);
  });
  it('trims surrounding spaces from the URL before validating', () => {
    expect(validateLinks([{ label: 'Docs', url: ' https://e.com ' }])).toEqual(['']);
    expect(cleanLinks([{ label: 'Docs', url: ' https://e.com ' }])).toEqual([
      { label: 'Docs', url: 'https://e.com' },
    ]);
  });
  it('accepts good rows and ignores fully empty ones', () => {
    expect(
      validateLinks([
        { label: 'Docs', url: 'https://example.com' },
        { label: '', url: '' },
      ]),
    ).toEqual(['', '']);
  });
  it('names the row and the fix in every message', () => {
    expect(
      validateLinks([
        { label: '', url: 'https://example.com' },
        { label: 'x'.repeat(35), url: 'https://example.com' },
        { label: 'Docs', url: '' },
        { label: 'Docs', url: 'http://example.com' },
        { label: 'Docs', url: `https://e.com/${'a'.repeat(520)}` },
      ]),
    ).toEqual([
      'Enter a label for link 1',
      'Link 2: labels can be 34 characters or fewer',
      'Enter a URL for link 3',
      'Link 4: enter a URL that starts with https://',
      'Link 5: URLs can be 512 characters or fewer',
    ]);
  });
});

describe('cleanLinks', () => {
  it('trims and drops empty rows', () => {
    expect(
      cleanLinks([
        { label: ' Docs ', url: ' https://e.com ' },
        { label: ' ', url: '' },
      ]),
    ).toEqual([{ label: 'Docs', url: 'https://e.com' }]);
  });
});

describe('LinkListEditor', () => {
  it('adds rows up to five, then hides Add link', () => {
    const onChange = vi.fn();
    const rows = Array.from({ length: 5 }, () => ({ label: '', url: '' }));
    render(<LinkListEditor value={rows} onChange={onChange} errors={[]} />);
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
  });
  it('removes a row and shows a row’s error next to it', () => {
    const onChange = vi.fn();
    render(
      <LinkListEditor
        value={[{ label: 'Docs', url: 'http://x' }]}
        onChange={onChange}
        errors={['Link 1: enter a URL that starts with https://']}
      />,
    );
    expect(screen.getByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    expect(screen.getByLabelText('Link 1 URL').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
