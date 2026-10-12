import type { GenerationMedia, GenerationMessage, ModelCapabilities } from '@bananasaurs/core';
import { safeAttachmentLabel } from './attachments.js';

/** Absent capabilities mean text-only (ADR 0149): safe for chains built before Slice 6. */
export const entryCanRead = (
  caps: ModelCapabilities | undefined,
  media: readonly GenerationMedia[],
): boolean => {
  if (media.length === 0) return true;
  if (caps === undefined) return false;
  return media.every((m) => (m.kind === 'image' ? caps.image : caps.pdf));
};

/** Stable preference for entries that can read everything attached (spec 4c). No media means unchanged order. */
export const orderEntriesForMedia = <
  T extends { readonly capabilities?: ModelCapabilities | undefined },
>(
  entries: readonly T[],
  media: readonly GenerationMedia[],
): readonly T[] => {
  if (media.length === 0) return entries;
  return [
    ...entries.filter((e) => entryCanRead(e.capabilities, media)),
    ...entries.filter((e) => !entryCanRead(e.capabilities, media)),
  ];
};

/**
 * Strips what the entry cannot read; one plain line per stripped file on the
 * last user message. Media only travels on user turns, so any on another role
 * is dropped. The marker uses the safe label (the raw name stays on the media
 * that is kept, for the provider file name only). Never mutates its input.
 */
export const messagesForEntry = (
  messages: readonly GenerationMessage[],
  caps: ModelCapabilities | undefined,
): GenerationMessage[] => {
  const stripped: string[] = [];
  const kept = messages.map((message): GenerationMessage => {
    const media = message.media ?? [];
    if (message.role !== 'user') {
      if (message.media === undefined) return message;
      const rest: { -readonly [K in keyof GenerationMessage]: GenerationMessage[K] } = {
        ...message,
      };
      delete rest.media;
      return rest;
    }
    const readable = media.filter((m) => entryCanRead(caps, [m]));
    if (readable.length === media.length) return message;
    for (const m of media.filter((m) => !entryCanRead(caps, [m]))) {
      const name = safeAttachmentLabel(m.name);
      stripped.push(
        m.kind === 'image'
          ? `${name} attached; you can't see images right now.`
          : `${name} attached; you can't read PDFs right now.`,
      );
    }
    return { ...message, media: readable };
  });
  if (stripped.length === 0) return kept;
  const lastUser = kept.map((m) => m.role).lastIndexOf('user');
  if (lastUser === -1) return kept;
  return kept.map((message, index) =>
    index === lastUser ? { ...message, text: `${message.text}\n${stripped.join('\n')}` } : message,
  );
};
