import { safeDisplayName } from '@bananasaurs/core';

/**
 * Raw Discord mention snowflakes carry no meaning to a provider and trip the
 * conservative outbound scan's long-digit detectors, so they are flattened to
 * readable tokens before anything leaves the process. Only the mention shape
 * is rewritten; bare numbers stay untouched. With a names map, known users and
 * roles render as `@Name` through `safeDisplayName`; unknown ids keep the old tokens.
 */
export interface MentionNames {
  readonly users?: ReadonlyMap<string, string> | undefined;
  readonly roles?: ReadonlyMap<string, string> | undefined;
}

const namedOr = (raw: string | undefined, fallback: string): string =>
  `@${safeDisplayName(raw) ?? fallback}`;

export const sanitizeMentionsForProvider = (text: string, names?: MentionNames): string =>
  text
    .replace(/<@&(\d{17,20})>/g, (_match, id: string) => namedOr(names?.roles?.get(id), 'role'))
    .replace(/<@!?(\d{17,20})>/g, (_match, id: string) => namedOr(names?.users?.get(id), 'user'))
    .replace(/<#\d{17,20}>/g, '#channel');
