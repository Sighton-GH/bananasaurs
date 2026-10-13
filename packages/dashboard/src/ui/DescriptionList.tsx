import type { ReactElement, ReactNode } from 'react';
export function DescriptionList(props: {
  items: readonly { term: string; value: ReactNode }[];
  columns?: 1 | 2;
}): ReactElement {
  return (
    <dl className={`grid gap-x-6 gap-y-3 ${props.columns === 2 ? 'sm:grid-cols-2' : ''}`}>
      {props.items.map((item, index) => (
        <div key={index} className="min-w-0 break-words">
          <dt className="text-caption text-ink-muted">{item.term}</dt>
          <dd className="text-body">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
