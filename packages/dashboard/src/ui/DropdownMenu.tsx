import type { ReactElement } from 'react';
import * as Radix from '@radix-ui/react-dropdown-menu';
import { Button } from './Button.js';
import { Icon, IconMore } from './icons.js';
import { Tooltip, TooltipProvider } from './Tooltip.js';

export function DropdownMenu(props: {
  label: string;
  onCloseAutoFocus?: (event: Event) => void;
  items: readonly (
    { label: string; onSelect: () => void; tone?: 'danger'; disabled?: boolean } | 'separator'
  )[];
}): ReactElement {
  return (
    <TooltipProvider>
      <Radix.Root>
        <Tooltip content={props.label}>
          <Radix.Trigger asChild>
            <Button variant="subtle" size="sm" aria-label={props.label}>
              <Icon icon={IconMore} />
            </Button>
          </Radix.Trigger>
        </Tooltip>
        <Radix.Portal>
          <Radix.Content
            sideOffset={4}
            onCloseAutoFocus={props.onCloseAutoFocus}
            className="z-50 rounded-control border border-line bg-panel p-1 shadow-float"
          >
            {props.items.map((item, index) =>
              item === 'separator' ? (
                <Radix.Separator key={index} className="my-1 border-t border-line" />
              ) : (
                <Radix.Item
                  key={index}
                  disabled={item.disabled === true}
                  onSelect={item.onSelect}
                  className={`rounded-sm px-2 py-1.5 text-body focus-visible:outline-accent data-[highlighted]:bg-accent-bg data-[disabled]:opacity-50 ${item.tone === 'danger' ? 'text-danger' : 'text-ink'}`}
                >
                  {item.label}
                </Radix.Item>
              ),
            )}
          </Radix.Content>
        </Radix.Portal>
      </Radix.Root>
    </TooltipProvider>
  );
}
