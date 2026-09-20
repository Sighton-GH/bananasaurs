import type { SVGProps } from 'react';

function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" {...props}>
      <path
        d="M7 23.5C9.3 13.2 18.7 7 31.8 9.1c-1.2 11.8-8.6 20.6-19 22.2-3.7.5-6.7-3.4-5.8-7.8Z"
        fill="currentColor"
      />
      <path
        d="M13 24.7c4.2-.6 8-2.6 11.3-6.1M18.6 13.6c1.7 1.4 3.1 3.1 4.1 5.1"
        fill="none"
        stroke="var(--color-canvas)"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

export function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-ink text-canvas">
        <Mark className="size-7" />
      </span>
      {!compact && (
        <div className="min-w-0 leading-none">
          <p className="truncate text-base font-semibold tracking-[-0.02em]">Bananasaurs</p>
          <p className="mt-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-ink-muted">
            Operator console
          </p>
        </div>
      )}
    </div>
  );
}
