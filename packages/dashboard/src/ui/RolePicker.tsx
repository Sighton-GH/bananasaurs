import { useCallback, useState } from 'react';
import type { GuildRoleInfo } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Field, Input } from './Field.js';

/**
 * A named role picker replacing a bare snowflake input. The guild's roles
 * come from `GET /api/guild/roles` (the live Discord cache on the daemon);
 * typing filters them by name or id and clicking one fills the control with
 * its snowflake. Pasting an id still works, and when the list itself is
 * unavailable the control says so and falls back to a plain id input.
 * Discord-managed roles are labelled so nobody reads them as assignable.
 */
export function RolePicker({
  label,
  hint,
  error,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly value: string;
  readonly onChange: (roleId: string) => void;
}) {
  const session = useSession();
  const load = useCallback(
    () => session.read<{ roles: readonly GuildRoleInfo[] }>('/api/guild/roles'),
    [session],
  );
  const { resource } = useResource('the role list', load);
  const [focused, setFocused] = useState(false);

  const roles = resource.state === 'ready' ? resource.data.roles : undefined;
  const query = value.trim().toLowerCase();
  const matches =
    roles === undefined
      ? undefined
      : roles.filter(
          (r) => query === '' || r.name.toLowerCase().includes(query) || r.roleId.includes(query),
        );
  const selected = roles?.find((r) => r.roleId === value.trim());

  return (
    <div className="text-sm">
      <Field
        label={label}
        hint={hint ?? 'Pick a role below or paste its snowflake ID.'}
        {...(error !== undefined ? { error } : {})}
      >
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Role name or ID"
          autoComplete="off"
        />
      </Field>
      {selected !== undefined && (
        <p className="mt-1 text-xs text-ink-muted">
          Selected: @{selected.name}
          {selected.managed ? ' (Discord-managed)' : ''}
        </p>
      )}
      {resource.state === 'error' && (
        <p className="mt-1 text-xs text-ink-muted">
          The role list is unavailable — paste the role ID above.
        </p>
      )}
      {resource.state === 'ready' && roles?.length === 0 && (
        <p className="mt-1 text-xs text-ink-muted">
          No roles have reached the bot&apos;s cache yet — paste the role ID above.
        </p>
      )}
      {matches !== undefined && matches.length > 0 && (focused || query === '') && (
        <ul
          aria-label={`${label} choices`}
          className="mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded-sm border border-line bg-panel"
        >
          {matches.map((r) => (
            <li key={r.roleId}>
              <button
                type="button"
                // onMouseDown runs before the input's blur, so a click still
                // lands when the list is about to hide.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(r.roleId);
                  setFocused(false);
                }}
                className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left text-ink hover:bg-canvas"
              >
                <span className="truncate">
                  @{r.name}
                  {r.managed ? (
                    <span className="text-xs text-ink-muted"> (Discord-managed)</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">{r.roleId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
