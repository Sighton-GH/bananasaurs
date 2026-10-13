// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import type { AssistantData } from '../../api/assistant.js';
import type { Session } from '../../app/session.js';
import { TEST_SESSION } from '../../test-support.js';
import { ToastProvider } from '../../ui/Toast.js';
import { NewBehaviourDialog } from './create-dialog.js';

const data: AssistantData = {
  behaviours: [],
  resources: [],
  reminders: [],
  activity: [],
  roles: [
    { id: 'mention-role', name: 'Club helper', position: 20 },
    { id: 'caller-role', name: 'Club members with a long readable role name', position: 10 },
  ],
  skills: [
    {
      id: 'find',
      name: 'Find club knowledge',
      description: '',
      promptLine: '',
      effect: 'read',
      requiredPermission: 'assistant.ask',
      acts: false,
      defaultScope: 'everyone',
      requiresConfirmation: false,
    },
    {
      id: 'owner',
      name: 'Owner private skill',
      description: '',
      promptLine: '',
      effect: 'read',
      requiredPermission: 'assistant.ask',
      acts: false,
      defaultScope: 'owner',
      requiresConfirmation: false,
      ownerOnly: true,
    },
  ],
};
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

function setup(
  answer: () => Promise<unknown> = () => Promise.resolve({ ok: true }),
  directory = data,
) {
  const write = vi.fn<(...args: Parameters<Session['writeOrThrow']>) => Promise<unknown>>(answer);
  const session: Session = {
    info: TEST_SESSION,
    read: vi.fn(),
    write: vi.fn(),
    writeOrThrow: async <T,>(...args: Parameters<Session['writeOrThrow']>) =>
      (await write(...args)) as T | undefined,
    switchGuild: vi.fn(),
    logout: vi.fn(),
  };
  const created = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <ToastProvider>
        <button onClick={() => setOpen(true)} disabled={open}>
          New behaviour
        </button>
        {open && (
          <NewBehaviourDialog
            data={directory}
            session={session}
            onCancel={() => setOpen(false)}
            onCreated={(id) => {
              created(id);
              setOpen(false);
            }}
          />
        )}
      </ToastProvider>
    );
  }
  render(<Harness />);
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'New behaviour' });
  return { user, opener, write, created, open: () => user.click(opener) };
}
function fill() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: ' New member help ' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Mention role' }), {
    target: { value: 'mention-role' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for the new behaviour' }), {
    target: { value: ' Help with reviewed club knowledge. ' },
  });
}

describe('R6 Create behaviour', () => {
  it.each(['Escape', 'Cancel'])(
    '%s closes without writes and restores the disabled-while-open opener',
    async (how) => {
      const s = setup();
      await s.open();
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
      fill();
      if (how === 'Escape') await s.user.keyboard('{Escape}');
      else await s.user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(s.opener));
      expect(s.write).not.toHaveBeenCalled();
      expect(s.created).not.toHaveBeenCalled();
    },
  );

  it('keeps keyboard focus within the dialog while open', async () => {
    const s = setup();
    await s.open();
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 24; i += 1) {
      await s.user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await s.user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(s.write).not.toHaveBeenCalled();
  });

  it('reopening starts with empty fields and default tag, roles and skills', async () => {
    const s = setup();
    await s.open();
    fill();
    await s.user.selectOptions(screen.getByRole('combobox', { name: 'Tag' }), 'help');
    await s.user.click(screen.getByRole('checkbox', { name: /Club members/ }));
    await s.user.click(screen.getByRole('checkbox', { name: /Find club knowledge/ }));
    await s.user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(s.opener));
    await s.open();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('');
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Instructions for the new behaviour',
      }).value,
    ).toBe('');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Tag' }).value).toBe(
      'bananasaurs',
    );
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Mention role' }).value).toBe(
      '',
    );
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every((box) => !box.checked)).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Create behaviour' }).disabled,
    ).toBe(true);
  });

  it('required fields gate submission, including missing role directories', async () => {
    const s = setup();
    await s.open();
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    expect(name.required).toBe(true);
    expect(name.checkValidity()).toBe(false);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Instructions for the new behaviour',
      }).required,
    ).toBe(true);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Mention role' }).required).toBe(
      true,
    );
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create behaviour' });
    expect(submit.disabled).toBe(true);
    await s.user.click(submit);
    expect(s.write).not.toHaveBeenCalled();
    fill();
    expect(submit.disabled).toBe(false);
    cleanup();
    const withoutRoles = { ...data };
    delete withoutRoles.roles;
    const missing = setup(undefined, withoutRoles);
    await missing.open();
    fill();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Create behaviour' }).disabled,
    ).toBe(true);
    expect(missing.write).not.toHaveBeenCalled();
  });

  it('sends the exact existing create contract with chosen live IDs, then restores focus on success', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const s = setup();
    await s.open();
    fill();
    await s.user.selectOptions(screen.getByRole('combobox', { name: 'Tag' }), 'it-services');
    await s.user.click(screen.getByRole('checkbox', { name: /Club members/ }));
    await s.user.click(screen.getByRole('checkbox', { name: /Find club knowledge/ }));
    expect(screen.queryByRole('checkbox', { name: /Owner private/ })).toBeNull();
    await s.user.click(screen.getByRole('button', { name: 'Create behaviour' }));
    const id = `new-member-help-${(1_800_000_000_000).toString(36)}`;
    expect(s.write).toHaveBeenCalledExactlyOnceWith(
      `/api/assistant/behaviours/${id}`,
      {
        id,
        name: 'New member help',
        surface: 'it-services',
        mentionRoleId: 'mention-role',
        systemPrompt: 'Help with reviewed club knowledge.',
        promptVersion: 0,
        preferredSkillIds: ['find'],
        callerRoleIds: ['caller-role'],
        resourceIds: [],
        enabled: false,
      },
      'PUT',
    );
    expect(s.created).toHaveBeenCalledExactlyOnceWith(id);
    await waitFor(() => expect(document.activeElement).toBe(s.opener));
  });

  it('successful navigation leaves focus on the destination when the opener is removed', async () => {
    const created = vi.fn();
    const session: Session = {
      info: TEST_SESSION,
      read: vi.fn(),
      write: vi.fn(),
      writeOrThrow: async <T,>() => ({ ok: true }) as T,
      switchGuild: vi.fn(),
      logout: vi.fn(),
    };
    function Destination() {
      const heading = useRef<HTMLHeadingElement>(null);
      useEffect(() => {
        heading.current?.focus();
      }, []);
      return (
        <h1 ref={heading} tabIndex={-1}>
          Created behaviour
        </h1>
      );
    }
    function NavigationHarness() {
      const [open, setOpen] = useState(false);
      const [done, setDone] = useState(false);
      return (
        <ToastProvider>
          {done ? (
            <Destination />
          ) : (
            <>
              <button onClick={() => setOpen(true)} disabled={open}>
                New behaviour
              </button>
              {open && (
                <NewBehaviourDialog
                  data={data}
                  session={session}
                  onCancel={() => setOpen(false)}
                  onCreated={(id) => {
                    created(id);
                    setDone(true);
                  }}
                />
              )}
            </>
          )}
        </ToastProvider>
      );
    }
    render(<NavigationHarness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New behaviour' }));
    fill();
    await user.click(screen.getByRole('button', { name: 'Create behaviour' }));
    const heading = await screen.findByRole('heading', { name: 'Created behaviour' });
    // Radix dispatches close-auto-focus from a delayed unmount callback.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(heading);
    expect(created).toHaveBeenCalledOnce();
  });

  it.each([400, 409])(
    'a %s refusal keeps every draft choice and does not close or claim success',
    async (status) => {
      const s = setup(() =>
        Promise.reject(
          new ApiError(status, {
            error: 'refused',
            title: 'Change refused',
            message: 'Nothing was changed.',
            fields: [{ path: 'name', problem: 'too_small' }],
          }),
        ),
      );
      await s.open();
      fill();
      await s.user.click(screen.getByRole('checkbox', { name: /Club members/ }));
      await s.user.click(screen.getByRole('button', { name: 'Create behaviour' }));
      await screen.findByText('Nothing was changed.');
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe(
        ' New member help ',
      );
      expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBe(
        'true',
      );
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Mention role' }).value).toBe(
        'mention-role',
      );
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Club members/ }).checked).toBe(
        true,
      );
      expect(s.created).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeTruthy();
    },
  );

  it('a handled failure returning undefined also keeps the form draft', async () => {
    const s = setup(() => Promise.resolve(undefined));
    await s.open();
    fill();
    await s.user.click(screen.getByRole('button', { name: 'Create behaviour' }));
    expect(s.created).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe(
      ' New member help ',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps one write pending when the create action is repeated', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((done) => {
      resolve = done;
    });
    const s = setup(() => pending);
    await s.open();
    fill();
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create behaviour' });
    await s.user.click(submit);
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');
    await s.user.click(submit);
    expect(s.write).toHaveBeenCalledOnce();
    expect(s.created).not.toHaveBeenCalled();
    resolve({ ok: true });
    await waitFor(() => expect(s.created).toHaveBeenCalledOnce());
    expect(s.write).toHaveBeenCalledOnce();
  });

  it('N19 reclaims narrow dialog gutters and padding while preserving desktop framing', async () => {
    const s = setup();
    await s.open();
    const dialog = screen.getByRole('dialog');
    // Structural contract only: JSDOM does not apply responsive CSS or measure text.
    for (const token of [
      'w-[calc(100vw-1rem)]',
      'p-2',
      'sm:w-[calc(100vw-2rem)]',
      'sm:p-4',
      'max-w-[760px]',
      'max-h-[85vh]',
      'overflow-y-auto',
    ]) {
      expect(dialog.classList.contains(token), token).toBe(true);
    }
    expect(dialog.classList.contains('p-4')).toBe(false);
    expect(dialog.classList.contains('w-[calc(100vw-2rem)]')).toBe(false);
    expect(dialog.classList.contains('overflow-x-hidden')).toBe(false);
  });

  it('N19 removes narrow nested card chrome and padding without changing desktop spacing', async () => {
    const s = setup();
    await s.open();
    const formSection = screen.getByRole('region', { name: 'Create a behaviour' });
    for (const token of [
      'min-w-0',
      'sm:rounded-panel',
      'sm:border',
      'sm:border-line',
      'sm:bg-panel',
      'sm:p-3',
    ]) {
      expect(formSection.classList.contains(token), token).toBe(true);
    }
    for (const token of ['p-3', 'border', 'rounded-panel', 'overflow-hidden']) {
      expect(formSection.classList.contains(token), token).toBe(false);
    }
    expect(
      within(formSection).getAllByRole('heading', { name: 'Create a behaviour' }),
    ).toHaveLength(1);
    for (const heading of ['Basics', 'Instructions', 'Skills it may use', 'Who may use it']) {
      expect(within(formSection).getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(within(formSection).getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(within(formSection).getByRole('checkbox', { name: /Club members/ })).toBeTruthy();
    expect(within(formSection).getByRole('checkbox', { name: /Find club knowledge/ })).toBeTruthy();
    expect(within(formSection).queryByRole('checkbox', { name: /Owner private/ })).toBeNull();
    expect(within(formSection).getByText('If no role is ticked, nobody can use it.')).toBeTruthy();
    expect(within(formSection).getByRole('button', { name: 'Create behaviour' })).toBeTruthy();
    expect(within(formSection).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(s.write).not.toHaveBeenCalled();
  });

  it('declares local containment and readable stacked actions without asserting JSDOM geometry', async () => {
    const s = setup();
    await s.open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('min-w-0');
    const roles = within(dialog).getByRole('region', { name: 'Who may use the new behaviour' });
    expect(roles.className).toContain('[&_li]:min-w-0');
    expect(roles.className).toContain('[&_span]:whitespace-normal');
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement!;
    expect(footer.className).toContain('flex-col');
    expect(footer.className).toContain('flex-wrap');
  });
});
