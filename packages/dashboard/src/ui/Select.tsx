import * as RadixSelect from '@radix-ui/react-select';
import type { ReactElement } from 'react';
import { Icon, IconCheck, IconChevronDown } from './icons.js';
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}
/**
 * The dashboard's one select (docs/28 §7.4). Radix supplies the keyboard model.
 * Empty-string item values are forbidden by Radix; use '__none' for a none option.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Choose…',
  disabled,
  id,
  ...aria
}: {
  readonly value: string | undefined;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
}): ReactElement {
  return (
    <RadixSelect.Root
      value={value ?? ''}
      onValueChange={onValueChange}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <RadixSelect.Trigger
        id={id}
        {...aria}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-control border bg-panel px-3 text-left text-body text-ink focus-visible:outline-accent data-[placeholder]:text-ink-faint disabled:opacity-50 ${aria['aria-invalid'] === true ? 'border-tone-danger' : 'border-line-strong'}`}
      >
        <span className="min-w-0 flex-1 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0">
          <Icon icon={IconChevronDown} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] max-w-[min(var(--radix-select-content-available-width),calc(100vw-1rem))] overflow-hidden [overflow-wrap:anywhere] rounded-control border border-line bg-panel shadow-float"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                {...(o.disabled === undefined ? {} : { disabled: o.disabled })}
                className="relative flex cursor-default select-none flex-col rounded-sm py-1.5 pr-2 pl-7 text-body text-ink outline-none whitespace-normal data-[disabled]:opacity-50 data-[highlighted]:bg-accent-bg"
              >
                <RadixSelect.ItemIndicator className="absolute left-2 top-2">
                  <Icon icon={IconCheck} />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                {o.description !== undefined && (
                  <span className="text-caption text-ink-muted">{o.description}</span>
                )}
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
