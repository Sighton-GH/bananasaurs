// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleCards } from './RoleCards.js';

afterEach(cleanup);

describe('RoleCards', () => {
  it('renders one radio per role and reports the preset capabilities', () => {
    const onChange = vi.fn();
    render(<RoleCards value="viewer" capabilities={['config.read', 'audit.read']} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: /Viewer/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Moderator/ }));
    expect(onChange).toHaveBeenCalledWith('moderator', [
      'config.read',
      'audit.read',
      'moderation.act',
      'undo.execute',
      'roles.mutate',
    ]);
  });

  it('moves between roles with the arrow keys', () => {
    const onChange = vi.fn();
    render(<RoleCards value="viewer" capabilities={['config.read', 'audit.read']} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('moderator', [
      'config.read',
      'audit.read',
      'moderation.act',
      'undo.execute',
      'roles.mutate',
    ]);
  });

  it('Custom lists every permission in plain words with its description', () => {
    const onChange = vi.fn();
    render(<RoleCards value="custom" capabilities={['config.read']} onChange={onChange} />);
    expect(screen.getByText('View settings')).toBeTruthy();
    expect(screen.getByText("See this server's settings, rules and assistant setup.")).toBeTruthy();
    expect(screen.queryByText('config.read')).toBeNull();
    fireEvent.click(screen.getByLabelText('View activity logs'));
    expect(onChange).toHaveBeenCalledWith('custom', ['config.read', 'audit.read']);
  });

  it('disables every control when disabled', () => {
    const onChange = vi.fn();
    render(
      <RoleCards value="viewer" capabilities={['config.read', 'audit.read']} onChange={onChange} disabled />,
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-disabled', 'true');
    }
  });
});
