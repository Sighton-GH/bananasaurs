import { useCallback, useRef, useState } from 'react';
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
  const root = useRef<HTMLDivElement>(null);

  const channels = resource.state === 'ready' ? resource.data.channels : undefined;
  const wanted = kinds ?? ['text', 'announcement', 'forum'];
  const selected = channels?.find((c) => wanted.includes(c.kind) && c.channelId === value.trim());
  // A chosen channel keeps its name and id in the box ("#general (123...)");
  // anything else is the user's search text. Editing the shown text leaves a
  // string that is no longer a channel id, so the search works on the name part.
  const shown = selected !== undefined ? `#${selected.name} (${selected.channelId})` : value;
  const query =
    selected !== undefined
      ? ''
      : (value.trim().replace(/^#/, '').split(' (')[0] ?? '').trim().toLowerCase();
  const matches =
    channels === undefined
      ? undefined
      : channels.filter(
          (c) => wanted.includes(c.kind) && (query === '' || c.name.toLowerCase().includes(query)),
        );

  return (
    <div
      ref={root}
      className="text-sm"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // A Tab or touch move into a choice must not remove it before click.
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <Field
        label={label}
        hint={hint ?? 'Search by channel name and choose a result.'}
        {...(error !== undefined ? { error } : {})}
      >
        <Input
          onClick={() => setFocused(true)}
          value={shown}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            // Typing over a chosen channel should replace it, not append to it.
            if (selected !== undefined) e.currentTarget.select();
          }}
          placeholder="Search channel names"
          autoComplete="off"
        />
      </Field>
      {resource.state === 'error' && (
        <p className="mt-1 text-xs text-ink-muted">
          The channel list is unavailable. Try again after Discord reconnects.
        </p>
      )}
      {resource.state === 'ready' && channels?.length === 0 && (
        <p className="mt-1 text-xs text-ink-muted">
          No channels are available yet. Check the bot's channel access.
        </p>
      )}
      {matches !== undefined && matches.length > 0 && (focused || value.trim() === '') && (
        <ul
          aria-label={`${label} choices`}
          className="mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded-sm border border-line bg-panel"
        >
          {matches.map((c) => (
            <li key={c.channelId}>
              <button
                type="button"
                // Keep pointer focus on the input, but let the native click
                // handle mouse, touch, Enter and Space exactly once.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c.channelId);
                  root.current?.querySelector('input')?.focus();
                  // Close after focus returns so the next Tab reaches the form
                  // action instead of reopening the in-flow choice list.
                  setFocused(false);
                }}
                className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left text-ink hover:bg-canvas"
              >
                <span className="truncate">
                  #{c.name} <span className="text-xs text-ink-muted">{c.kind}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
