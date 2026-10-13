import * as Radix from '@radix-ui/react-tabs';
import { useRef, type ReactNode } from 'react';

/**
 * The URL for choosing a tab: everything else in the current browser
 * location (other query fields, the hash) is kept. `defaultTab` drops the
 * `tab` field so the default tab has the plain URL.
 */
export function tabHref(next: string, defaultTab?: string): string {
  const url = new URL(window.location.href);
  if (next === defaultTab) url.searchParams.delete('tab');
  else url.searchParams.set('tab', next);
  return url.pathname + url.search + url.hash;
}

/**
 * Tab panels that stay mounted once visited. The shared `TabPanel` unmounts
 * an inactive body, which would drop a draft, a pending write or a Try
 * answer when the user flips tabs. Here a visited panel is force-mounted and
 * hidden while inactive; a panel never visited is not rendered, so nothing
 * loads or runs until its tab is opened. Mount this component with a key
 * that names the record, so another record starts with nothing visited.
 */
export function VisitedPanels({
  active,
  panels,
}: {
  readonly active: string;
  readonly panels: readonly { readonly value: string; readonly body: ReactNode }[];
}) {
  const visited = useRef(new Set<string>());
  visited.current.add(active);
  return (
    <>
      {panels
        .filter((panel) => visited.current.has(panel.value))
        .map((panel) => (
          <Radix.Content
            key={panel.value}
            value={panel.value}
            forceMount
            hidden={panel.value !== active}
            className="focus-visible:outline-accent"
          >
            {panel.body}
          </Radix.Content>
        ))}
    </>
  );
}
