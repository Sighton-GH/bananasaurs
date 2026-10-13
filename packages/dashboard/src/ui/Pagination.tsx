import type { ReactElement } from 'react';
import { Button } from './Button.js';
export function Pagination(props: {
  page: number;
  pageCount: number;
  onPageChange: (p: number) => void;
  label?: string;
}): ReactElement {
  if (props.pageCount <= 1) return <></>;
  return (
    <nav aria-label={props.label ?? 'Pages'} className="flex items-center gap-3">
      <Button disabled={props.page <= 1} onClick={() => props.onPageChange(props.page - 1)}>
        Previous
      </Button>
      <span aria-current="page" className="text-small text-ink-muted">
        Page {props.page} of {props.pageCount}
      </span>
      <Button
        disabled={props.page >= props.pageCount}
        onClick={() => props.onPageChange(props.page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}
