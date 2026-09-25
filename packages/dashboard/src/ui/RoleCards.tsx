import { useRef, type KeyboardEvent } from 'react';
import {
  ACCOUNT_ROLES,
  CAPABILITIES,
  CAPABILITY_INFO,
  type AccountRoleId,
  type Capability,
} from '@bananasaurs/core';

const ORDER: readonly AccountRoleId[] = ['viewer', 'moderator', 'server-manager', 'custom'];

const labelFor = (role: AccountRoleId): string =>
  role === 'custom'
    ? 'Custom'
    : (ACCOUNT_ROLES.find((r) => r.id === role)?.label ?? role);

const descriptionFor = (role: AccountRoleId): string =>
  role === 'custom'
    ? 'Pick individual permissions below.'
    : (ACCOUNT_ROLES.find((r) => r.id === role)?.description ?? '');

const capabilitiesFor = (
  role: AccountRoleId,
  custom: readonly Capability[],
): readonly Capability[] =>
  role === 'custom'
    ? custom
    : (ACCOUNT_ROLES.find((r) => r.id === role)?.capabilities ?? []);

/**
 * The role picker shared by the Add account and Edit account pages (ADR 0069):
 * one card per preset plus Custom, which reveals every permission as a
 * checkbox. Cards are real radios in a radiogroup — arrow keys, Home and End
 * move between them — and every label is plain words from `CAPABILITY_INFO`;
 * capability ids appear only in `title` attributes, never as visible text.
 */
export function RoleCards({
  value,
  capabilities,
  onChange,
  disabled = false,
}: {
  readonly value: AccountRoleId;
  /** The currently selected capabilities (the preset's set, or the custom picks). */
  readonly capabilities: readonly Capability[];
  readonly onChange: (
    role: AccountRoleId,
    capabilities: readonly Capability[],
  ) => void;
  readonly disabled?: boolean;
}) {
  const radioRefs = useRef<(HTMLDivElement | null)[]>([]);

  const select = (role: AccountRoleId): void => {
    if (disabled) return;
    onChange(role, capabilitiesFor(role, capabilities));
  };

  const onGroupKeyDown = (event: KeyboardEvent): void => {
    const at = ORDER.indexOf(value);
    let next: AccountRoleId | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = ORDER[(at + 1) % ORDER.length];
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = ORDER[(at - 1 + ORDER.length) % ORDER.length];
    } else if (event.key === 'Home') {
      next = ORDER[0];
    } else if (event.key === 'End') {
      next = ORDER[ORDER.length - 1];
    }
    if (next !== undefined) {
      event.preventDefault();
      select(next);
      radioRefs.current[ORDER.indexOf(next)]?.focus();
    }
  };

  const toggle = (capability: Capability, checked: boolean): void => {
    if (disabled) return;
    onChange(
      'custom',
      checked ? [...capabilities, capability] : capabilities.filter((c) => c !== capability),
    );
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Role"
        onKeyDown={onGroupKeyDown}
        className="grid gap-2 sm:grid-cols-2"
      >
        {ORDER.map((role, index) => {
          const checked = value === role;
          return (
            <div
              key={role}
              ref={(node) => {
                radioRefs.current[index] = node;
              }}
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              tabIndex={disabled ? -1 : checked ? 0 : -1}
              onClick={() => select(role)}
              onKeyDown={(event) => {
                if ((event.key === ' ' || event.key === 'Enter') && !disabled) {
                  event.preventDefault();
                  select(role);
                }
              }}
              className={`cursor-pointer rounded-md border p-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink ${
                checked ? 'border-ink bg-canvas' : 'border-line bg-panel'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <p className="text-sm font-medium text-ink">{labelFor(role)}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{descriptionFor(role)}</p>
            </div>
          );
        })}
      </div>
      {value === 'custom' && (
        <fieldset className="mt-3 grid gap-2 rounded-sm border border-line p-2">
          <legend className="px-1 text-xs text-ink-muted">
            Permissions — pick each one this account needs
          </legend>
          {CAPABILITIES.map((capability) => {
            const info = CAPABILITY_INFO[capability];
            return (
              <label key={capability} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={info.label}
                  checked={capabilities.includes(capability)}
                  disabled={disabled}
                  onChange={(event) => toggle(capability, event.target.checked)}
                />
                <span>
                  <span title={capability} className="font-medium text-ink">
                    {info.label}
                  </span>
                  <span className="block text-xs text-ink-muted">{info.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
