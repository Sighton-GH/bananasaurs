// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataState } from '../ui/DataState.js';
import { useResource } from './useResource.js';

// No global afterEach in this repo (vitest `globals` is off), so the
// library's auto-cleanup never registers — unmount between tests explicitly.
afterEach(cleanup);

function Probe({ answers }: { readonly answers: Array<() => Promise<string>> }) {
  const load = useCallback(() => {
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer queued');
    return next();
  }, [answers]);
  const { resource } = useResource('the thing', load);
  return <DataState resource={resource}>{(d) => <p>value: {d}</p>}</DataState>;
}

describe('useResource', () => {
  it('goes loading → ready', async () => {
    render(<Probe answers={[() => Promise.resolve('one')]} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText('value: one')).toBeTruthy();
  });

  it('goes loading → error with the request name, and retry reloads', async () => {
    render(
      <Probe answers={[() => Promise.reject(new Error('nope')), () => Promise.resolve('two')]} />,
    );
    const alert = await screen.findByRole('alert');
    expect(screen.getByText('Could not load the thing.')).toBeTruthy();
    expect(alert.textContent).toContain('nope');
    await act(async () => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    expect(await screen.findByText('value: two')).toBeTruthy();
  });
});
