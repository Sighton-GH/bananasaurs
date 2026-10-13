// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorSummary } from './ErrorSummary.js';

afterEach(cleanup);

describe('ErrorSummary', () => {
  it('renders nothing when there are no errors', () => {
    const { container } = render(<ErrorSummary errors={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists one anchor per error under the default title and focuses itself on mount', () => {
    render(
      <ErrorSummary
        errors={[
          { fieldId: 'name', message: 'Enter a name' },
          { fieldId: 'age', message: 'Enter an age' },
        ]}
      />,
    );
    const summary = screen.getByRole('alert');
    expect(summary.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(summary);
    expect(screen.getByText("There's a problem")).toBeDefined();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('#name');
    expect(links[0]?.textContent).toBe('Enter a name');
    expect(links[1]?.getAttribute('href')).toBe('#age');
  });

  it('clicking a link focuses the field with that id', () => {
    render(
      <>
        <input id="name" aria-label="Name" />
        <ErrorSummary errors={[{ fieldId: 'name', message: 'Enter a name' }]} />
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Enter a name' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('anchors operate from the keyboard: Tab from the summary, Enter focuses the field', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input id="name" aria-label="Name" />
        <ErrorSummary
          errors={[
            { fieldId: 'name', message: 'Enter a name' },
            { fieldId: 'age', message: 'Enter an age' },
          ]}
        />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Enter a name' }));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('accepts a custom title', () => {
    render(<ErrorSummary title="Check the form" errors={[{ fieldId: 'x', message: 'Bad' }]} />);
    expect(screen.getByText('Check the form')).toBeDefined();
  });
});
