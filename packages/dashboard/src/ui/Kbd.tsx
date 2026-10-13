import type { ReactElement, ReactNode } from 'react';
export function Kbd({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <kbd className="rounded-sm border border-line-strong bg-sunk px-1 font-mono text-caption">
      {children}
    </kbd>
  );
}
