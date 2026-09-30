import { parseSnowflakeId } from '@bananasaurs/core';
import type { McpGuildChannel, McpGuildRole } from './tools/guild.js';
import { safeName } from './structured.js';

export type Resolved =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly message: string };

const isSnowflake = (ref: string): boolean => {
  try {
    parseSnowflakeId(ref);
    return true;
  } catch {
    return false;
  }
};

const stripPrefix = (ref: string, prefix: string): string => {
  const trimmed = ref.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
};

const resolveRef = (
  names: readonly { readonly id: string; readonly name: string }[],
  ref: string,
  kind: 'channel' | 'role',
): Resolved => {
  if (isSnowflake(ref)) return { ok: true, id: ref };
  const shown = safeName(ref);
  const needle = (
    kind === 'channel' ? stripPrefix(ref, '#') : stripPrefix(ref, '@')
  ).trim().toLowerCase();
  const matches = names
    .filter((entry) => entry.name.toLowerCase() === needle)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) throw new Error('unreachable');
    return { ok: true, id: only.id };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      message:
        kind === 'channel'
          ? `No channel named "${shown}" in this guild.`
          : `No role named "${shown}" in this guild.`,
    };
  }
  const list = matches
    .slice(0, 10)
    .map((entry) => `${safeName(entry.name)} (${entry.id})`)
    .join(', ');
  const noun = kind === 'channel' ? 'channels' : 'roles';
  return { ok: false, message: `"${shown}" matches ${String(matches.length)} ${noun}: ${list}. Pass an id.` };
};

/** A snowflake passes through unchanged (existence is the caller's business). Otherwise strip one leading '#', trim, compare case-insensitively to channel names. */
export const resolveChannelRef: (
  channels: readonly McpGuildChannel[],
  ref: string,
) => Resolved = (channels, ref) => resolveRef(channels, ref, 'channel');

/** Same for roles; strips one leading '@'. */
export const resolveRoleRef: (roles: readonly McpGuildRole[], ref: string) => Resolved = (
  roles,
  ref,
) => resolveRef(roles, ref, 'role');
