import type { PanelBehaviour, PanelComponent } from '@bananasaurs/core';
import { FormSection } from '../../../ui/FormSection.js';
import { RadioGroup } from '../../../ui/RadioGroup.js';
export const BEHAVIOURS: readonly { value: PanelBehaviour; label: string; help: string }[] = [
  {
    value: 'toggle',
    label: 'Toggle',
    help: 'Members pick any combination. Picking an option again removes that role.',
  },
  {
    value: 'add_only',
    label: 'Add only',
    help: 'Options only grant. Taking a role away stays an operator job.',
  },
  {
    value: 'remove_only',
    label: 'Remove only',
    help: 'Options only remove roles the member already has.',
  },
  {
    value: 'single_choice',
    label: 'Single choice',
    help: 'One option at a time. Picking another option clears the previous one.',
  },
];

export const FORMATS: readonly { value: PanelComponent; label: string; help: string }[] = [
  {
    value: 'reaction',
    label: 'Emoji reactions',
    help: 'Members add an emoji reaction on the message to get the role, and remove their reaction to give it up. The classic reaction-role style; every option needs an emoji.',
  },
  {
    value: 'button',
    label: 'Buttons',
    help: 'One button per option under the message. Best for a handful of short labels.',
  },
  {
    value: 'select',
    label: 'Dropdown',
    help: 'A single dropdown menu. Best when there are many options or long labels.',
  },
];

export function BuilderBehaviour({
  isReaction,
  behaviour,
  format,
  setBehaviour,
  setFormat,
}: {
  isReaction: boolean;
  behaviour: PanelBehaviour;
  format: PanelComponent;
  setBehaviour: (value: PanelBehaviour) => void;
  setFormat: (value: PanelComponent) => void;
}) {
  return (
    <FormSection title="Behaviour">
      {!isReaction && (
        <RadioGroup
          legend="How members pick"
          name="panel-format"
          value={format}
          onChange={(value) => {
            if (value === 'button' || value === 'select') setFormat(value);
          }}
          options={FORMATS.filter((f) => f.value !== 'reaction').map((f) => ({
            ...f,
            hint: f.help,
          }))}
        />
      )}
      <RadioGroup
        legend="Behaviour"
        name="panel-behaviour"
        value={behaviour}
        onChange={(value) => {
          const found = BEHAVIOURS.find((b) => b.value === value);
          if (found) setBehaviour(found.value);
        }}
        options={BEHAVIOURS.filter((b) => !isReaction || b.value !== 'single_choice').map((b) => ({
          ...b,
          hint: b.help,
        }))}
      />
    </FormSection>
  );
}
