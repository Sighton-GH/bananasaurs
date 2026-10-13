import type { Resource } from '../../../hooks/useResource.js';
import { DataState } from '../../../ui/DataState.js';
import type { GuildRoleInfo, GuildEmojiInfo } from '../../../api/ops.js';
import type { DraftOption } from './index.js';
import { FormSection } from '../../../ui/FormSection.js';
import { Button } from '../../../ui/Button.js';
import { Field, Input } from '../../../ui/Field.js';
import { EmojiPicker } from '../../../ui/EmojiPicker.js';
import { Select } from '../../../ui/Select.js';

export function BuilderOptions({
  isReaction,
  options,
  roleList,
  customEmojis,
  updateOption,
  onRemove,
  onAdd,
  rolesResource,
  errorFor,
  optionsError,
}: {
  isReaction: boolean;
  options: readonly DraftOption[];
  roleList: readonly GuildRoleInfo[] | undefined;
  customEmojis: readonly GuildEmojiInfo[];
  updateOption: (index: number, patch: Partial<DraftOption>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  errorFor: (path: string) => string | undefined;
  optionsError: string | undefined;
  rolesResource: Resource<{ roles: readonly GuildRoleInfo[] }>;
}) {
  return (
    <div id="field-options" tabIndex={-1}>
      <FormSection title="Options">
        <DataState resource={rolesResource}>
          {() => (roleList?.length === 0 ? <p>No roles are available in this server.</p> : null)}
        </DataState>
        {optionsError !== undefined && (
          <p className="text-small text-tone-danger-ink">{optionsError}</p>
        )}
        {options.map((option, index) => (
          <div
            key={option.optionId}
            className={`grid items-center gap-2 rounded-sm border border-line p-2 ${
              isReaction ? 'sm:grid-cols-[1.4fr_auto_auto]' : 'sm:grid-cols-[1.4fr_1fr_auto_auto]'
            }`}
          >
            <Field
              label={`Option ${String(index + 1)} role`}
              htmlFor={`field-options-${index}-roleId`}
              {...(errorFor(`options.${index}.roleId`) === undefined
                ? {}
                : { error: errorFor(`options.${index}.roleId`)! })}
            >
              <Select
                aria-label={`Option ${String(index + 1)} role`}
                value={option.roleId || '__none'}
                onValueChange={(value) =>
                  updateOption(index, { roleId: value === '__none' ? '' : value })
                }
                options={[
                  { value: '__none', label: 'Choose a role' },
                  ...(roleList ?? []).map((role) => ({
                    value: role.roleId,
                    label:
                      role.name +
                      (role.optionable
                        ? ''
                        : role.managed
                          ? ' (Discord-managed)'
                          : " (above the bot's role)"),
                    disabled: !role.optionable,
                  })),
                ]}
              />
            </Field>
            {!isReaction && (
              <Field
                label={`Option ${String(index + 1)} label`}
                htmlFor={`field-options-${index}-label`}
                {...(errorFor(`options.${index}.label`) === undefined
                  ? {}
                  : { error: errorFor(`options.${index}.label`)! })}
              >
                <Input
                  aria-label={`Option ${String(index + 1)} label`}
                  value={option.label}
                  onChange={(e) => updateOption(index, { label: e.target.value })}
                  placeholder="label"
                  autoComplete="off"
                />
              </Field>
            )}
            <EmojiPicker
              label={`Option ${String(index + 1)} emoji`}
              value={option.emoji}
              onChange={(emoji) => updateOption(index, { emoji })}
              customEmojis={customEmojis}
              clearable={!isReaction}
            />
            <Button onClick={() => onRemove(index)} disabled={options.length === 1}>
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button onClick={onAdd} disabled={options.length >= 25}>
            Add option
          </Button>
        </div>
      </FormSection>
    </div>
  );
}
