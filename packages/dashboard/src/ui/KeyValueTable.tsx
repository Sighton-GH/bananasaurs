import type { ReactElement, ReactNode } from 'react';
import { humanise } from '../lib/humanise.js';
import { CodeBlock } from './CodeBlock.js';
export type KeyValue =
  string | number | boolean | null | readonly KeyValue[] | { readonly [k: string]: KeyValue };
type Data = { readonly [k: string]: KeyValue };

function scalar(value: string | number | boolean | null): string {
  if (value === null) return '\u2014';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'number' ? value.toLocaleString() : value;
}
function isArray(value: KeyValue): value is readonly KeyValue[] {
  return Array.isArray(value);
}
const WRAP = '[overflow-wrap:anywhere]';
function renderValue(value: KeyValue, depth: number, label: string): ReactNode {
  if (value === null || typeof value !== 'object') return scalar(value);
  if (depth > 4)
    return <CodeBlock code={JSON.stringify(value, null, 2)} label={label} language="json" />;
  if (isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return value.map((item) => scalar(item)).join(', ');
    }
    return (
      <div className="grid min-w-0 gap-3">
        {value.map((item, index) => (
          <div key={index} className="min-w-0">
            {renderValue(item, depth + 1, `${label} ${index + 1}`)}
          </div>
        ))}
      </div>
    );
  }
  return <Group data={value} depth={depth} />;
}
function Group(props: { data: Data; depth: number }): ReactElement {
  const entries = Object.entries(props.data);
  if (entries.length === 0) return <>{scalar(null)}</>;
  return (
    <dl className="m-0 grid min-w-0 gap-2 border-l border-line pl-3">
      {entries.map(([key, value]) => {
        const label = humanise(key);
        return (
          <div key={key} className="min-w-0">
            <dt className={`text-caption font-medium text-ink-muted ${WRAP}`}>{label}</dt>
            <dd className={`m-0 min-w-0 tabular-nums ${WRAP}`}>
              {renderValue(value, props.depth + 1, label)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
function Table(props: {
  data: Data;
  depth: number;
  caption?: string;
  labels?: Readonly<Record<string, string>>;
}): ReactElement {
  return (
    <table role="table" className="w-full min-w-0 text-small max-sm:block">
      {props.caption !== undefined && (
        <caption className="text-left text-caption text-ink-muted max-sm:block">
          {props.caption}
        </caption>
      )}
      <tbody role="rowgroup" className="max-sm:block">
        {Object.entries(props.data).map(([key, value]) => {
          const label = props.labels?.[key] ?? humanise(key);
          return (
            <tr key={key} role="row" className="max-sm:block max-sm:border-t max-sm:border-line">
              <th
                role="rowheader"
                scope="row"
                className={`border-t border-line bg-sunk px-3 py-1.5 text-left align-top font-medium text-ink-muted max-sm:block max-sm:border-t-0 ${WRAP}`}
              >
                {label}
              </th>
              <td
                role="cell"
                className={`min-w-0 border-t border-line px-3 py-1.5 align-top tabular-nums max-sm:block max-sm:border-t-0 ${WRAP}`}
              >
                {renderValue(value, props.depth + 1, label)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
export function KeyValueTable(props: {
  data: Data;
  caption?: string;
  labels?: Readonly<Record<string, string>>;
}): ReactElement {
  return <Table {...props} depth={0} />;
}
