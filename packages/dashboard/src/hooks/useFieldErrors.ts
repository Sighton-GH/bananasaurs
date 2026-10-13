import { useState } from 'react';
import { describeError, readableFieldProblem } from '../api/describe-error.js';

type FieldProblem = { readonly path: string; readonly problem: string };

/** Exact field identity with readable codes and preserved human instructions. */
export function useFieldErrors(): {
  readonly capture: (error: unknown) => boolean;
  readonly errorFor: (path: string) => string | undefined;
  readonly summary: readonly { fieldId: string; message: string }[];
  readonly clear: (path?: string) => void;
} {
  const [fields, setFields] = useState<readonly FieldProblem[]>([]);
  return {
    capture(error) {
      // A thrown unknown can even refuse String conversion (e.g. a null-prototype
      // object). It has no describable field errors; it must still clear stale ones.
      let next: readonly FieldProblem[] = [];
      try {
        next = describeError(error).fields.map((field) => ({
          ...field,
          problem: readableFieldProblem(field.problem),
        }));
      } catch {
        /* No field description. */
      }
      setFields(next);
      return next.length > 0;
    },
    errorFor: (path) => fields.find((field) => field.path === path)?.problem,
    summary: fields.map((field) => ({
      fieldId: `field-${field.path.replaceAll('.', '-')}`,
      message: field.problem,
    })),
    clear: (path) =>
      setFields((current) =>
        path === undefined ? [] : current.filter((field) => field.path !== path),
      ),
  };
}
