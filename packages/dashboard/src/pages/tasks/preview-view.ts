import type { TaskAudience, TaskCardView, TaskStatus } from '@bananasaurs/core';
import { zonedLocalToUtc } from '../../lib/zoned-time.js';

export type PreviewLink = { readonly label: string; readonly url: string };

/**
 * `YYYY-MM-DDTHH:mm` in `timeZone` to UTC ms, or `undefined` when the input is
 * empty, incomplete or not a real zone. The page never lets a half-typed due
 * date throw while it draws the preview.
 */
export const guardedDueAt = (local: string, timeZone: string): number | undefined => {
  if (local === '') return undefined;
  try {
    const ms = zonedLocalToUtc(local, timeZone);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
};

/** A link row is drawn only when it is complete and https, the way the server would keep it. */
export const previewLinks = (rows: readonly { label: string; url: string }[]): PreviewLink[] =>
  rows
    .map((row) => ({ label: row.label.trim(), url: row.url.trim() }))
    .filter((row) => {
      if (row.label === '' || row.url === '' || !row.url.startsWith('https://')) return false;
      try {
        return new URL(row.url).protocol === 'https:';
      } catch {
        return false;
      }
    })
    .slice(0, 5);

/** Placeholder values for an unsaved task. They exist only in this inert picture and never in a request body. */
export const PREVIEW_ONLY = { taskId: 'preview', version: 1 } as const;

export type PreviewInput = {
  readonly title: string;
  readonly description: string;
  readonly teamName: string;
  readonly priority: 'normal' | 'urgent';
  /** Known, validated UTC ms. Unknown due times do not render a card. */
  readonly dueAt: number;
  readonly audience: TaskAudience;
  readonly links: readonly PreviewLink[];
  readonly now: number;
  /** A saved task passes its real values; a new one uses the placeholders. */
  readonly saved?: {
    readonly taskId: string;
    readonly version: number;
    readonly status: TaskStatus;
    readonly updatedAt: number;
  };
};

/**
 * The card view `renderTaskCard` needs, built from what the page already knows.
 * An unsaved task previews the first post (`announce`); a saved one previews
 * the refreshed card. An empty title or team shows a neutral stand-in rather
 * than nothing, so the preview keeps its shape while the form is being filled.
 */
export const buildPreviewView = (input: PreviewInput): TaskCardView => ({
  taskId: input.saved?.taskId ?? PREVIEW_ONLY.taskId,
  version: input.saved?.version ?? PREVIEW_ONLY.version,
  title: input.title.trim() === '' ? 'Untitled task' : input.title.trim(),
  description: input.description,
  teamName: input.teamName === '' ? 'Team' : input.teamName,
  status: input.saved?.status ?? 'not_started',
  priority: input.priority,
  dueAt: input.dueAt,
  now: input.now,
  audience: input.audience,
  links: input.links,
  updatedAt: input.saved?.updatedAt ?? input.now,
  variant: input.saved === undefined ? 'announce' : 'refresh',
});
