// @vitest-environment jsdom
// N15: keyboard activation of a move control must keep focus on the moved
// item's stable control after the reorder, never on BODY - and must never
// steal focus for pointer/drag reorder or late, unrelated commits.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderedList } from './OrderedList.js';

afterEach(cleanup);

interface HostProps {
  readonly initial: readonly string[];
  readonly onReorder: (next: readonly string[]) => void;
  /** sync: apply immediately; async/intervene: queue the commit until the test
   *  releases it (intervene renders a fresh same-order copy first). */
  readonly mode?: 'sync' | 'async' | 'intervene';
  /** Instead of applying the order, drop this key (removed-item path). */
  readonly removeKey?: string;
  /**
   * The test-owned queue receiving each pending commit (async/intervene
   * modes). The test releases it after the steps whose pre-commit state it
   * asserts, so the commit can never fire mid-keyboard or mid-click.
   */
  readonly commitQueue?: Array<() => void>;
  readonly withInput?: boolean;
  readonly renderInput?: boolean;
  readonly stacked?: boolean;
}

/** Controlled host: OrderedList is controlled, so the parent applies the order. */
function Host({
  initial,
  onReorder,
  mode = 'sync',
  removeKey,
  commitQueue,
  withInput = false,
  renderInput = false,
  stacked = false,
}: HostProps) {
  const [items, setItems] = useState<readonly string[]>(initial);
  return (
    <>
      {withInput ? <input aria-label="Unrelated field" /> : null}
      <OrderedList
        items={items}
        itemKey={(item) => item}
        renderItem={(item) =>
          renderInput ? <input aria-label={`draft ${item}`} /> : <span>{item}</span>
        }
        onReorder={(next) => {
          onReorder(next);
          if (removeKey !== undefined) {
            setItems((current) => current.filter((item) => item !== removeKey));
            return;
          }
          if (mode === 'intervene') {
            // A controlled parent that re-renders with a fresh same-order
            // array before committing the reorder when the test releases it.
            setItems((current) => [...current]);
            if (commitQueue !== undefined) commitQueue.push(() => setItems(next));
            else setItems(next);
          } else if (mode === 'async') {
            if (commitQueue !== undefined) commitQueue.push(() => setItems(next));
            else setItems(next);
          } else {
            setItems(next);
          }
        }}
        label="Model order"
        stacked={stacked}
      />
    </>
  );
}

/**
 * The test-owned side of a manually released commit: the host pushes each
 * pending `setItems(next)` into `queue`, and the test releases it with
 * `await act(async () => { commits.releaseNext(); })` at the point the old
 * timer was meant to fire — after the keyboard/click steps whose pre-commit
 * state the test asserts.
 */
const makeCommits = (): {
  readonly queue: Array<() => void>;
  readonly releaseNext: () => void;
  readonly releaseAll: () => void;
} => {
  const queue: Array<() => void> = [];
  return {
    queue,
    releaseNext: () => {
      queue.shift()?.();
    },
    releaseAll: () => {
      while (queue.length > 0) queue.shift()?.();
    },
  };
};

const TWO = ['gemini-2.5-flash', 'openrouter-model'] as const;
const THREE = ['gemini-2.5-flash', 'gemma-3-27b-it', 'openrouter-model'] as const;
const FOUR = ['gemini-2.5-flash', 'gemma-3-27b-it', 'openrouter-model', 'qwen3-32b'] as const;

const focusedName = () =>
  document.activeElement instanceof HTMLButtonElement
    ? (document.activeElement.getAttribute('aria-label') ?? '<button without label>')
    : document.activeElement === document.body
      ? '<BODY>'
      : (document.activeElement?.tagName ?? '<none>');

const firstRowText = () => screen.getAllByRole('listitem')[0]?.textContent ?? '';

const firstRowInputLabel = () =>
  screen.getAllByRole('listitem')[0]?.querySelector('input')?.getAttribute('aria-label') ?? '';

describe('N15: keyboard reorder preserves focus on the moved item', () => {
  it('first row Move down (two items, exact native repro): focus lands on the moved item, not BODY', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={TWO} onReorder={onReorder} />);
    await user.tab(); // up is disabled on the first row, so Tab lands on its down button
    const down = screen.getByRole('button', { name: 'Move gemini-2.5-flash down' });
    expect(document.activeElement).toBe(down);
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['openrouter-model', 'gemini-2.5-flash']);
    // The down button is now disabled at the edge; focus must sit on the same
    // item's remaining usable control, never BODY.
    expect(focusedName()).toBe('Move gemini-2.5-flash up');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('middle Move down keeps focus on the same still-enabled button', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={FOUR} onReorder={onReorder} />);
    const down = screen.getByRole('button', { name: 'Move gemma-3-27b-it down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([
      'gemini-2.5-flash',
      'openrouter-model',
      'gemma-3-27b-it',
      'qwen3-32b',
    ]);
    expect(focusedName()).toBe('Move gemma-3-27b-it down');
  });

  it('middle Move up keeps focus on the same still-enabled button (Space activation)', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={FOUR} onReorder={onReorder} />);
    const up = screen.getByRole('button', { name: 'Move openrouter-model up' });
    up.focus();
    await user.keyboard(' ');
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([
      'gemini-2.5-flash',
      'openrouter-model',
      'gemma-3-27b-it',
      'qwen3-32b',
    ]);
    expect(focusedName()).toBe('Move openrouter-model up');
  });

  it('last-to-first: last row Move up keeps focus on the still-enabled up button', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={THREE} onReorder={onReorder} />);
    const up = screen.getByRole('button', { name: 'Move openrouter-model up' });
    up.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledWith([
      'gemini-2.5-flash',
      'openrouter-model',
      'gemma-3-27b-it',
    ]);
    expect(focusedName()).toBe('Move openrouter-model up');
  });

  it('edge policy: item moved to the last edge refocuses its up button; moving it back refocuses down', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={THREE} onReorder={onReorder} />);
    const down = screen.getByRole('button', { name: 'Move gemma-3-27b-it down' });
    down.focus();
    await user.keyboard('{Enter}'); // gemma now last: down disabled
    expect(focusedName()).toBe('Move gemma-3-27b-it up');
    await user.keyboard('{Enter}'); // move it back up: up still enabled
    expect(focusedName()).toBe('Move gemma-3-27b-it up');
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenNthCalledWith(2, [
      'gemini-2.5-flash',
      'gemma-3-27b-it',
      'openrouter-model',
    ]);
  });

  it('repeated keyboard moves remain operable without touching the mouse', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={THREE} onReorder={onReorder} />);
    screen.getByRole('button', { name: 'Move openrouter-model up' }).focus();
    await user.keyboard('{Enter}');
    expect(focusedName()).toBe('Move openrouter-model up');
    await user.keyboard('{Enter}'); // now first: up disabled, refocus to down
    expect(focusedName()).toBe('Move openrouter-model down');
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenNthCalledWith(2, [
      'openrouter-model',
      'gemini-2.5-flash',
      'gemma-3-27b-it',
    ]);
  });

  it('focus survives an async controlled parent applying the reorder a tick later', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(<Host initial={TWO} onReorder={onReorder} mode="async" commitQueue={commits.queue} />);
    const down = screen.getByRole('button', { name: 'Move gemini-2.5-flash down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(focusedName()).toBe('Move gemini-2.5-flash up');
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the pending restore through an intervening same-order rerender before the commit', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(
      <Host initial={TWO} onReorder={onReorder} mode="intervene" commitQueue={commits.queue} />,
    );
    const down = screen.getByRole('button', { name: 'Move gemini-2.5-flash down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(focusedName()).toBe('Move gemini-2.5-flash up');
    });
  });

  it('does not steal focus when the user focused another control before the commit lands', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(
      <Host
        initial={TWO}
        onReorder={onReorder}
        mode="async"
        commitQueue={commits.queue}
        withInput
      />,
    );
    screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
    await user.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: 'Unrelated field' });
    input.focus(); // user moved on before the parent committed the reorder
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(firstRowText()).toContain('openrouter-model');
    });
    expect(document.activeElement).toBe(input);
  });

  it('expires a never-timely restore instead of stealing focus later', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(<Host initial={TWO} onReorder={onReorder} mode="async" commitQueue={commits.queue} />);
    screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    // Parent commits only after the restore window has closed.
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    try {
      await act(async () => {
        commits.releaseNext();
      });
      await waitFor(() => {
        expect(firstRowText()).toContain('openrouter-model');
      });
      expect(document.activeElement).toBe(document.body);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('removed-item fallback: item deleted by the parent refocuses the first usable move control', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={THREE} onReorder={onReorder} removeKey="gemma-3-27b-it" />);
    screen.getByRole('button', { name: 'Move gemma-3-27b-it down' }).focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    // gemma is gone; the first row's up button is disabled, so its down
    // button is the first usable move control.
    expect(focusedName()).toBe('Move gemini-2.5-flash down');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('pointer click reorders without scheduling a focus restore (keyboard-only repair)', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={TWO} onReorder={onReorder} />);
    await user.click(screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['openrouter-model', 'gemini-2.5-flash']);
    // No keyboard activation, so no restore: focus stays wherever the
    // platform left it (BODY in jsdom after the row reinsertion).
    expect(document.activeElement).toBe(document.body);
  });

  it('issues zero network writes on keyboard reorder (no Save until user Save)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const onReorder = vi.fn();
      const user = userEvent.setup();
      render(<Host initial={THREE} onReorder={onReorder} />);
      screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
      await user.keyboard('{Enter}');
      expect(onReorder).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drag reorder does not steal focus from a focused move control', () => {
    const onReorder = vi.fn();
    render(<Host initial={THREE} onReorder={onReorder} />);
    const upButton = screen.getByRole('button', { name: 'Move openrouter-model up' });
    upButton.focus();
    expect(document.activeElement).toBe(upButton);
    const rows = screen.getAllByTitle('Drag to reorder');
    const source = rows[0];
    const targetRow = screen.getByText('openrouter-model').closest('li');
    if (!source || !targetRow) throw new Error('fixture rows missing');
    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: '' } });
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);
    expect(onReorder).toHaveBeenCalledWith([
      'gemma-3-27b-it',
      'openrouter-model',
      'gemini-2.5-flash',
    ]);
    expect(document.activeElement).toBe(upButton);
  });

  it('scrolls the refocused control clear of the sticky header', async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    try {
      const onReorder = vi.fn();
      const user = userEvent.setup();
      render(
        <>
          <header>Shell header</header>
          <Host initial={TWO} onReorder={onReorder} />
        </>,
      );
      const header = document.querySelector('header');
      if (header === null) throw new Error('fixture header missing');
      const rect = {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 360,
        bottom: 100,
        width: 360,
        height: 100,
        toJSON: () => ({}),
      } as DOMRect;
      header.getBoundingClientRect = () => rect;
      screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
      await user.keyboard('{Enter}');
      // Refocused button's jsdom rect top is 0, under the 100px header plus
      // 4px clearance, so the page must scroll it into view.
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy).toHaveBeenCalledWith({ top: -104 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores focus when the parent rebuilds item objects on commit (key fallback)', async () => {
    interface Row {
      readonly id: string;
    }
    const onReorder = vi.fn();
    const user = userEvent.setup();
    function ObjectHost() {
      const [items, setItems] = useState<readonly Row[]>([{ id: 'alpha' }, { id: 'beta' }]);
      return (
        <OrderedList
          items={items}
          itemKey={(row) => row.id}
          renderItem={(row) => <span>{row.id}</span>}
          onReorder={(next) => {
            onReorder(next);
            // Fresh objects, same keys: identity matching cannot work here.
            setItems(next.map((row) => ({ ...row })));
          }}
          label="Model order"
        />
      );
    }
    render(<ObjectHost />);
    screen.getByRole('button', { name: 'Move alpha down' }).focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(focusedName()).toBe('Move alpha up');
  });

  it('duplicate-keyed distinct objects: a same-order interim rerender does not consume the restore', async () => {
    interface Row {
      readonly id: string;
      readonly label: string;
    }
    const x: Row = { id: 'dup', label: 'x' };
    const y: Row = { id: 'dup', label: 'y' };
    const z: Row = { id: 'z', label: 'z' };
    const onReorder = vi.fn();
    const user = userEvent.setup();
    function DupObjectHost({ commitQueue }: { readonly commitQueue?: Array<() => void> }) {
      const [items, setItems] = useState<readonly Row[]>([x, y, z]);
      return (
        <OrderedList
          items={items}
          itemKey={(row) => row.id}
          itemLabel={(row) => row.label}
          renderItem={(row) => <span>{row.label}</span>}
          onReorder={(next) => {
            onReorder(next);
            // Controlled parent re-renders the SAME order first (fresh array,
            // same object identities), then commits the reorder when released.
            setItems((current) => [...current]);
            if (commitQueue !== undefined) commitQueue.push(() => setItems(next));
            else setItems(next);
          }}
          label="dupes"
        />
      );
    }
    const commits = makeCommits();
    render(<DupObjectHost commitQueue={commits.queue} />);
    const xDown = screen.getByRole('button', { name: 'Move x down' });
    xDown.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    // The same-order interim render must not let y's key match consume x's
    // pending restore.
    expect(document.activeElement).toBe(xDown);
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(focusedName()).toBe('Move x down');
    });
    // React does not define DOM reuse for duplicate keys; the guarantee is the moved row's control at its new position.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move x down' }));
    expect(screen.getAllByRole('listitem')[1]?.contains(document.activeElement)).toBe(true);
  });

  it('duplicate keys: focus follows the moved row to its new position', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={['dup', 'dup', 'solo']} onReorder={onReorder} />);
    const downs = screen.getAllByRole('button', { name: 'Move dup down' });
    const firstDown = downs[0];
    const secondDown = downs[1];
    if (!firstDown || !secondDown) throw new Error('fixture rows missing');
    firstDown.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    // The moved row is now second; its down control stays enabled, so focus
    // must follow the item rather than sitting on the lookalike first row.
    expect(document.activeElement).toBe(secondDown);
  });

  it("does not steal focus when the user focused another row's rendered input before the commit", async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(
      <Host
        initial={TWO}
        onReorder={onReorder}
        mode="async"
        commitQueue={commits.queue}
        renderInput
      />,
    );
    screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
    await user.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: 'draft openrouter-model' });
    input.focus();
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(firstRowInputLabel()).toBe('draft openrouter-model');
    });
    expect(document.activeElement).toBe(input);
  });

  it("does not redirect focus to a move button when the moved row's own input was focused", async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(
      <Host
        initial={TWO}
        onReorder={onReorder}
        mode="async"
        commitQueue={commits.queue}
        renderInput
      />,
    );
    screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
    await user.keyboard('{Enter}');
    // The moved row's own input. In a real browser the row's reinsertion
    // blurs it to BODY; jsdom keeps the focus, so blur explicitly to model
    // the browser. The repair must not redirect that focus to a move button.
    const input = screen.getByRole('textbox', { name: 'draft gemini-2.5-flash' });
    input.focus();
    input.blur();
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(firstRowInputLabel()).toBe('draft openrouter-model');
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('a pointerdown before the commit cancels the pending keyboard restore', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(<Host initial={TWO} onReorder={onReorder} mode="async" commitQueue={commits.queue} />);
    screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
    await user.keyboard('{Enter}');
    fireEvent.pointerDown(document.body); // user clicked blank space
    await act(async () => {
      commits.releaseNext();
    });
    await waitFor(() => {
      expect(firstRowText()).toContain('openrouter-model');
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('a later pointer move-click is not overridden by the earlier keyboard restore', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    const commits = makeCommits();
    render(<Host initial={THREE} onReorder={onReorder} mode="async" commitQueue={commits.queue} />);
    screen.getByRole('button', { name: 'Move gemma-3-27b-it down' }).focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }));
    expect(onReorder).toHaveBeenCalledTimes(2);
    // Both commits are still queued: the click below saw the pre-commit
    // order, so the second call is deterministic. Release both in order.
    await act(async () => {
      commits.releaseAll();
    });
    await waitFor(() => {
      expect(onReorder).toHaveBeenNthCalledWith(2, [
        'gemma-3-27b-it',
        'gemini-2.5-flash',
        'openrouter-model',
      ]);
    });
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')[0]?.textContent ?? '').toContain('gemma-3-27b-it');
    });
    // The keyboard restore was cancelled by the pointerdown; focus must not
    // jump to gemma's move control.
    expect(focusedName()).not.toBe('Move gemma-3-27b-it up');
  });

  it('prefers the sticky header over an earlier static header for scroll clearance', async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    try {
      const onReorder = vi.fn();
      const user = userEvent.setup();
      render(
        <>
          <header>Static page header</header>
          <header style={{ position: 'sticky', top: 0 }}>Sticky shell header</header>
          <Host initial={TWO} onReorder={onReorder} />
        </>,
      );
      const headers = document.querySelectorAll('header');
      const staticHeader = headers[0];
      const stickyHeader = headers[1];
      if (!staticHeader || !stickyHeader) throw new Error('fixture headers missing');
      const rect = (bottom: number) =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 360,
          bottom,
          width: 360,
          height: bottom,
          toJSON: () => ({}),
        }) as DOMRect;
      staticHeader.getBoundingClientRect = () => rect(200);
      stickyHeader.getBoundingClientRect = () => rect(60);
      screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }).focus();
      await user.keyboard('{Enter}');
      // The sticky header's 60px bottom plus 4px clearance drives the scroll,
      // not the taller static header's 200px.
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy).toHaveBeenCalledWith({ top: -64 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stacked layout preserves the same focus behavior', async () => {
    const onReorder = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={TWO} onReorder={onReorder} stacked />);
    const down = screen.getByRole('button', { name: 'Move gemini-2.5-flash down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(onReorder).toHaveBeenCalledWith(['openrouter-model', 'gemini-2.5-flash']);
    expect(focusedName()).toBe('Move gemini-2.5-flash up');
  });
});
