/**
 * Components V2 and modal wire shapes (ADR 0140).
 *
 * `core` may not import discord.js (ADR 0014), and this kit deliberately does
 * not take `discord-api-types` either: these are the ~15 shapes the project
 * uses, written with Discord's numeric `type` literals, the same style
 * `task/components.ts` already uses. Constructors only — no behaviour, no I/O.
 */

import { cutUnits, truncate } from './text.js';

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL_FLAG = 1 << 6;

export type ButtonStyleName = 'primary' | 'secondary' | 'success' | 'danger';
const BUTTON_STYLE: Readonly<Record<ButtonStyleName, 1 | 2 | 3 | 4>> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
};

export interface TextDisplay {
  readonly type: 10;
  readonly content: string;
}
export interface MediaRef {
  readonly url: string;
}
export interface Thumbnail {
  readonly type: 11;
  readonly media: MediaRef;
  readonly description?: string;
}
export interface Button {
  readonly type: 2;
  readonly style: 1 | 2 | 3 | 4;
  readonly custom_id: string;
  readonly label: string;
  readonly emoji?: { readonly name: string };
  readonly disabled?: boolean;
}
export interface LinkButton {
  readonly type: 2;
  readonly style: 5;
  readonly url: string;
  readonly label: string;
}
export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly emoji?: { readonly name: string };
  readonly default?: boolean;
}
export interface StringSelect {
  readonly type: 3;
  readonly custom_id: string;
  readonly placeholder?: string;
  readonly min_values?: number;
  readonly max_values?: number;
  readonly options: readonly SelectOption[];
}
export interface ActionRow {
  readonly type: 1;
  readonly components: readonly (Button | LinkButton | StringSelect)[];
}
export interface Section {
  readonly type: 9;
  readonly components: readonly TextDisplay[];
  readonly accessory: Thumbnail | Button | LinkButton;
}
export interface Separator {
  readonly type: 14;
  readonly divider: boolean;
  readonly spacing: 1 | 2;
}
export interface GalleryItem {
  readonly media: MediaRef;
  readonly description?: string;
}
export interface MediaGallery {
  readonly type: 12;
  readonly items: readonly GalleryItem[];
}
export type ContainerChild = TextDisplay | Section | Separator | MediaGallery | ActionRow;
export interface Container {
  readonly type: 17;
  readonly accent_color: number;
  readonly components: readonly ContainerChild[];
}
export type TopLevelComponent = Container | ContainerChild;

export const text = (content: string): TextDisplay => ({ type: 10, content });

export const thumbnail = (url: string, description?: string): Thumbnail =>
  description === undefined
    ? { type: 11, media: { url } }
    : { type: 11, media: { url }, description };

export const section = (
  texts: readonly TextDisplay[],
  accessory: Section['accessory'],
): Section => {
  if (texts.length < 1 || texts.length > 3)
    throw new RangeError('a section holds 1 to 3 text displays');
  return { type: 9, components: texts, accessory };
};

export const separator = (
  options: { divider?: boolean; spacing?: 'small' | 'large' } = {},
): Separator => ({
  type: 14,
  divider: options.divider ?? true,
  spacing: options.spacing === 'large' ? 2 : 1,
});

export const gallery = (items: readonly GalleryItem[]): MediaGallery => {
  if (items.length < 1 || items.length > 10)
    throw new RangeError('a media gallery holds 1 to 10 items');
  return { type: 12, items };
};

/** Discord's label limit: 34 characters beside an emoji, 38 without one. */
const assertButtonLabel = (label: string, hasEmoji: boolean): void => {
  const max = hasEmoji ? 34 : 38;
  if (label.length > max)
    throw new RangeError(`a button label holds at most ${max} characters; got ${label.length}`);
};

export const button = (options: {
  customId: string;
  label: string;
  style?: ButtonStyleName;
  emoji?: string;
  disabled?: boolean;
}): Button => {
  assertButtonLabel(options.label, options.emoji !== undefined);
  return {
    type: 2,
    style: BUTTON_STYLE[options.style ?? 'secondary'],
    custom_id: options.customId,
    label: options.label,
    ...(options.emoji === undefined ? {} : { emoji: { name: options.emoji } }),
    ...(options.disabled === true ? { disabled: true } : {}),
  };
};

export const linkButton = (options: { url: string; label: string }): LinkButton => {
  assertButtonLabel(options.label, false);
  return {
    type: 2,
    style: 5,
    url: options.url,
    label: options.label,
  };
};

export const actionRow = (buttons: readonly (Button | LinkButton)[]): ActionRow => {
  if (buttons.length < 1 || buttons.length > 5)
    throw new RangeError('an action row holds 1 to 5 buttons');
  return { type: 1, components: buttons };
};

export const stringSelect = (options: {
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options: readonly SelectOption[];
}): StringSelect => {
  if (options.options.length < 1 || options.options.length > 25)
    throw new RangeError('a select holds 1 to 25 options');
  return {
    type: 3,
    custom_id: options.customId,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.minValues === undefined ? {} : { min_values: options.minValues }),
    ...(options.maxValues === undefined ? {} : { max_values: options.maxValues }),
    options: options.options,
  };
};

export const selectRow = (select: StringSelect): ActionRow => ({ type: 1, components: [select] });

export const container = (options: {
  accent: number;
  children: readonly ContainerChild[];
}): Container => ({ type: 17, accent_color: options.accent, components: options.children });

// --- modals ------------------------------------------------------------------

export interface TextInput {
  readonly type: 4;
  readonly custom_id: string;
  readonly style: 1 | 2;
  readonly required: boolean;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly placeholder?: string;
  readonly value?: string;
}
export interface RadioOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly default?: boolean;
}
export interface RadioGroup {
  readonly type: 21;
  readonly custom_id: string;
  readonly required: boolean;
  readonly options: readonly RadioOption[];
}
export interface Label {
  readonly type: 18;
  readonly label: string;
  readonly description?: string;
  readonly component: TextInput | RadioGroup;
}
export interface Modal {
  readonly custom_id: string;
  readonly title: string;
  readonly components: readonly (Label | TextDisplay)[];
}

export const textInput = (options: {
  customId: string;
  style: 'short' | 'paragraph';
  required: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  value?: string;
}): TextInput => ({
  type: 4,
  custom_id: options.customId,
  style: options.style === 'paragraph' ? 2 : 1,
  required: options.required,
  ...(options.minLength === undefined ? {} : { min_length: options.minLength }),
  ...(options.maxLength === undefined ? {} : { max_length: options.maxLength }),
  ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  ...(options.value === undefined ? {} : { value: options.value }),
});

export const radioGroup = (options: {
  customId: string;
  required: boolean;
  options: readonly RadioOption[];
}): RadioGroup => ({
  type: 21,
  custom_id: options.customId,
  required: options.required,
  options: options.options,
});

export const label = (options: {
  label: string;
  description?: string;
  component: TextInput | RadioGroup;
}): Label => ({
  type: 18,
  label: cutUnits(options.label, 45),
  ...(options.description === undefined ? {} : { description: cutUnits(options.description, 100) }),
  component: options.component,
});

export const modal = (options: {
  customId: string;
  title: string;
  components: readonly (Label | TextDisplay)[];
}): Modal => ({
  custom_id: options.customId,
  title: truncate(options.title, 45),
  components: options.components,
});
