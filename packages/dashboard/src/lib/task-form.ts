/** Shared task form helpers: one input style and one destination label. */

export const inputClass = 'min-h-10 w-full rounded border border-line bg-canvas p-2';

export type TaskDestinationOption = {
  readonly name: string;
  readonly kind: string;
  readonly parentName?: string | undefined;
};

export const destinationLabel = (d: TaskDestinationOption): string =>
  d.kind === 'thread' && d.parentName ? `${d.parentName} › ${d.name}` : d.name;
