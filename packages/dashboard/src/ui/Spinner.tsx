import { Icon, IconSpinner } from './icons.js';

/** A small indeterminate spinner (docs/28 §7.7: for small regions up to 3 s). */
export function Spinner({
  label,
  size = 'sm',
}: {
  readonly label?: string;
  readonly size?: 'sm' | 'md';
}) {
  const glyph = (
    <Icon icon={IconSpinner} size={size} className="animate-spin motion-reduce:animate-none" />
  );
  if (label === undefined) return glyph;
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      {glyph}
    </span>
  );
}
