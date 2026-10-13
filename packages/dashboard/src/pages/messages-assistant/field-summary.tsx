import { ErrorSummary } from '../../ui/ErrorSummary.js';
/** Coalesce errors routed to one actual control/group without dropping messages. */
export function mappedErrors(
  errors: readonly { fieldId: string; message: string }[],
  target: (id: string) => string,
) {
  const groups = new Map<string, string[]>();
  for (const error of errors) {
    const id = target(error.fieldId);
    groups.set(id, [...(groups.get(id) ?? []), error.message]);
  }
  return [...groups].map(([fieldId, messages]) => ({ fieldId, message: messages.join(' ') }));
}
export function GroupErrors({
  errors,
  id,
  direct = {},
}: {
  errors: readonly { fieldId: string; message: string }[];
  id: string;
  direct?: Readonly<Record<string, string>>;
}) {
  return <ErrorSummary errors={mappedErrors(errors, (field) => direct[field] ?? id)} />;
}
