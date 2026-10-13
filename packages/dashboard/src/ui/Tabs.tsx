import {
  createContext,
  useContext,
  useRef,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
const SelectedTab = createContext<string | undefined>(undefined);
import * as Radix from '@radix-ui/react-tabs';

/** Reveal a focused tab by moving only the tablist's own scrollLeft (instant, no page jump). */
function revealTab(list: HTMLElement, tab: HTMLElement): void {
  const listBox = list.getBoundingClientRect();
  const tabBox = tab.getBoundingClientRect();
  const hiddenRight = tabBox.right - listBox.right;
  const hiddenLeft = listBox.left - tabBox.left;
  if (hiddenRight > 0) list.scrollLeft += hiddenRight;
  else if (hiddenLeft > 0) list.scrollLeft -= hiddenLeft;
}

export function Tabs(props: {
  value: string;
  onValueChange: (v: string) => void;
  tabs: readonly { value: string; label: string; badge?: ReactNode }[];
  children: ReactNode;
  'aria-label': string;
}): ReactElement {
  const byKeyboard = useRef(false);
  const reveal = (event: FocusEvent<HTMLElement>): void => {
    if (!byKeyboard.current) return;
    const list = event.currentTarget.parentElement;
    if (list) revealTab(list, event.currentTarget);
  };
  return (
    <SelectedTab.Provider value={props.value}>
      <Radix.Root
        value={props.value}
        onValueChange={props.onValueChange}
        activationMode="automatic"
      >
        <Radix.List
          aria-label={props['aria-label']}
          onKeyDown={() => {
            byKeyboard.current = true;
          }}
          onPointerDown={() => {
            byKeyboard.current = false;
          }}
          className="flex max-w-full gap-1 overflow-x-auto border-b border-line p-1"
        >
          {props.tabs.map((tab) => (
            <Radix.Trigger
              key={tab.value}
              value={tab.value}
              onFocus={reveal}
              className="inline-flex max-w-full shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-body text-ink-muted hover:text-ink focus-visible:outline-accent focus-visible:outline-offset-[-2px] data-[state=active]:border-accent data-[state=active]:text-ink data-[state=active]:font-medium"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{tab.label}</span>
              {tab.badge !== undefined && <> {tab.badge}</>}
            </Radix.Trigger>
          ))}
        </Radix.List>
        {props.children}
      </Radix.Root>
    </SelectedTab.Provider>
  );
}

export function TabPanel(props: { value: string; children: ReactNode }): ReactElement {
  const selected = useContext(SelectedTab);
  if (selected !== props.value) return <></>;
  return (
    <Radix.Content value={props.value} className="focus-visible:outline-accent">
      {props.children}
    </Radix.Content>
  );
}
