// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import { DescribedNotice, ErrorNotice } from './ErrorNotice.js';

afterEach(cleanup);

const ERROR = new ApiError(400, {
  error: 'bad-request',
  title: 'That value is not valid',
  message: 'rpmLimit must be a number.',
  hint: 'Fix the highlighted field and try again.',
  requestId: 'req-0a1b2c3d',
});

describe('ErrorNotice', () => {
  it('renders title, message, hint and the meta line', () => {
    render(<ErrorNotice error={ERROR} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('That value is not valid');
    expect(alert.textContent).toContain('rpmLimit must be a number.');
    expect(alert.textContent).toContain('What to do: Fix the highlighted field and try again.');
    expect(alert.textContent).toContain('bad-request · HTTP 400 · request req-0a1b2c3d');
  });

  it('copies the request id through the clipboard', () => {
    const writeText = vi.fn(async (_text: string): Promise<void> => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<ErrorNotice error={ERROR} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy request id' }));
    expect(writeText).toHaveBeenCalledWith('req-0a1b2c3d');
  });

  it('shows no copy button when there is no request id', () => {
    render(<ErrorNotice error={new ApiError(403, { error: 'x' })} />);
    expect(screen.queryByRole('button', { name: 'Copy request id' })).toBeNull();
  });

  it('compact hides the hint', () => {
    render(<ErrorNotice error={ERROR} compact />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('That value is not valid');
    expect(alert.textContent).toContain('rpmLimit must be a number.');
    expect(alert.textContent).not.toContain('What to do:');
    expect(alert.textContent).toContain('bad-request · HTTP 400 · request req-0a1b2c3d');
  });

  it('DescribedNotice appends detail parts to the meta line', () => {
    render(
      <DescribedNotice
        described={{
          title: 'Could not connect to the AI provider',
          message: 'The connection timed out.',
          hint: 'Check the host VPN.',
          code: 'provider-connect-timeout',
          status: 504,
          fields: [],
        }}
        detail={['api.example.test', '', 'ETIMEDOUT']}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not connect to the AI provider');
    expect(alert.textContent).toContain('The connection timed out.');
    expect(alert.textContent).toContain('What to do: Check the host VPN.');
    expect(alert.textContent).toContain(
      'provider-connect-timeout · HTTP 504 · api.example.test · ETIMEDOUT',
    );
  });
});
