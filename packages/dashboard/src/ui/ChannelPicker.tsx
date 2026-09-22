import { useCallback, useState } from 'react';
import type { GuildChannelInfo } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Field, Input } from './Field.js';

/**
 * A named channel picker replacing a bare snowflake input. The guild's
 * channels come from `GET /api/guild/channels` (the live Discord cache on the
 * daemon); typing filters them by name or id and clicking one fills the
 * control with its snowflake. Pasting an id still works - a channel that has
 * not reached the cache yet is usable, and when the list itself is
 * unavailable the control says so and falls back to a plain id input.
 */
export function ChannelPicker({
  label,
  hint,
  error,
  value,
  onChange,
  kinds,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly value: string;
  readonly onChange: (channelId: string) => void;
  /**
   * Which channel kinds the list offers. Defaults to the text-capable kinds,
   * so a caller that wants categories (archive scope, send allowlist) says
   * so; pasting an id bypasses the filter as before.
   */
  readonly kinds?: readonly string[] | undefined;
}) {
  const session = useSession();
  const load = useCallback(
    () => session.read<{ channels: readonly GuildChannelInfo[] }>('/api/guild/channels'),
    [session],
  );
  const { resource } = useResource('the channel list', load);
  const [focused, setFocused] = useState(false);

  const channels = resource.state === 'ready' ? resource.data.channels : undefined;
  const query = value.trim().toLowerCase();
  const wanted = kinds ?? ['text', 'announcement', 'forum'];
  const matches =
    channels === undefined
      ? undefined
      : channels.filter(
          (c) =>
            wanted.includes(c.kind) &&
            (query === '' || c.name.toLowerCase().includes(query) || c.channelId.includes(query)),
        );
  const selected = channels?.find((c) => wanted.includes(c.kind) && c.channelId === value.trim());

  return (
    <div className="text-sm">
      <Field
        label={label}
        hint={hint ?? 'Pick a channel below or paste its snowflake ID.'}
        {...(error !== undefined ? { error } : {})}
      >
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Channel name or ID"
          autoComplete="off"
        />
      </Field>
      {selected !== undefined && (
        <p className="mt-1 text-xs text-ink-muted">
          Selected: #{selected.name} ({selected.kind})
        </p>
      )}
      {resource.state === 'error' && (
        <p className="mt-1 text-xs text-ink-muted">
          The channel list is unavailable — paste the channel ID above.
        </p>
      )}
      {resource.state === 'ready' && channels?.length === 0 && (
        <p className="mt-1 text-xs text-ink-muted">
          No channels have reached the bot&apos;s cache yet — paste the channel ID above.
        </p>
      )}
      {matches !== undefined && matches.length > 0 && (focused || query === '') && (
        <ul
          aria-label={`${label} choices`}
          className="mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded-sm border border-line bg-panel"
        >
          {matches.map((c) => (
            <li key={c.channelId}>
              <button
                type="button"
                // onMouseDown runs before the input's blur, so a click still
                // lands when the list is about to hide.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(c.channelId);
                  // Close the list on a pick: it sits in flow, so staying
                  // open pushes the submit button down and the next click's
                  // blur-and-shift eats the click entirely.
                  setFocused(false);
                }}
                className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left text-ink hover:bg-canvas"
              >
                <span className="truncate">
                  #{c.name} <span className="text-xs text-ink-muted">{c.kind}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-muted">{c.channelId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
