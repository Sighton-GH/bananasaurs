// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('lets an in-flight retry win and ignores the later first response', async () => {
    let firstResolve!: (value: string) => void;
    let secondResolve!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      firstResolve = resolve;
    });
    const second = new Promise<string>((resolve) => {
      secondResolve = resolve;
    });
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const { result } = renderHook(() => useResource('the thing', load));
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.resource.state).toBe('loading');
    expect('retry' in result.current.resource).toBe(true);
    const loading = result.current.resource;
    if (!('retry' in loading)) throw new Error('Loading must offer retry');
    expect(loading.retry).toBe(result.current.reload);
    const retry = loading.retry;
    await act(async () => {
      retry?.();
    });
    expect(result.current.resource.state).toBe('loading');
    expect('retry' in result.current.resource && result.current.resource.retry).toBe(retry);
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      secondResolve('latest');
    });
    expect(result.current.resource).toEqual({ state: 'ready', data: 'latest' });
    await act(async () => {
      firstResolve('obsolete');
    });
    expect(result.current.resource).toEqual({ state: 'ready', data: 'latest' });
  });

  it('ignores a late first rejection after a retry already succeeded', async () => {
    let firstReject!: (reason: unknown) => void;
    let secondResolve!: (value: string) => void;
    const first = new Promise<string>((_resolve, reject) => {
      firstReject = reject;
    });
    const second = new Promise<string>((resolve) => {
      secondResolve = resolve;
    });
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const { result } = renderHook(() => useResource('the thing', load));
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.resource.state).toBe('loading');
    await act(async () => {
      result.current.reload();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.resource.state).toBe('loading');
    await act(async () => {
      secondResolve('latest');
    });
    expect(result.current.resource).toEqual({ state: 'ready', data: 'latest' });
    await act(async () => {
      firstReject(new Error('late failure'));
    });
    expect(result.current.resource).toEqual({ state: 'ready', data: 'latest' });
  });

  it('goes loading → ready', async () => {
    render(<Probe answers={[() => Promise.resolve('one')]} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(await screen.findByText('value: one')).toBeTruthy();
  });

  it('goes loading → error with the request name, and retry reloads', async () => {
    render(
      <Probe answers={[() => Promise.reject(new Error('nope')), () => Promise.resolve('two')]} />,
    );
    const alert = await screen.findByRole('alert');
    expect(screen.getByText("Couldn't load the thing")).toBeTruthy();
    expect(alert.textContent).toContain('nope');
    await act(async () => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    expect(await screen.findByText('value: two')).toBeTruthy();
  });
});
