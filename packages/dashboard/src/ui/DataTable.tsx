import type { ReactNode } from 'react';

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /** Right-aligns the column; numbers already render with tabular figures. */
  readonly numeric?: boolean;
}

/**
 * Tables where the data is tabular (ADR 0043 D4): hairline rows, no zebra, a
 * visually hidden caption so screen readers know what the table is. Callers
 * decide emptiness before rendering this — an empty table is a `DataState`
 * concern, not a table one.
 *
 * Below the `sm` breakpoint a row is a card, not a sideways scroll: cells
 * stack, each labelled by its column header through a `data-label`
 * pseudo-element (no extra DOM text, so queries see one copy of a header),
 * and an unlabelled column such as an actions cell renders its controls
 * full-width. A table that genuinely cannot stack still has `overflow-x-auto`
 * as the fallback, not the plan.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly caption: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm max-sm:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="max-sm:hidden">
          <tr className="border-b border-line text-left text-ink-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`whitespace-nowrap px-2 py-1.5 font-normal ${c.numeric === true ? 'text-right' : ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-line max-sm:mb-3 max-sm:block max-sm:rounded-lg max-sm:border max-sm:p-1.5"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  {...(typeof c.header === 'string' && c.header !== ''
                    ? { 'data-label': c.header }
                    : {})}
                  className={`px-2 py-1.5 align-top max-sm:block max-sm:px-1.5 max-sm:py-1 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-xs max-sm:before:text-ink-muted max-sm:before:content-[attr(data-label)] ${c.numeric === true ? 'text-right max-sm:text-left' : ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
