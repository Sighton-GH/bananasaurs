import { Button } from './Button.js';
import { Input } from './Field.js';

export type LinkRow = { label: string; url: string };

const MAX_LINKS = 5;
const LABEL_MAX = 34;
const URL_MAX = 512;

const isEmpty = (row: LinkRow) => row.label.trim() === '' && row.url.trim() === '';

/** One message per row, '' when the row is fine (docs/28 §3: name the field, say the fix). */
export const validateLinks = (rows: readonly LinkRow[]): string[] =>
  rows.map((row, index) => {
    const n = index + 1;
    if (isEmpty(row)) return '';
    const label = row.label.trim();
    const url = row.url.trim();
    if (label === '') return `Enter a label for link ${n}`;
    if (label.length > LABEL_MAX)
      return `Link ${n}: labels can be ${LABEL_MAX} characters or fewer`;
    if (url === '') return `Enter a URL for link ${n}`;
    if (url.length > URL_MAX) return `Link ${n}: URLs can be ${URL_MAX} characters or fewer`;
    let ok: boolean;
    try {
      ok = new URL(url).protocol === 'https:' && url.startsWith('https://');
    } catch {
      ok = false;
    }
    return ok ? '' : `Link ${n}: enter a URL that starts with https://`;
  });

export const cleanLinks = (rows: readonly LinkRow[]): LinkRow[] =>
  rows
    .filter((row) => !isEmpty(row))
    .map((row) => ({ label: row.label.trim(), url: row.url.trim() }));

export function LinkListEditor({
  value,
  onChange,
  errors,
  fieldErrors,
}: {
  value: readonly LinkRow[];
  onChange: (rows: LinkRow[]) => void;
  errors: readonly string[];
  /** Optional per-control messages; when set for a row they replace its single `errors` text. */
  fieldErrors?: readonly { label?: string; url?: string }[];
}) {
  const set = (index: number, patch: Partial<LinkRow>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">Links (optional, up to {MAX_LINKS})</legend>
      <p className="text-small text-ink-muted">
        Each one becomes a button on the task card. Labels can be {LABEL_MAX} characters.{' '}
        <span data-testid="link-count">
          {value.length} / {MAX_LINKS}
        </span>
      </p>
      {value.map((row, index) => {
        const n = index + 1;
        const split = fieldErrors?.[index];
        const error = split === undefined ? (errors[index] ?? '') : '';
        const labelError = split === undefined ? error : (split.label ?? '');
        const urlError = split === undefined ? error : (split.url ?? '');
        const errorId = `link-${n}-error`;
        const labelErrorId = split === undefined ? errorId : `link-${n}-label-error`;
        const urlErrorId = split === undefined ? errorId : `link-${n}-url-error`;
        return (
          <div key={index} className="grid gap-1">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
              <Input
                id={`field-links-${index}-label`}
                aria-label={`Link ${n} label`}
                maxLength={LABEL_MAX}
                value={row.label}
                placeholder="Label"
                onChange={(e) => set(index, { label: e.target.value })}
                aria-invalid={labelError !== '' ? 'true' : undefined}
                aria-describedby={labelError !== '' ? labelErrorId : undefined}
              />
              <Input
                id={`field-links-${index}-url`}
                aria-label={`Link ${n} URL`}
                type="url"
                inputMode="url"
                value={row.url}
                placeholder="https://"
                onChange={(e) => set(index, { url: e.target.value })}
                aria-invalid={urlError !== '' ? 'true' : undefined}
                aria-describedby={urlError !== '' ? urlErrorId : undefined}
              />
              <Button onClick={() => onChange(value.filter((_, i) => i !== index))}>
                Remove link {n}
              </Button>
            </div>
            {split === undefined && error !== '' && (
              <p id={errorId} role="alert" className="text-small text-tone-danger-ink">
                {error}
              </p>
            )}
            {split !== undefined && labelError !== '' && (
              <p id={labelErrorId} role="alert" className="text-small text-tone-danger-ink">
                {labelError}
              </p>
            )}
            {split !== undefined && urlError !== '' && (
              <p id={urlErrorId} role="alert" className="text-small text-tone-danger-ink">
                {urlError}
              </p>
            )}
          </div>
        );
      })}
      {value.length < MAX_LINKS && (
        <Button
          onClick={() => onChange([...value, { label: '', url: '' }])}
          className="justify-self-start"
        >
          Add link
        </Button>
      )}
    </fieldset>
  );
}
