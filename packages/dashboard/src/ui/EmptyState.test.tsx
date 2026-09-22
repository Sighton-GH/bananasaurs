// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.js';

afterEach(cleanup);

describe('EmptyState', () => {
  it('renders the title as its accessible name, the detail, and no action by default', () => {
    render(<EmptyState title="Nothing here" detail="Add something to see it." />);
    expect(screen.getByRole('region', { name: 'Nothing here' })).toBeTruthy();
    expect(screen.getByText('Add something to see it.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the action when one is given', () => {
    render(<EmptyState title="Nothing here" detail="Detail." action={<button>Do it</button>} />);
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy();
  });
});
