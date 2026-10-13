import type { OutgoingFile, OutgoingMessage } from '../../discord/port.js';
import type { ArtKey } from './art.js';
import { assertWithinBudget } from './budget.js';
import { IS_COMPONENTS_V2, container, type ContainerChild, type TopLevelComponent } from './kit.js';
import { TONE_ACCENT, type Tone } from './tokens.js';

/**
 * A card before art bytes are attached: what render functions return.
 * `toOutgoingMessage` (Task 2) turns it into a port `OutgoingMessage`.
 */
export interface CardMessage {
  readonly components: readonly TopLevelComponent[];
  /** Art the sender must attach; each is referenced as `attachment://<file>`. */
  readonly art: readonly ArtKey[];
  readonly allowedMentions: {
    readonly parse: readonly [] | readonly ['everyone'];
    readonly users?: readonly string[];
    readonly roles?: readonly string[];
  };
  readonly replyTo?: string;
}

const countPrimary = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countPrimary(v), 0);
  if (typeof value !== 'object' || value === null) return 0;
  const c = value as Record<string, unknown>;
  const own = c['type'] === 2 && c['style'] === 1 ? 1 : 0;
  return own + countPrimary(c['components']) + countPrimary(c['accessory']);
};

export const card = (options: {
  tone: Tone;
  children: readonly ContainerChild[];
  art?: readonly ArtKey[];
  pingUsers?: readonly string[];
  pingRoles?: readonly string[];
  pingEveryone?: boolean;
  replyTo?: string;
}): CardMessage => {
  const components = [container({ accent: TONE_ACCENT[options.tone], children: options.children })];
  assertWithinBudget(components);
  if (countPrimary(components) > 1) throw new RangeError('a card holds at most one primary button');
  const users = options.pingUsers ?? [];
  const roles = options.pingRoles ?? [];
  return {
    components,
    art: [...new Set(options.art ?? [])],
    allowedMentions: {
      parse: options.pingEveryone === true ? (['everyone'] as const) : ([] as const),
      ...(users.length > 0 ? { users: [...new Set(users)] } : {}),
      ...(roles.length > 0 ? { roles: [...new Set(roles)] } : {}),
    },
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
  };
};

/**
 * The port message for a card. `loadArt` supplies the bytes for each art
 * key; a card with art and no loader is a programming error, so it throws.
 */
export const toOutgoingMessage = (
  message: CardMessage,
  loadArt?: (key: ArtKey) => OutgoingFile,
): OutgoingMessage => {
  if (message.art.length > 0 && loadArt === undefined)
    throw new Error(`card needs art (${message.art.join(', ')}) but no art loader was given`);
  const files = loadArt === undefined ? [] : message.art.map((key) => loadArt(key));
  return {
    components: message.components,
    flags: IS_COMPONENTS_V2,
    allowedMentions: {
      parse: [...message.allowedMentions.parse],
      ...(message.allowedMentions.users === undefined
        ? {}
        : { users: [...message.allowedMentions.users] }),
      ...(message.allowedMentions.roles === undefined
        ? {}
        : { roles: [...message.allowedMentions.roles] }),
    },
    ...(files.length > 0 ? { files } : {}),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  };
};
