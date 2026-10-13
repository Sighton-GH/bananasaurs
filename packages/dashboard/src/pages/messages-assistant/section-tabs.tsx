import { useLocation, useSearch } from 'wouter';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import type { ReactNode } from 'react';

/** Query-backed sections. Children stay mounted so drafts and resource state survive. */
export function useSections(options: readonly { value: string; label: string }[]) {
  const [path, navigate] = useLocation();
  const query = useSearch();
  const selected = new URLSearchParams(query).get('tab');
  const value = options.some((option) => option.value === selected) ? selected! : 'all';
  const render = (children: ReactNode) => (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const params = new URLSearchParams(query);
        if (next === 'all') params.delete('tab');
        else params.set('tab', next);
        navigate(
          `${path}${params.size === 0 ? '' : `?${params.toString()}`}${window.location.hash}`,
        );
      }}
      tabs={options}
      aria-label="Page sections"
    >
      <TabPanel value={value}>{children}</TabPanel>
    </Tabs>
  );
  return { value, render };
}

export function KeptSection({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return <div hidden={hidden}>{children}</div>;
}
