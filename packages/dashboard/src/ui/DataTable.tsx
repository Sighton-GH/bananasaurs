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
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-2 py-1.5 font-normal ${c.numeric === true ? 'text-right' : ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 align-top ${c.numeric === true ? 'text-right' : ''}`}>
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
