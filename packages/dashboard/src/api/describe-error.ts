/**
 * The dashboard renders error bodies, it does not translate them (0078).
 * `describeError` turns any thrown value into one readable description; the
 * session's error toast and `<ErrorNotice>` both read it, so every failure an
 * operator sees carries the same title, message, hint and request id.
 */

import { ApiError, OfflineError } from '../api.js';

export interface DescribedError {
  readonly title: string;
  readonly message: string;
  readonly hint?: string | undefined;
  readonly code: string;
  readonly status?: number | undefined;
  readonly requestId?: string | undefined;
  readonly fields: readonly { readonly path: string; readonly problem: string }[];
}

/** The explanation for a non-JSON answer (a proxy page, a dead tunnel). */
const UNREADABLE = {
  title: "The server's answer could not be read",
  explanation:
    'Something between the browser and Bananasaurs answered with a page that is not JSON.',
  hint: 'Check that the daemon is running and the tunnel is up.',
} as const;

export const describeError: (err: unknown) => DescribedError = (err) => {
  if (err instanceof ApiError) {
    const { body } = err;
    if (body.error === 'unreadable-response') {
      return {
        title: body.title ?? UNREADABLE.title,
        message: body.message ?? UNREADABLE.explanation,
        hint: body.hint ?? UNREADABLE.hint,
        code: body.error,
        status: err.status,
        ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
        fields: body.fields ?? [],
      };
    }
    return {
      title: body.title ?? 'The request failed',
      message: body.message ?? `Bananasaurs refused the request (${body.error}).`,
      ...(body.hint !== undefined ? { hint: body.hint } : {}),
      code: body.error,
      status: err.status,
      ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
      fields: body.fields ?? [],
    };
  }
  if (err instanceof OfflineError) {
    return {
      title: 'Bananasaurs could not be reached',
      message: 'The browser could not reach the dashboard API. The daemon may be restarting.',
      hint: 'Wait a moment and try again.',
      code: 'dashboard-offline',
      fields: [],
    };
  }
  return {
    title: 'Something went wrong in this page',
    message: err instanceof Error ? err.message : String(err),
    code: 'dashboard-bug',
    fields: [],
  };
};

const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  too_small: 'Too small.',
  too_big: 'Too large.',
  invalid_type: 'Missing or the wrong kind of value.',
  invalid_string: 'Not in the right format.',
  invalid_enum_value: 'Not one of the allowed choices.',
  unrecognized_keys: 'Not a field this form accepts.',
  custom: 'Not allowed.',
};

/**
 * Human text for the first field problem at `path` (an exact match, or a
 * field whose path starts with `${path}.` so `entries` matches
 * `entries.0.rpmLimit`); `path === ''` matches the first field. Undefined
 * when nothing matches.
 */
export const fieldError: (err: unknown, path: string) => string | undefined = (err, path) => {
  const fields = err instanceof ApiError ? (err.body.fields ?? []) : [];
  const found =
    path === ''
      ? fields[0]
      : fields.find((field) => field.path === path || field.path.startsWith(`${path}.`));
  if (found === undefined) return undefined;
  return PROBLEM_TEXT[found.problem] ?? 'Not valid.';
};
